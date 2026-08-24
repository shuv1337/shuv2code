/**
 * Live shuvcode implementation of {@link AdeChatSessionPort} (spec
 * `docs/ade/ADE-V1-SPEC.md` §7 slice 1, §3.1, §4.3; issue #163).
 *
 * The design decision this file encodes: **an ADE bot chat is an ordinary
 * shuv2code thread.** Spec §7.1 says the captain surface reuses the existing
 * conversation component stack, and the cheapest honest way to get that is to
 * make the bot's primary-text session a normal thread on the shuvcode
 * (OpenCodeV2) provider. Everything ADE adds rides seams that already exist:
 *
 * - the tool catalog rides {@link ProviderDynamicToolsShape} and must be
 *   configured *before* the provider session is created, because that is the
 *   only path on which ownership `metadata` reaches upstream;
 * - the persona/memory/assignment projection rides
 *   {@link ProviderSyntheticInputShape} as a queued, non-waking item, so the
 *   captain's own first message is still the first thing they see and the bot
 *   does not answer a question nobody asked;
 * - the durable `BotExecutionBinding` is opened by `AdeSessionRollover`, which
 *   owns the "one active primary text session per bot" invariant (ADR §3.2).
 *
 * Thread identity is deterministic (`ade-bot-<botId>`): a bot's chat is a
 * durable place, restarts resolve to the same thread, and no extra mapping
 * table is needed to answer "which thread renders this bot".
 *
 * Ordering note on the two attaches: `attachShuvcodeThread` wants the *kernel
 * native* session id, which only exists after the session is created. So the
 * pre-session attach carries the thread id as a provisional stand-in (to get
 * the catalog + metadata onto `session.create`), and a second attach with the
 * same principal replaces it with the real id the moment it is known. Same
 * principal re-attach is explicitly allowed by the gate and fences the earlier
 * generation, and no tool can be invoked in between because no turn has
 * started yet.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AdeCaptainError,
  type AdeBotChatSession,
  type BotExecutionBindingId,
  type BotId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type KernelSessionId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@shuv2code/contracts";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderAdapterRegistry from "../provider/Services/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import { AdeChatSessionPort, type AdeChatSessionPortShape } from "./AdeChatSessionPort.ts";
import { AdeSessionRollover, renderSessionProjection } from "./AdeSessionRollover.ts";
import { AdeToolGate } from "./AdeToolGate.ts";

/** The shuvcode driver instance ADE binds text work to (spec §1). */
export const ADE_SHUVCODE_INSTANCE_ID = ProviderInstanceId.make("opencodeV2");

/** Deterministic thread identity for a bot's primary chat. */
export const adeBotThreadId = (botId: BotId): ThreadId => ThreadId.make(`ade-bot-${botId}`);

const unavailable = (message: string) =>
  new AdeCaptainError({ reason: "session_unavailable", message });

export class AdeShuvcodeChatSession extends Context.Service<
  AdeShuvcodeChatSession,
  AdeChatSessionPortShape
