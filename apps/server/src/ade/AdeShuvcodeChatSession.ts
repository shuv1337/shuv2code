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
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { OrchestrationShellSnapshot, ServerProvider } from "@shuv2code/contracts";
import {
  AdeCaptainError,
  type AdeBotChatSession,
  type AdeModelHealth,
  type AdeToolProbe,
  type BotExecutionBindingId,
  type BotId,
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type KernelSessionId,
  type ModelSelection,
  ProjectId,
  ProviderInstanceId,
  type ServerProviderModel,
  ThreadId,
} from "@shuv2code/contracts";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderAdapterRegistry from "../provider/Services/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import { isOpenCodeV2SessionNotFound } from "../provider/opencodeV2Client.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import { isAgentCapableModel } from "@shuv2code/shared/model";

import { AdeChatSessionPort, type AdeChatSessionPortShape } from "./AdeChatSessionPort.ts";
import { AdeSessionRollover, renderSessionProjection } from "./AdeSessionRollover.ts";
import { adeModelHealthTracker } from "./adeModelHealth.ts";
import { AdeToolGate } from "./AdeToolGate.ts";

/** The shuvcode driver instance ADE binds text work to (spec §1). */
export const ADE_SHUVCODE_INSTANCE_ID = ProviderInstanceId.make("opencodeV2");

/** Deterministic thread identity for a bot's primary chat. */
export const adeBotThreadId = (botId: BotId): ThreadId => ThreadId.make(`ade-bot-${botId}`);

/** One workspace project as the orchestration shell snapshot reports it. */
type ShellProject = OrchestrationShellSnapshot["projects"][number];

const unavailable = (message: string) =>
  new AdeCaptainError({ reason: "session_unavailable", message });

/**
 * The kernel answered with a catalog and nothing in it can run a bot. Not
 * `session_unavailable`: nothing is down, the configuration is wrong.
 */
const modelNotCapable = (message: string) =>
  new AdeCaptainError({ reason: "model_not_agent_capable", message });

/** Which rung of the ladder produced a bot's model. */
export type AdeModelSource = "pinned" | "project-default" | "kernel-default" | "first-capable";

export type AdeModelResolution =
  | {
      readonly kind: "resolved";
      readonly slug: string;
      readonly source: AdeModelSource;
      /**
       * False only when the catalog entry actively reports that it cannot do
       * this. A slug the catalog does not know at all is `true` — unreported.
       */
      readonly agentCapable: boolean;
    }
  | { readonly kind: "none-capable" };

const shuvcodeSlug = (selection: ModelSelection | null | undefined): string | null =>
  selection?.instanceId === ADE_SHUVCODE_INSTANCE_ID ? selection.model : null;

/**
 * Which shuvcode model should this bot run on? Pure, because the ordering is
 * the whole fix and it must be readable and testable without a provider.
 *
 * The rungs, first hit wins:
 *
 * 1. **The captain's explicit pin.** Never vetoed on capabilities: the data is
 *    provider-reported and can be stale or absent for a model the captain
 *    knows works, and refusing would turn a deliberate choice into a dead end
 *    with no override anywhere in the product. It is flagged instead.
 * 2. **The project default**, only when it already points at shuvcode *and*
 *    resolves to a capable catalog entry. It is a default, not a choice, and
 *    the rows that produced this bug were exactly a default naming a model
 *    that cannot call tools.
 * 3. **The kernel's own `model:`**, which arrives as `isDefault`. Also
 *    advisory — when the operator configured nothing the kernel answers with
 *    its newest model, which is how an *image* model became a bot's brain.
 * 4. **The first capable model.** A filtered first, never `models[0]`.
 *
 * There is no fifth rung. Picking something arbitrary is what this replaces.
 */
export function resolveAdeModelSelection(input: {
  readonly pinned: ModelSelection | null | undefined;
  readonly projectDefault: ModelSelection | null | undefined;
  readonly models: ReadonlyArray<ServerProviderModel>;
}): AdeModelResolution {
  const capable = (slug: string): boolean => {
    const model = input.models.find((candidate) => candidate.slug === slug);
    return model === undefined || isAgentCapableModel(model);
  };
  const known = (slug: string): boolean =>
    input.models.some((candidate) => candidate.slug === slug);

  const pinned = shuvcodeSlug(input.pinned);
  if (pinned !== null) {
    return { kind: "resolved", slug: pinned, source: "pinned", agentCapable: capable(pinned) };
  }

  const projectDefault = shuvcodeSlug(input.projectDefault);
  if (projectDefault !== null && known(projectDefault) && capable(projectDefault)) {
    return {
      kind: "resolved",
      slug: projectDefault,
      source: "project-default",
      agentCapable: true,
    };
  }

  const kernelDefault = input.models.find((model) => model.isDefault === true);
  if (kernelDefault !== undefined && isAgentCapableModel(kernelDefault)) {
    return {
      kind: "resolved",
      slug: kernelDefault.slug,
      source: "kernel-default",
      agentCapable: true,
    };
  }

  const first = input.models.find(isAgentCapableModel);
  if (first !== undefined) {
    return { kind: "resolved", slug: first.slug, source: "first-capable", agentCapable: true };
  }
  return { kind: "none-capable" };
}

