// @effect-diagnostics nodeBuiltinImport:off
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
import * as NodeCrypto from "node:crypto";

import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OrchestrationShellSnapshot, ServerProvider } from "@shuv2code/contracts";
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
import { isOpenCodeV2SessionNotFound } from "../provider/opencodeV2Client.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import { AdeChatSessionPort, type AdeChatSessionPortShape } from "./AdeChatSessionPort.ts";
import { AdeSessionRollover, renderSessionProjection } from "./AdeSessionRollover.ts";
import { AdeToolGate } from "./AdeToolGate.ts";

/** The shuvcode driver instance ADE binds text work to (spec §1). */
export const ADE_SHUVCODE_INSTANCE_ID = ProviderInstanceId.make("opencodeV2");

/** Deterministic thread identity for a bot's primary chat. */
export const adeBotThreadId = (botId: BotId): ThreadId => ThreadId.make(`ade-bot-${botId}`);

/** One workspace project as the orchestration shell snapshot reports it. */
type ShellProject = OrchestrationShellSnapshot["projects"][number];

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
    | WorkspacePaths
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
      const workspacePaths = yield* WorkspacePaths;

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
       * shuvcode's model catalog is provider-authoritative and instance-scoped;
       * the project's default only applies when it already points at shuvcode
       * (a Codex default must not leak into an ADE session, spec §1).
       *
       * The snapshot is a *cache*, filled by the provider status probe. On a
       * cold boot — or right after the captain adds the instance — it is
       * legitimately empty while the kernel is perfectly healthy, so an empty
       * catalog triggers a refresh before it is believed. When it is still
       * empty afterwards the provider's own probe message is what the captain
       * needs (e.g. "Failed to execute 'opencode --version'"), not a generic
       * "no models" that names the wrong problem.
       */
      const resolveModelSelection = Effect.fn("AdeShuvcodeChatSession.resolveModelSelection")(
        function* (projectDefault: ModelSelection | null | undefined) {
          if (projectDefault?.instanceId === ADE_SHUVCODE_INSTANCE_ID) return projectDefault;

          const findInstance = (snapshot: ReadonlyArray<ServerProvider>) =>
            snapshot.find((provider) => provider.instanceId === ADE_SHUVCODE_INSTANCE_ID);

          let instance = findInstance(yield* providers.getProviders);
          if (instance === undefined || instance.models.length === 0) {
            instance = findInstance(yield* providers.refreshInstance(ADE_SHUVCODE_INSTANCE_ID));
          }

          if (instance === undefined) {
            return yield* unavailable(
              "No 'opencode2' provider instance is configured. Add one in Settings → Providers, then start the chat again.",
            );
          }
          const model = instance.models[0];
          if (model === undefined) {
            const detail = instance.message ?? instance.unavailableReason ?? null;
            return yield* unavailable(
              `The opencode2 provider reports no models${detail === null ? "" : ` (${detail})`}. ` +
                "Check Settings → Providers — the binary path must point at your shuvcode CLI and `shuvcode service start` must be running.",
            );
          }
          return {
            instanceId: ADE_SHUVCODE_INSTANCE_ID,
            model: model.slug,
          } satisfies ModelSelection;
        },
      );

      /**
       * The shuv2code workspace project a bot's thread lives in.
       *
       * ADE projects and workspace projects are different things: the ADE
       * project owns the crew, the workspace project owns the repo a thread
       * runs against. A bot whose ADE project names a `repo_path` should chat
       * in that repo, so if no workspace project covers it yet, one is created
       * — otherwise a captain who just used the Fleet CTA to make an ADE
       * project with a repo would still be told "no project exists", which is
       * both false and unactionable.
       */
      const resolveProject = Effect.fn("AdeShuvcodeChatSession.resolveProject")(function* (
        botId: BotId,
      ) {
        const repoRows = yield* orUnavailable(
          "read bot project",
          sql<{ repo_path: string | null; name: string | null }>`
            SELECT p.repo_path AS repo_path, p.name AS name FROM ade_bots b
            LEFT JOIN ade_projects p ON p.project_id = b.project_id
            WHERE b.bot_id = ${botId}
          `,
        );
        // Coordinators are deliberately fleet-wide (no `project_id`), so they
        // have no repo of their own. They still have to run somewhere, and the
        // fleet's own first bound project is the least surprising answer —
        // otherwise the Firstmate, the one bot that always exists, is the one
        // bot that can never chat.
        const fallbackRows =
          repoRows[0]?.repo_path != null
            ? []
            : yield* orUnavailable(
                "read fleet projects",
                sql<{ repo_path: string | null; name: string | null }>`
                  SELECT repo_path, name FROM ade_projects
                  WHERE repo_path IS NOT NULL
                  ORDER BY created_at
                  LIMIT 1
                `,
              );
        const home = repoRows[0]?.repo_path != null ? repoRows[0] : fallbackRows[0];
        const repoPath = home?.repo_path ?? null;

        // Both sides of this comparison must be normalized. `ade_projects`
        // stores whatever the captain typed (`~/repo`, a trailing slash, a
        // relative path) while workspace projects store the resolved root, so
        // comparing raw strings never matches — and a miss here re-dispatches
        // `project.create`, which the command receipt then rejects. That is
        // what turned "chat works once" into a permanent refusal.
        const normalizedRepoPath =
          repoPath === null
            ? null
            : yield* Effect.orElseSucceed(
                workspacePaths.normalizeWorkspaceRoot(repoPath),
                () => repoPath,
              );

        const findInShell = (projects: ReadonlyArray<ShellProject>) =>
          normalizedRepoPath === null
            ? projects[0]
            : projects.find((project) => project.workspaceRoot === normalizedRepoPath);

        const shell = yield* orUnavailable("read projects", snapshots.getShellSnapshot());
        const existing = findInShell(shell.projects);
        if (existing !== undefined) return existing;

        if (normalizedRepoPath === null) {
          return yield* unavailable(
            "This bot has no project. Create one from the Fleet page, then start the chat.",
          );
        }

        // Hash the normalized path: two long paths sharing a prefix collide
        // once the id is truncated, and a colliding project id silently points
        // two repos at one workspace.
        const projectId = ProjectId.make(
          `ade-project-${NodeCrypto.createHash("sha256").update(normalizedRepoPath).digest("hex").slice(0, 32)}`,
        );
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const modelSelection = yield* resolveModelSelection(null);
        const created = yield* Effect.exit(
          engine.dispatch({
            type: "project.create",
            commandId: CommandId.make(`ade-workspace-project:${projectId}`),
            projectId,
            title: home?.name ?? "ADE project",
            workspaceRoot: normalizedRepoPath,
            defaultModelSelection: modelSelection,
            createdAt,
          }),
        );
        if (created._tag === "Failure") {
          // Success-by-lookup. The receipt hash covers `createdAt` and the
          // model selection, so an identical-in-spirit retry is *rejected*
          // rather than deduped; a concurrent starter may also have won the
          // race. Either way, what matters is whether the project now exists.
          const after = yield* orUnavailable("read projects", snapshots.getShellSnapshot());
          const settled =
            findInShell(after.projects) ?? after.projects.find((p) => p.id === projectId);
          if (settled === undefined) {
            return yield* unavailable(
              `The workspace project for '${normalizedRepoPath}' could not be created.`,
            );
          }
          return settled;
        }
        return {
          id: projectId,
          workspaceRoot: normalizedRepoPath,
          defaultModelSelection: modelSelection,
        };
      });

      const startPrimaryChat: AdeChatSessionPortShape["startPrimaryChat"] = Effect.fn(
        "AdeShuvcodeChatSession.startPrimaryChat",
      )(function* (botId: BotId) {
        const threadId = adeBotThreadId(botId);
        const principal = { botId, purpose: "primary-text" } as const;

        // A fresh install has no `opencode2` instance at all, and the raw
        // registry error ("Provider 'opencodeV2' is not implemented") names an
        // internal id rather than the thing the captain has to do. §4.1 keeps
        // the app navigable while degraded, but degraded must still be
        // actionable.
        const adapter = yield* Effect.mapError(
          adapters.getByInstance(ADE_SHUVCODE_INSTANCE_ID),
          () =>
            unavailable(
              "No 'opencode2' provider instance is configured. Add one in Settings → Providers " +
                "(point Binary path at your shuvcode CLI), then start the chat again.",
            ),
        );
        const seam = adapter.dynamicTools;
        if (seam === undefined) {
          return yield* unavailable(
            "The shuvcode adapter in this build has no dynamic-tool seam; ADE cannot attach its tool gate.",
          );
        }

        const attachGate = (sessionId: KernelSessionId) =>
          gate.attachShuvcodeThread(seam, { threadId, sessionId, principal });

        /**
         * Are the fleet tools actually registered on this session?
         *
         * The only honest answer is the provider-authoritative list. Treating
         * a successful `configureThread` as proof is wrong twice over: it
         * succeeds after purely local writes when no session is live (so every
         * restart would claim tools it never pushed), and a call that
         * succeeded but registered nothing still leaves the bot unable to
         * delegate. An empty catalog is a negative result, not a pass.
         */
        const probeToolsAttached = Effect.gen(function* () {
          const listed = yield* Effect.exit(seam.listTools(threadId));
          if (listed._tag === "Failure") return false;
          if (listed.value.length > 0) return true;
          yield* Effect.logWarning(
            "ADE fleet tools are not registered on this session; the kernel accepted the request but the catalog is empty",
            { botId, threadId },
          );
          return false;
        });

        /**
         * A failed catalog write has two very different causes that both
         * surface as 404, and conflating them makes a fleet either unopenable
         * or unable to self-heal: the *route* can be missing (kernel build
         * without the dynamic-tool extension — the session is fine, keep the
         * binding) or the *session* can be gone (kernel restarted — the
         * binding is stale and must be retired). Upstream tags the second one,
         * which is the only reliable way to tell them apart.
         */
        const sessionGone = (cause: unknown) => isOpenCodeV2SessionNotFound(cause);

        const existing = yield* orUnavailable("read bindings", readActiveBinding(botId));
        if (existing !== null) {
          const bindingId = existing.binding_id as BotExecutionBindingId;
          const sessionId = existing.kernel_session_id as KernelSessionId;

          // Attribution first, and locally: the gate must know
          // thread -> {bot, session} before anything can be dispatched, and
          // that must not depend on the provider accepting a catalog write.
          yield* orUnavailable(
            "rebind tool gate",
            gate.rebindShuvcodeSession({ threadId, sessionId, principal }),
          );

          const refreshed = yield* Effect.exit(attachGate(sessionId));
          if (refreshed._tag === "Failure" && sessionGone(Cause.squash(refreshed.cause))) {
            // The kernel no longer holds this session: the binding is stale.
            // Retire it (never silently reused, ADR §16) and fall through to a
            // fresh start, which is what makes a kernel restart self-heal.
            yield* Effect.logWarning(
              "ADE primary session is gone from the kernel; retiring the binding and starting a fresh one",
              { botId, sessionId },
            );
            yield* Effect.ignore(rollover.closeBinding({ bindingId, status: "lost" }));
          } else {
            const toolsAttached = yield* probeToolsAttached;
            if (!toolsAttached) {
              yield* Effect.logWarning(
                "ADE fleet tools are unavailable on an existing session; chat continues without delegation",
                { botId, sessionId },
              );
            }
            return {
              botId,
              threadId,
              engine: "shuvcode",
              bindingId,
              sessionId,
              startedNow: false,
              toolsAttached,
            } satisfies AdeBotChatSession;
          }
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
        //
        // Best effort, not fatal. This normally only stores the catalog
        // locally, but when this process already holds a live session for the
        // thread it becomes a live `PUT /session/:id/tools` — which a kernel
        // build without the dynamic-tool routes rejects. Refusing to open the
        // chat over that would mean a captain whose kernel lacks the extension
        // can never talk to their fleet at all; the honest outcome is a
        // working conversation with delegation reported as unavailable.
        const preAttach = yield* Effect.exit(attachGate(threadId as unknown as KernelSessionId));
        if (preAttach._tag === "Failure") {
          yield* Effect.logWarning(
            "ADE tool catalog could not be configured before session creation; continuing without fleet tools",
            { botId },
          );
        }

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

        // Record the real kernel session id so S7/S8 binding lookups (and
        // every dispatched tool context) name the session ADE recorded. This
        // is deliberately the *local* rebind: the catalog already rode
        // `session.create`, so re-pushing it would be a redundant live
        // `PUT /session/:id/tools` — which is fatal on a kernel build that
        // does not carry the dynamic-tool routes.
        yield* orUnavailable(
          "rebind tool gate",
          gate.rebindShuvcodeSession({
            threadId,
            sessionId: kernelSessionId as KernelSessionId,
            principal,
          }),
        );

        // Did the catalog actually take? Tools ride `session.create`, but a
        // kernel build without the dynamic-tool routes accepts the create and
        // silently drops them — and a bot that cannot delegate while the UI
        // implies it can is worse than one that says so.
        const toolsAttached = yield* probeToolsAttached;

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
          const adoptedBindingId = adopted.binding_id as BotExecutionBindingId;
          // The adapter just re-minted a session for this thread, so the
          // surviving binding may still name the old kernel id. Leaving it
          // stale strands every S7 delivery and S8 lookup on a session that no
          // longer exists, so the row follows the kernel.
          const rebound = yield* Effect.exit(
            rollover.rebindKernelSession({
              bindingId: adoptedBindingId,
              sessionId: kernelSessionId as KernelSessionId,
            }),
          );
          if (rebound._tag === "Failure") {
            yield* Effect.logWarning("ADE binding could not adopt the re-minted kernel session", {
              botId,
              bindingId: adoptedBindingId,
            });
          }
          yield* orUnavailable(
            "rebind tool gate",
            gate.rebindShuvcodeSession({
              threadId,
              sessionId: (rebound._tag === "Success"
                ? rebound.value.sessionId
                : adopted.kernel_session_id) as KernelSessionId,
              principal,
            }),
          );
          return {
            botId,
            threadId,
            engine: "shuvcode",
            bindingId: adoptedBindingId,
            sessionId: (rebound._tag === "Success"
              ? rebound.value.sessionId
              : adopted.kernel_session_id) as KernelSessionId,
            startedNow: false,
            toolsAttached,
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
          toolsAttached,
        } satisfies AdeBotChatSession;
      });

      return AdeChatSessionPort.of({ startPrimaryChat });
    }),
  );
}