>()("shuv2code/ade/AdeShuvcodeChatSession") {
  /**
   * Live wiring. Exposed as an `AdeChatSessionPort` layer so the captain API
   * depends on the port, never on the provider runtime.
   */
  static readonly layer: Layer.Layer<
    AdeChatSessionPort,
    never,
    | SqlClient.SqlClient
    | AdeSessionRollover
    | AdeToolGate
    | OrchestrationEngine.OrchestrationEngineService
    | ProjectionSnapshotQuery.ProjectionSnapshotQuery
    | ProviderAdapterRegistry.ProviderAdapterRegistry
    | ProviderRegistry.ProviderRegistry
    | ProviderService.ProviderService
  > = Layer.effect(
    AdeChatSessionPort,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const rollover = yield* AdeSessionRollover;
      const gate = yield* AdeToolGate;
      const engine = yield* OrchestrationEngine.OrchestrationEngineService;
      const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
      const adapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
      const providers = yield* ProviderRegistry.ProviderRegistry;
      const sessions = yield* ProviderService.ProviderService;

      /** Any failure below is "no session for you", never a 500 on the roster. */
      const orUnavailable = <A, E>(label: string, effect: Effect.Effect<A, E>) =>
        Effect.mapError(effect, (cause: E) =>
          unavailable(
            `${label}: ${
              typeof cause === "object" && cause !== null && "message" in cause
                ? String((cause as { message: unknown }).message)
                : String(cause)
            }`,
          ),
        );

      const readActiveBinding = (botId: BotId) =>
        Effect.map(
          sql<{ binding_id: string; kernel_session_id: string }>`
            SELECT binding_id, kernel_session_id FROM ade_bot_execution_bindings
            WHERE bot_id = ${botId} AND purpose = 'primary-text'
              AND status = 'active' AND engine = 'shuvcode'
          `,
          (rows) => rows[0] ?? null,
        );

      const readBotName = (botId: BotId) =>
        Effect.map(
          sql<{ name: string }>`SELECT name FROM ade_bots WHERE bot_id = ${botId}`,
          (rows) => rows[0]?.name ?? "bot",
        );

      /**
       * The shuv2code project a bot's thread lives in. V1 is single-operator
       * and additive (spec §1): rather than inventing an ADE-only project, the
       * chat rides whichever project already exists. `ade_projects.repo_path`
       * wins when it names one, so a bot with a bound repo chats in that repo.
       */
      const resolveProject = Effect.fn("AdeShuvcodeChatSession.resolveProject")(function* (
        botId: BotId,
      ) {
        const shell = yield* orUnavailable("read projects", snapshots.getShellSnapshot());
        if (shell.projects.length === 0) {
          return yield* unavailable(
            "No project exists yet. Create your first project, then start the chat.",
          );
        }
        const repoRows = yield* orUnavailable(
          "read bot project",
          sql<{ repo_path: string | null }>`
            SELECT p.repo_path AS repo_path FROM ade_bots b
            LEFT JOIN ade_projects p ON p.project_id = b.project_id
            WHERE b.bot_id = ${botId}
          `,
        );
        const repoPath = repoRows[0]?.repo_path ?? null;
        const matched =
          repoPath === null
            ? undefined
            : shell.projects.find((project) => project.workspaceRoot === repoPath);
        const project = matched ?? shell.projects[0];
        if (project === undefined) {
          return yield* unavailable("No project exists yet.");
        }
        return project;
      });

      /**
       * shuvcode's model catalog is provider-authoritative and instance-scoped;
       * the project's default only applies when it already points at shuvcode
       * (a Codex default must not leak into an ADE session, spec §1).
       */
      const resolveModelSelection = Effect.fn("AdeShuvcodeChatSession.resolveModelSelection")(
        function* (projectDefault: ModelSelection | null | undefined) {
          if (projectDefault?.instanceId === ADE_SHUVCODE_INSTANCE_ID) return projectDefault;
          const snapshot = yield* providers.getProviders;
          const instance = snapshot.find(
            (provider) => provider.instanceId === ADE_SHUVCODE_INSTANCE_ID,
          );
          const model = instance?.models[0];
          if (instance === undefined || model === undefined) {
            return yield* unavailable(
              "The shuvcode kernel reports no models. Start `shuvcode service start` and retry.",
            );
          }
          return {
            instanceId: ADE_SHUVCODE_INSTANCE_ID,
            model: model.slug,
          } satisfies ModelSelection;
        },
      );

      const startPrimaryChat: AdeChatSessionPortShape["startPrimaryChat"] = Effect.fn(
        "AdeShuvcodeChatSession.startPrimaryChat",
      )(function* (botId: BotId) {
        const threadId = adeBotThreadId(botId);
        const principal = { botId, purpose: "primary-text" } as const;

        const adapter = yield* orUnavailable(
          "resolve shuvcode adapter",
          adapters.getByInstance(ADE_SHUVCODE_INSTANCE_ID),
        );
        const seam = adapter.dynamicTools;
        if (seam === undefined) {
          return yield* unavailable(
            "The shuvcode adapter in this build has no dynamic-tool seam; ADE cannot attach its tool gate.",
          );
        }

        const attachGate = (sessionId: KernelSessionId) =>
          gate.attachShuvcodeThread(seam, { threadId, sessionId, principal });

        const existing = yield* orUnavailable("read bindings", readActiveBinding(botId));
        if (existing !== null) {
          const sessionId = existing.kernel_session_id as KernelSessionId;
          // The binding is durable but the gate's thread→principal map and the
          // seam's tool config are both process-local. After a restart they are
          // empty, so returning here without re-attaching would hand back a
          // session that ships no tool catalog and whose calls the gate cannot
          // attribute. Re-attaching is idempotent: on a live session it
          // replace-sets the catalog and drains pending calls; on a session
          // this process has not rebuilt yet it records the config so the
          // catalog rides the next session creation.
          const reattached = yield* Effect.exit(attachGate(sessionId));
          if (reattached._tag === "Success") {
            return {
              botId,
              threadId,
              engine: "shuvcode",
              bindingId: existing.binding_id as BotExecutionBindingId,
              sessionId,
              startedNow: false,
            } satisfies AdeBotChatSession;
          }
          // Upstream refused: the recorded session is gone. Retire the binding
          // as `lost` (never silently reused, ADR §16) and fall through to a
          // fresh start below.
          yield* Effect.logWarning("ADE primary session could not be re-attached; retiring it", {
            botId,
            sessionId,
          });
          yield* Effect.ignore(
            rollover.closeBinding({
              bindingId: existing.binding_id as BotExecutionBindingId,
              status: "lost",
            }),
          );
        }

        const project = yield* resolveProject(botId);
        const modelSelection = yield* resolveModelSelection(project.defaultModelSelection);
        const botName = yield* orUnavailable("read bot", readBotName(botId));

        // Create the thread only once; a bot's chat is a durable place.
        const shell = yield* orUnavailable("read threads", snapshots.getShellSnapshot());
        const threadExists = shell.threads.some((thread) => thread.id === threadId);
        if (!threadExists) {
          const createdAt = DateTime.formatIso(yield* DateTime.now);
          // Deterministic: thread creation for a bot is a once-ever act, and
          // orchestration dedupes by command receipt, so a racing retry is a
          // no-op instead of a second thread.
          const commandId = CommandId.make(`ade-bot-thread-create:${botId}`);
          yield* orUnavailable(
            "create thread",
            engine.dispatch({
              type: "thread.create",
              commandId,
              threadId,
              projectId: ProjectId.make(project.id),
              title: `ADE · ${botName}`,
              modelSelection,
              runtimeMode: "full-access",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              branch: null,
              worktreePath: project.workspaceRoot,
              createdAt,
            }),
          );
        }

        // Provisional id: the catalog and ownership metadata must ride
        // `session.create`, which happens below.
        yield* orUnavailable(
          "attach tool catalog",
          attachGate(threadId as unknown as KernelSessionId),
        );

        const session = yield* orUnavailable(
          "start shuvcode session",
          sessions.startSession(threadId, {
            threadId,
            providerInstanceId: ADE_SHUVCODE_INSTANCE_ID,
            cwd: project.workspaceRoot,
            title: `ADE · ${botName}`,
            modelSelection,
            runtimeMode: "full-access",
            threadSource: "ade",
          }),
        );
        const kernelSessionId = session.providerThreadId;
        if (kernelSessionId === undefined) {
          return yield* unavailable(
            "shuvcode started a session without reporting its native session id.",
          );
        }

        // Re-attach with the real kernel session id so S7/S8 binding lookups
        // (and every dispatched tool context) name the session ADE recorded.
        yield* orUnavailable("rebind tool catalog", attachGate(kernelSessionId as KernelSessionId));

        const primary = yield* Effect.catch(
          rollover.startPrimarySession({
            botId,
            engine: "shuvcode",
            sessionId: kernelSessionId as KernelSessionId,
          }),
          (cause) =>
            // A racing caller already opened the primary binding: adopt it
            // rather than rolling anything over (ADR §12.3).
            cause._tag === "AdePrimarySessionActiveError" ||
            cause._tag === "AdeSessionBindingConflictError"
              ? Effect.succeed(null)
              : Effect.fail(unavailable(`open binding: ${cause.message}`)),
        );

        if (primary === null) {
          const adopted = yield* orUnavailable("read bindings", readActiveBinding(botId));
          if (adopted === null) {
            return yield* unavailable("The bot's primary session could not be opened.");
          }
          return {
            botId,
            threadId,
            engine: "shuvcode",
            bindingId: adopted.binding_id as BotExecutionBindingId,
            sessionId: adopted.kernel_session_id as KernelSessionId,
            startedNow: false,
          } satisfies AdeBotChatSession;
        }

        // Persona + memory + active assignments + outgoing summary.
        //
        // `resume: false` is the load-bearing flag: admitting an item normally
        // *wakes* an idle session and starts a turn, which here would mean the
        // bot delivers an unprompted monologue about its own persona before
        // the captain has typed anything. The projection is context the model
        // should simply have on its next run, not a prompt — so it is admitted
        // without waking. (Result delivery and steering want the opposite and
        // keep the waking default.)
        //
        // Best-effort: a session without its projection is degraded, not
        // broken, and the captain must still be able to talk to the bot.
        const synthetic = adapter.syntheticInput;
        if (synthetic !== undefined) {
          yield* synthetic
            .inject({
              threadId,
              text: renderSessionProjection(primary.projection),
              description: "ADE session context",
              delivery: "follow-up",
              resume: false,
            })
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("ADE session projection injection failed", { cause }),
              ),
            );
        }

        return {
          botId,
          threadId,
          engine: "shuvcode",
          bindingId: primary.binding.id,
          sessionId: primary.binding.sessionId,
          startedNow: true,
        } satisfies AdeBotChatSession;
      });

      return AdeChatSessionPort.of({ startPrimaryChat });
    }),
  );
}