/**
 * Did this call fail *inside the adapter*, before any kernel round-trip?
 *
 * The seam guards every provider-authoritative call with an in-process session
 * lookup, and a process that just booted has an empty map even though the
 * kernel session named by the durable binding is perfectly alive. That failure
 * says nothing about the kernel, so it must never be read as an answer (#199).
 * Matched by tag rather than `instanceof` because the seam is free to wrap the
 * error on its way out.
 */
const adapterSessionMissing = (cause: unknown): boolean => {
  let current: unknown = cause;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const record = current as { readonly _tag?: unknown; readonly cause?: unknown };
    if (record._tag === "ProviderAdapterSessionNotFoundError") return true;
    current = record.cause;
  }
  return false;
};

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
       * a project's or a bot's selection only applies when it already points at
       * shuvcode (a Codex default must not leak into an ADE session, spec §1).
       *
       * The snapshot is a *cache*, filled by the provider status probe. On a
       * cold boot — or right after the captain adds the instance — it is
       * legitimately empty while the kernel is perfectly healthy, so an empty
       * catalog triggers a refresh before it is believed. When it is still
       * empty afterwards the provider's own probe message is what the captain
       * needs (e.g. "Failed to execute 'opencode --version'"), not a generic
       * "no models" that names the wrong problem.
       *
       * The ordering itself lives in {@link resolveAdeModelSelection}; this
       * wrapper only supplies the catalog and turns the two ways it can end
       * badly into the error that names the right problem.
       */
      const resolveModelSelection = Effect.fn("AdeShuvcodeChatSession.resolveModelSelection")(
        function* (input: {
          readonly pinned: ModelSelection | null | undefined;
          readonly projectDefault: ModelSelection | null | undefined;
        }) {
          const findInstance = (snapshot: ReadonlyArray<ServerProvider>) =>
            snapshot.find((provider) => provider.instanceId === ADE_SHUVCODE_INSTANCE_ID);

          let instance = findInstance(yield* providers.getProviders);
          if (instance === undefined || instance.models.length === 0) {
            instance = findInstance(yield* providers.refreshInstance(ADE_SHUVCODE_INSTANCE_ID));
          }

          const models = instance?.models ?? [];
          const resolution = resolveAdeModelSelection({ ...input, models });
          if (resolution.kind === "resolved") {
            const modelHealth: AdeModelHealth = resolution.agentCapable ? "ok" : "unreported-tools";
            if (!resolution.agentCapable) {
              yield* Effect.logWarning(
                "ADE bot is pinned to a model that does not report tool calling; starting it anyway",
                { slug: resolution.slug, reason: "pinned-model-not-agent-capable" },
              );
            }
            return {
              modelSelection: {
                instanceId: ADE_SHUVCODE_INSTANCE_ID,
                model: resolution.slug,
              } satisfies ModelSelection,
              modelHealth,
            };
          }

          if (instance === undefined) {
            return yield* unavailable(
              "No 'opencode2' provider instance is configured. Add one in Settings → Providers, then start the chat again.",
            );
          }
          if (models.length === 0) {
            const detail = instance.message ?? instance.unavailableReason ?? null;
            return yield* unavailable(
              `The opencode2 provider reports no models${detail === null ? "" : ` (${detail})`}. ` +
                "Check Settings → Providers — the binary path must point at your shuvcode CLI and `shuvcode service start` must be running.",
            );
          }
          // A catalog full of models none of which can call tools and answer in
          // text. Silently taking the first one is what put an image model on a
          // bot and produced turns that failed with nothing to read.
          return yield* modelNotCapable(
            `The shuvcode kernel offers ${models.length} model${models.length === 1 ? "" : "s"} and none of them report tool calling and text output. ` +
              'Set "model" in your opencode.json to a tool-capable model (for example an openai/gpt-* or anthropic/claude-* entry), ' +
              "restart `shuvcode service`, then reopen this conversation.",
          );
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
          /*
           * #212. The old copy said "This bot has no project. Create one from
           * the Fleet page" — which was false in the case that actually
           * produces it: a project *does* exist, it just has no repository, and
           * creating a second one changes nothing. The repo-less state can only
           * come from a project created before the CTA required a path, and
           * nothing in the app binds a repo after the fact, so the honest
           * remedy is to create a project with one.
           */
          // Read the *bot's own* project row, not `home` — `home` is null in
          // exactly this branch, because it only resolves once a repo path
          // exists. That is why the old copy could not tell the two cases
          // apart in the first place.
          const homeProjectName = repoRows[0]?.name ?? null;
          return yield* unavailable(
            homeProjectName === null
              ? "This bot has no project. Create one with a repository path from the Fleet page, then start the chat."
              : `Project '${homeProjectName}' has no repository path, so this bot has nowhere to run. Create a project bound to a repository, then start the chat.`,
          );
        }

        // Hash the normalized path: two long paths sharing a prefix collide
        // once the id is truncated, and a colliding project id silently points
        // two repos at one workspace.
        const projectId = ProjectId.make(
          `ade-project-${NodeCrypto.createHash("sha256").update(normalizedRepoPath).digest("hex").slice(0, 32)}`,
        );
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        const { modelSelection } = yield* resolveModelSelection({
          pinned: null,
          projectDefault: null,
        });
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

      /**
       * One start at a time per bot thread.
       *
       * Nothing else serializes this path — `ProviderService`'s lane only
       * wraps `sendTurn` — so a captain pressing "Start chat" while
       * `AdeAssignmentRunner` briefs the same bot would have both callers run
       * the ensure-session section. The second `sessions.set` inside the
       * adapter orphans the first event pump (never closed): two pumps then
       * feed the dynamic-tool signal queue and the dispatch loop double-forks
       * every call id. The winner starts; the loser waits and re-reads, which
       * — with the `hasSession` gate below — makes it a probe-only pass that
       * returns the same answer.
       */
      const startLocks = new Map<ThreadId, Semaphore.Semaphore>();
      const startLockFor = (threadId: ThreadId): Semaphore.Semaphore => {
        const existing = startLocks.get(threadId);
        if (existing !== undefined) return existing;
        const created = Semaphore.makeUnsafe(1);
        startLocks.set(threadId, created);
        return created;
      };

      const startPrimaryChatUnlocked = Effect.fn("AdeShuvcodeChatSession.startPrimaryChat")(
        function* (botId: BotId) {
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
           *
           * The answer is deliberately tri-state (#199). A failure that never
           * reached the kernel — the adapter has no in-process session for this
           * thread — is not evidence about the catalog at all, and reporting it
           * as "missing" is what pinned a permanent "fleet tools unavailable"
           * banner on every bot after a server restart. That case is `unknown`:
           * say nothing and ask again on the next start.
           */
          const probeTools: Effect.Effect<AdeToolProbe> = Effect.gen(function* () {
            const listed = yield* Effect.exit(seam.listTools(threadId));
            if (listed._tag === "Failure") {
              if (adapterSessionMissing(Cause.squash(listed.cause))) {
                yield* Effect.logDebug(
                  "ADE tool probe could not reach the kernel: no in-process session for this thread",
                  { botId, threadId },
                );
                return "unknown";
              }
              return "missing";
            }
            if (listed.value.length > 0) return "attached";
            yield* Effect.logWarning(
              "ADE fleet tools are not registered on this session; the kernel accepted the request but the catalog is empty",
              { botId, threadId },
            );
            return "missing";
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

          /**
           * Everything `sessions.startSession` needs: the workspace project, a
           * shuvcode model, and the bot's durable thread. Creating the thread is
           * a once-ever act, so this is safe to run on the resume path too.
           */
          const prepareThread = Effect.fn("AdeShuvcodeChatSession.prepareThread")(function* () {
            const project = yield* resolveProject(botId);

            // The shell read moved above the model resolution because the bot's
            // *own* pin lives on its thread: `thread.meta.update` writes it, and
            // the shell snapshot is already the read this path performs. No new
            // table, no new projection — a `.find` on data in hand.
            const shell = yield* orUnavailable("read threads", snapshots.getShellSnapshot());
            const existingThread = shell.threads.find((thread) => thread.id === threadId);
            const { modelSelection, modelHealth } = yield* resolveModelSelection({
              pinned: existingThread?.modelSelection ?? null,
              projectDefault: project.defaultModelSelection,
            });
            const botName = yield* orUnavailable("read bot", readBotName(botId));

            // Create the thread only once; a bot's chat is a durable place.
            if (existingThread === undefined) {
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
            return { project, modelSelection, botName, modelHealth };
          });

          /**
           * Hand the adapter this thread. The adapter adopts a session it
           * already holds and otherwise stands one up, which is the only way the
           * process-local session context — the thing every provider-authoritative
           * call, including the tool probe, is gated on — comes into existence.
           */
          const startAdapterSession = (prepared: {
            readonly project: { readonly workspaceRoot: string };
            readonly modelSelection: ModelSelection;
            readonly botName: string;
          }) =>
            orUnavailable(
              "start shuvcode session",
              sessions.startSession(threadId, {
                threadId,
                providerInstanceId: ADE_SHUVCODE_INSTANCE_ID,
                cwd: prepared.project.workspaceRoot,
                title: `ADE · ${prepared.botName}`,
                modelSelection: prepared.modelSelection,
                runtimeMode: "full-access",
                threadSource: "ade",
              }),
            );

          /**
           * Point a surviving binding — and the gate — at the kernel session the
           * adapter actually holds. A binding left naming a session the kernel
           * re-minted strands every S7 delivery and S8 lookup on an id that no
           * longer exists, so the row follows the kernel.
           */
          const reconcileKernelSession = Effect.fn("AdeShuvcodeChatSession.reconcileKernelSession")(
            function* (input: {
              readonly bindingId: BotExecutionBindingId;
              readonly kernelSessionId: KernelSessionId;
              readonly fallbackSessionId: KernelSessionId;
            }) {
              const rebound = yield* Effect.exit(
                rollover.rebindKernelSession({
                  bindingId: input.bindingId,
                  sessionId: input.kernelSessionId,
                }),
              );
              if (rebound._tag === "Failure") {
                yield* Effect.logWarning(
                  "ADE binding could not adopt the re-minted kernel session",
                  {
                    botId,
                    bindingId: input.bindingId,
                  },
                );
              }
              const sessionId = (
                rebound._tag === "Success" ? rebound.value.sessionId : input.fallbackSessionId
              ) as KernelSessionId;
              yield* orUnavailable(
                "rebind tool gate",
                gate.rebindShuvcodeSession({ threadId, sessionId, principal }),
              );
              yield* bindModelHealth(sessionId);
              return sessionId;
            },
          );

          /**
           * Bind the malformed-tool-call count to the kernel session it belongs
           * to. A *new* session starts over; re-opening the same one keeps the
           * verdict, which is how a captain who reconnects to a looping bot
           * finally gets told why.
           */
          const bindModelHealth = (sessionId: KernelSessionId) =>
            Effect.sync(() => {
              adeModelHealthTracker.bindSession({ threadId, sessionId });
            });

          /**
           * The model the thread already records. Used on the resume path,
           * where a live adapter session means nothing was re-resolved: the
           * reported model must still be the same fact either way, or two
           * concurrent starts describe the same session differently.
           */
          const readThreadModelSlug = Effect.fn("AdeShuvcodeChatSession.readThreadModelSlug")(
            function* () {
              const shell = yield* Effect.orElseSucceed(snapshots.getShellSnapshot(), () => null);
              const selection = shell?.threads.find(
                (thread) => thread.id === threadId,
              )?.modelSelection;
              return selection?.instanceId === ADE_SHUVCODE_INSTANCE_ID ? selection.model : null;
            },
          );

          /** Observation outranks prediction: the model already misbehaved. */
          const modelHealthFor = (predicted: AdeModelHealth): AdeModelHealth =>
            adeModelHealthTracker.isMalformed(threadId) ? "malformed-tool-input" : predicted;

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
            yield* bindModelHealth(sessionId);

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
              adeModelHealthTracker.clearThread(threadId);
            } else {
              // The binding is durable; the adapter's session map is not. After a
              // restart the gate is rebound and the catalog is stored locally,
              // but no in-process session exists yet — so nothing has been pushed
              // to the kernel and the tool probe cannot even ask. Standing the
              // session up is what makes the resume path do what the fresh path
              // does: the adapter adopts or creates the session, the locally
              // stored catalog rides that creation, and only then is the probe
              // answering a real question (#199).
              //
              // Gated on the adapter *not* already holding this thread, and that
              // gate is load-bearing rather than an optimization. Against an
              // external shuvcode server the adapter's adopt fast path is
              // unreachable (`canRegisterMcpServers` is false), so an
              // unconditional start would fall into its replace branch: scope
              // closed, event pump torn down, and outstanding dynamic tool calls
              // cancelled mid-flight — an interrupted call re-runs its handler on
              // the next drain, double-executing side-effecting fleet tools.
              // Opening a chat must never do that. When the adapter already holds
              // the session the probe is answerable as-is, which is all #199
              // needed.
              const live = yield* adapter.hasSession(threadId);
              const started = live
                ? null
                : yield* Effect.exit(
                    Effect.flatMap(prepareThread(), (prepared) =>
                      Effect.map(startAdapterSession(prepared), (session) => ({
                        session,
                        prepared,
                      })),
                    ),
                  );

              let liveSessionId = sessionId;
              // A start that failed for any reason other than "this process
              // never held the session" is itself the answer: the kernel is
              // unreachable or the bot's project is gone, delegation is down, and
              // the captain needs to see a reason rather than silence.
              let startRefused = false;
              if (started !== null && started._tag === "Failure") {
                const cause = Cause.squash(started.cause);
                startRefused = !adapterSessionMissing(cause);
                yield* Effect.logWarning(
                  "ADE could not stand up a shuvcode session for a surviving binding; the chat opens but delegation may be unavailable",
                  { botId, sessionId, cause },
                );
              } else if (
                started !== null &&
                started.value.session.providerThreadId !== undefined &&
                started.value.session.providerThreadId !== sessionId
              ) {
                // The adapter re-minted rather than adopted (the kernel had
                // forgotten this session). The binding follows it.
                liveSessionId = yield* reconcileKernelSession({
                  bindingId,
                  kernelSessionId: started.value.session.providerThreadId as KernelSessionId,
                  fallbackSessionId: sessionId,
                });
              }

              const probed = yield* probeTools;
              const toolsProbe = probed === "unknown" && startRefused ? "missing" : probed;
              if (toolsProbe === "missing") {
                yield* Effect.logWarning(
                  "ADE fleet tools are unavailable on an existing session; chat continues without delegation",
                  { botId, sessionId: liveSessionId },
                );
              }
              return {
                botId,
                threadId,
                engine: "shuvcode",
                bindingId,
                sessionId: liveSessionId,
                startedNow: false,
                toolsProbe,
                toolsAttached: toolsProbe !== "missing",
                modelHealth: modelHealthFor(
                  started?._tag === "Success" ? started.value.prepared.modelHealth : "ok",
                ),
                modelSlug:
                  started?._tag === "Success"
                    ? started.value.prepared.modelSelection.model
                    : yield* readThreadModelSlug(),
              } satisfies AdeBotChatSession;
            }
          }

          const prepared = yield* prepareThread();

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

          const session = yield* startAdapterSession(prepared);
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
          yield* bindModelHealth(kernelSessionId as KernelSessionId);

          // Did the catalog actually take? Tools ride `session.create`, but a
          // kernel build without the dynamic-tool routes accepts the create and
          // silently drops them — and a bot that cannot delegate while the UI
          // implies it can is worse than one that says so.
          const toolsProbe = yield* probeTools;
          const toolsAttached = toolsProbe !== "missing";

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
            // surviving binding may still name the old kernel id.
            const adoptedSessionId = yield* reconcileKernelSession({
              bindingId: adoptedBindingId,
              kernelSessionId: kernelSessionId as KernelSessionId,
              fallbackSessionId: adopted.kernel_session_id as KernelSessionId,
            });
            return {
              botId,
              threadId,
              engine: "shuvcode",
              bindingId: adoptedBindingId,
              sessionId: adoptedSessionId,
              startedNow: false,
              toolsProbe,
              toolsAttached,
              modelHealth: modelHealthFor(prepared.modelHealth),
              modelSlug: prepared.modelSelection.model,
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
            toolsProbe,
            toolsAttached,
            modelHealth: modelHealthFor(prepared.modelHealth),
            modelSlug: prepared.modelSelection.model,
          } satisfies AdeBotChatSession;
        },
      );

      const startPrimaryChat: AdeChatSessionPortShape["startPrimaryChat"] = (botId: BotId) =>
        startLockFor(adeBotThreadId(botId)).withPermits(1)(startPrimaryChatUnlocked(botId));

      return AdeChatSessionPort.of({ startPrimaryChat });
    }),
  );
}
