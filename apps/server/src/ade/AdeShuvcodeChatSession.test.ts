/**
 * The restart path (spec §7 slice 1, ADR §16).
 *
 * `BotExecutionBinding` is durable; the tool gate's thread→principal map and
 * the seam's per-thread tool config are not — they live in process memory. So
 * the interesting case is not "start a chat", it is "start a chat again in a
 * process that has forgotten everything except the database row". Getting that
 * wrong hands the captain a session that silently ships no tools and whose
 * calls cannot be attributed to a bot.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProviderInstanceId, type BotId, type KernelSessionId } from "@shuv2code/contracts";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import * as ProviderAdapterRegistry from "../provider/Services/ProviderAdapterRegistry.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ProviderService from "../provider/Services/ProviderService.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import { AdeChatSessionPort } from "./AdeChatSessionPort.ts";
import { AdeSessionRollover } from "./AdeSessionRollover.ts";
import { AdeShuvcodeChatSession } from "./AdeShuvcodeChatSession.ts";
import { AdeToolGate } from "./AdeToolGate.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";

/** Tagged so the stub's failure stays distinguishable in the error channel. */
class StubAttachError extends Schema.TaggedErrorClass<StubAttachError>()("StubAttachError", {}) {}

/** Mimics the upstream 404 body that marks a session as gone. */
const sessionNotFoundError = () => ({
  status: 404,
  errorName: "SessionNotFoundError",
  body: { _tag: "SessionNotFoundError" },
});

/** Only the fields the resolution ladder reads. */
interface CatalogModel {
  readonly slug: string;
  readonly isDefault?: boolean;
  readonly capabilities?: { readonly toolCalling?: boolean; readonly textOutput?: boolean };
}

interface Spy {
  /** Every `attachShuvcodeThread` call, as `threadId|sessionId|botId`. */
  readonly attaches: Ref.Ref<ReadonlyArray<string>>;
  /** Set to make the attach fail, standing in for a kernel refusing tools. */
  readonly attachFails: Ref.Ref<boolean>;
  /** Every local `rebindShuvcodeSession`, as `threadId|sessionId|botId`. */
  readonly rebinds: Ref.Ref<ReadonlyArray<string>>;
  /** What the provider-authoritative `listTools` reports, or null to throw. */
  readonly catalog: Ref.Ref<ReadonlyArray<{ readonly name: string }> | null>;
  /** When true the attach fails as "session gone", else as a missing route. */
  readonly sessionGone: Ref.Ref<boolean>;
  /** Orchestration command types dispatched, in order. */
  readonly dispatches: Ref.Ref<ReadonlyArray<string>>;
  /** Workspace projects the fake shell reports. */
  readonly shellProjects: Ref.Ref<ReadonlyArray<{ id: string; workspaceRoot: string }>>;
  /**
   * Threads the fake shell reports. `modelSelection` is required on a real
   * `OrchestrationThreadShell`, and it is where a bot's pinned model lives.
   */
  readonly shellThreads: Ref.Ref<
    ReadonlyArray<{ id: string; modelSelection: { instanceId: string; model: string } }>
  >;
  /** What the shuvcode instance reports as its model catalog. */
  readonly catalogModels: Ref.Ref<ReadonlyArray<CatalogModel>>;
  /** Make `project.create` fail, standing in for a rejected command receipt. */
  readonly rejectProjectCreate: Ref.Ref<boolean>;
  /**
   * Does the adapter hold an in-process session for this thread? False is what
   * a freshly restarted server looks like: the durable binding is there, the
   * adapter's session map is empty, and every provider-authoritative call
   * fails locally before any HTTP happens.
   */
  readonly adapterSessionLive: Ref.Ref<boolean>;
  /**
   * Make the probe fail adapter-locally even though `hasSession` says yes —
   * the session dropped between the check and the probe. The one case where
   * nothing ever asked the kernel and no start was attempted.
   */
  readonly probeSessionGone: Ref.Ref<boolean>;
  /** Kernel session `startSession` reports, or null to make it fail. */
  readonly mintedSessionId: Ref.Ref<string | null>;
  /** Every `ProviderService.startSession`, as `threadId|cwd`. */
  readonly startedSessions: Ref.Ref<ReadonlyArray<string>>;
  /** Every `ProviderService.stopSession`, as `threadId`. */
  readonly stoppedSessions: Ref.Ref<ReadonlyArray<string>>;
  /** Make `stopSession` fail, standing in for a session that will not drop. */
  readonly stopSessionFails: Ref.Ref<boolean>;
}

/**
 * What the adapter seam raises when it has no session for a thread. Carries
 * the real tag, because that tag is exactly how the chat session tells "the
 * kernel said no" apart from "this process never asked".
 */
class StubAdapterSessionNotFoundError extends Schema.TaggedErrorClass<StubAdapterSessionNotFoundError>()(
  "ProviderAdapterSessionNotFoundError",
  {},
) {}

/** What the stub seam's `listTools` answers with. */
type StubCatalog = Effect.Effect<
  ReadonlyArray<{ readonly name: string }>,
  StubAttachError | StubAdapterSessionNotFoundError
>;

const makeLayer = (spy: Spy) =>
  AdeShuvcodeChatSession.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        AdeBootstrap.layer,
        AdeSessionRollover.layer,
        Layer.succeed(AdeToolGate, {
          attachShuvcodeThread: (_seam: unknown, options: Record<string, unknown>) =>
            Effect.flatMap(Ref.get(spy.attachFails), (fails) =>
              fails
                ? Effect.flatMap(Ref.get(spy.sessionGone), (gone) =>
                    Effect.fail(gone ? sessionNotFoundError() : new StubAttachError()),
                  )
                : Ref.update(spy.attaches, (calls) => [
                    ...calls,
                    `${String(options.threadId)}|${String(options.sessionId)}|${String(
                      (options.principal as { botId: string }).botId,
                    )}`,
                  ]),
            ),
          rebindShuvcodeSession: (options: Record<string, unknown>) =>
            Ref.update(spy.rebinds, (calls) => [
              ...calls,
              `${String(options.threadId)}|${String(options.sessionId)}|${String(
                (options.principal as { botId: string }).botId,
              )}`,
            ]),
        } as unknown as AdeToolGate["Service"]),
        Layer.succeed(ProviderAdapterRegistry.ProviderAdapterRegistry, {
          // A seam is present, so "no dynamic-tool seam" is never the reason a
          // case below fails.
          getByInstance: () =>
            Effect.succeed({
              dynamicTools: {
                // Guarded exactly like the real seam: no in-process session,
                // no kernel round-trip, no answer about the catalog.
                listTools: (): StubCatalog =>
                  Effect.flatMap(
                    Effect.all([Ref.get(spy.adapterSessionLive), Ref.get(spy.probeSessionGone)]),
                    ([live, gone]): StubCatalog =>
                      live && !gone
                        ? Effect.flatMap(Ref.get(spy.catalog), (catalog) =>
                            catalog === null
                              ? Effect.fail(new StubAttachError())
                              : Effect.succeed(catalog),
                          )
                        : Effect.fail(new StubAdapterSessionNotFoundError()),
                  ),
              },
              // The same map `listTools` is gated on: this is what tells the
              // resume path whether standing a session up would *replace* a
              // live one (tearing down its pump and cancelling in-flight tool
              // calls) rather than create the missing one.
              hasSession: () => Ref.get(spy.adapterSessionLive),
              syntheticInput: { isLive: () => Effect.succeed(true), inject: () => Effect.void },
            }),
          streamChanges: Stream.empty,
        } as unknown as ProviderAdapterRegistry.ProviderAdapterRegistry["Service"]),
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.map(Ref.get(spy.catalogModels), (models) => [
            { instanceId: "opencodeV2", models, message: undefined },
          ]),
          refreshInstance: () =>
            Effect.map(Ref.get(spy.catalogModels), (models) => [
              { instanceId: "opencodeV2", models, message: undefined },
            ]),
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
        Layer.succeed(ProviderService.ProviderService, {
          // Standing up a session is what gives the adapter an in-process
          // context — and therefore what makes the tool probe answerable.
          // `mintedSessionId` is null by default so the cases that only assert
          // *which* project the chat resolves still stop before the kernel
          // handshake.
          startSession: (threadId: string, input: { readonly cwd?: string }) =>
            Effect.gen(function* () {
              yield* Ref.update(spy.startedSessions, (calls) => [
                ...calls,
                `${threadId}|${String(input.cwd)}`,
              ]);
              const minted = yield* Ref.get(spy.mintedSessionId);
              if (minted === null) return yield* new StubAttachError();
              // The real adapter connects, subscribes, and creates upstream
              // before it records the session — a wide window in which a
              // second caller can pass the same `hasSession` check. Modelled
              // here so an unserialized start is caught rather than hidden by
              // a synchronous stub.
              yield* Effect.yieldNow;
              yield* Ref.set(spy.adapterSessionLive, true);
              return { threadId, providerThreadId: minted };
            }),
          stopSession: (input: { readonly threadId: string }) =>
            Effect.gen(function* () {
              if (yield* Ref.get(spy.stopSessionFails)) return yield* new StubAttachError();
              yield* Ref.update(spy.stoppedSessions, (calls) => [...calls, input.threadId]);
              yield* Ref.set(spy.adapterSessionLive, false);
            }),
        } as unknown as ProviderService.ProviderService["Service"]),
        Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
          dispatch: (command: {
            readonly type: string;
            readonly projectId?: string;
            readonly workspaceRoot?: string;
          }) =>
            Effect.gen(function* () {
              yield* Ref.update(spy.dispatches, (types) => [...types, command.type]);
              if (command.type === "thread.create") {
                yield* Ref.update(spy.shellThreads, (threads) => [
                  ...threads,
                  {
                    id: String((command as { threadId?: string }).threadId),
                    modelSelection: (
                      command as unknown as {
                        modelSelection: { instanceId: string; model: string };
                      }
                    ).modelSelection,
                  },
                ]);
              }
              if (command.type === "thread.meta.update") {
                const update = command as unknown as {
                  threadId: string;
                  modelSelection?: { instanceId: string; model: string };
                };
                if (update.modelSelection !== undefined) {
                  yield* Ref.update(spy.shellThreads, (threads) =>
                    threads.map((thread) =>
                      thread.id === update.threadId
                        ? { ...thread, modelSelection: update.modelSelection! }
                        : thread,
                    ),
                  );
                }
              }
              if (command.type === "project.create" && (yield* Ref.get(spy.rejectProjectCreate))) {
                return yield* Effect.fail(new StubAttachError());
              }
              if (command.type === "project.create") {
                // A real engine registers it; the shell must then see it.
                yield* Ref.update(spy.shellProjects, (projects) => [
                  ...projects,
                  { id: String(command.projectId), workspaceRoot: String(command.workspaceRoot) },
                ]);
              }
              return { sequence: 1 };
            }),
        } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]),
        Layer.succeed(WorkspacePaths, {
          // Path normalization is exercised where it matters (project
          // creation); here it only has to be a stable identity.
          normalizeWorkspaceRoot: (root: string) =>
            Effect.succeed(root.replace(/^~/, "/home/captain").replace(/\/+$/, "")),
        } as unknown as WorkspacePaths["Service"]),
        Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          // No shuv2code project exists, so the fresh-start path stops with a
          // clear refusal instead of wandering into session creation.
          getShellSnapshot: () =>
            Effect.all([Ref.get(spy.shellProjects), Ref.get(spy.shellThreads)]).pipe(
              Effect.map(([projects, threads]) => ({ projects, threads })),
            ),
        } as unknown as ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"]),
      ),
    ),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  );

type ChatEnv = AdeChatSessionPort | AdeBootstrap | AdeSessionRollover | SqlClient.SqlClient;

const withChat = <A, E>(body: (spy: Spy) => Effect.Effect<A, E, ChatEnv>) =>
  Effect.gen(function* () {
    const spy: Spy = {
      attaches: yield* Ref.make<ReadonlyArray<string>>([]),
      attachFails: yield* Ref.make(false),
      rebinds: yield* Ref.make<ReadonlyArray<string>>([]),
      catalog: yield* Ref.make<ReadonlyArray<{ readonly name: string }> | null>([
        { name: "fleet_read" },
      ]),
      sessionGone: yield* Ref.make(false),
      dispatches: yield* Ref.make<ReadonlyArray<string>>([]),
      shellProjects: yield* Ref.make<ReadonlyArray<{ id: string; workspaceRoot: string }>>([]),
      shellThreads: yield* Ref.make<
        ReadonlyArray<{ id: string; modelSelection: { instanceId: string; model: string } }>
      >([]),
      catalogModels: yield* Ref.make<ReadonlyArray<CatalogModel>>([{ slug: "test/model" }]),
      rejectProjectCreate: yield* Ref.make(false),
      adapterSessionLive: yield* Ref.make(true),
      probeSessionGone: yield* Ref.make(false),
      mintedSessionId: yield* Ref.make<string | null>(null),
      startedSessions: yield* Ref.make<ReadonlyArray<string>>([]),
      stoppedSessions: yield* Ref.make<ReadonlyArray<string>>([]),
      stopSessionFails: yield* Ref.make(false),
    };
    return yield* Effect.provide(body(spy), makeLayer(spy));
  });

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`PRAGMA foreign_keys = ON`;
  const bootstrap = yield* AdeBootstrap;
  const seeded = yield* bootstrap.ensureSeeded();
  return {
    sql,
    rollover: yield* AdeSessionRollover,
    chat: yield* AdeChatSessionPort,
    botId: seeded.firstmateBotId,
  };
});

/**
 * An ADE project with a tilde repo path. The workspace project stores the
 * resolved root, so the two only meet after normalization.
 */
const seedProject = (sql: SqlClient.SqlClient) => sql`
  INSERT INTO ade_projects (
    project_id, name, second_mate_bot_id, repo_path, repo_remote,
    integration_policy_default, check_commands_json,
    shared_specialist_allow_list_json, limits_overrides_json,
    created_at, updated_at
  ) VALUES (
    'p1', 'Demo', 'sm1', '~/repos/demo', NULL, 'agent-review', '[]', '"all"', NULL,
    '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z'
  )
`;

describe("AdeShuvcodeChatSession.startPrimaryChat", () => {
  it.effect("re-attaches the tool gate to a binding that outlived the process", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { rollover, chat, botId } = yield* setup;
        // The durable half of a session started by a previous process.
        const opened = yield* rollover.startPrimarySession({
          botId,
          engine: "shuvcode",
          sessionId: "oc-survivor" as KernelSessionId,
        });

        const resolved = yield* chat.startPrimaryChat(botId);

        assert.isFalse(resolved.startedNow);
        assert.equal(resolved.bindingId, opened.binding.id);
        assert.equal(resolved.sessionId, "oc-survivor");
        // The whole point: the catalog is re-registered against the surviving
        // kernel session, under this bot's principal.
        assert.deepEqual(yield* Ref.get(spy.attaches), [`ade-bot-${botId}|oc-survivor|${botId}`]);
      }),
    ),
  );

  it.effect("keeps a session whose catalog refresh the kernel refuses", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { rollover, chat, botId } = yield* setup;
        const opened = yield* rollover.startPrimarySession({
          botId,
          engine: "shuvcode",
          sessionId: "oc-no-tools" as KernelSessionId,
        });
        // Route-level failure: the kernel build has no dynamic-tool endpoints,
        // so both the catalog write and the catalog read fail — but the
        // session itself is alive and must be kept.
        yield* Ref.set(spy.attachFails, true);
        yield* Ref.set(spy.catalog, null);
        yield* Ref.set(spy.sessionGone, false);

        const resolved = yield* chat.startPrimaryChat(botId);

        // A refused catalog write does NOT mean the session is gone — the
        // usual cause is a kernel build without the dynamic-tool routes.
        // Retiring the binding there would mint a fresh session on every
        // visit; the session is kept and the loss of tools is reported.
        assert.isFalse(resolved.startedNow);
        assert.equal(resolved.bindingId, opened.binding.id);
        assert.isFalse(resolved.toolsAttached);

        const bindings = yield* rollover.listBindings(botId);
        assert.equal(
          bindings.find((binding) => binding.id === opened.binding.id)?.status,
          "active",
        );
        // Attribution still got recorded, so invocations on that session can
        // be resolved to this bot even though the catalog push failed.
        assert.deepEqual(yield* Ref.get(spy.rebinds), [`ade-bot-${botId}|oc-no-tools|${botId}`]);
      }),
    ),
  );

  it.effect("reports tools missing when the catalog comes back empty", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { rollover, chat, botId } = yield* setup;
        yield* rollover.startPrimarySession({
          botId,
          engine: "shuvcode",
          sessionId: "oc-empty" as KernelSessionId,
        });
        // The kernel accepted every call and registered nothing. A successful
        // configure is not evidence of tools; an empty catalog means this bot
        // cannot delegate, and saying otherwise ships a silently broken bot.
        yield* Ref.set(spy.catalog, []);

        const resolved = yield* chat.startPrimaryChat(botId);
        assert.equal(resolved.toolsProbe, "missing");
        assert.isFalse(resolved.toolsAttached);
      }),
    ),
  );

  it.effect("says 'unknown', not 'missing', when nothing ever asked the kernel", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { rollover, chat, botId } = yield* setup;
        yield* rollover.startPrimarySession({
          botId,
          engine: "shuvcode",
          sessionId: "oc-vanished" as KernelSessionId,
        });
        // The adapter reports it holds the thread — so no start is attempted —
        // but the session is gone by the time the probe runs. The probe failed
        // inside the adapter, before any kernel round-trip: that is not
        // evidence the kernel dropped the catalog, and treating it as such is
        // what pinned a permanent "fleet tools unavailable" banner (#199).
        yield* Ref.set(spy.probeSessionGone, true);

        const resolved = yield* chat.startPrimaryChat(botId);

        assert.deepEqual(yield* Ref.get(spy.startedSessions), []);
        assert.equal(resolved.toolsProbe, "unknown");
        // The deprecated boolean must not carry the false negative either.
        assert.isTrue(resolved.toolsAttached);
      }),
    ),
  );

  it.effect("reports missing when the session could not be stood up at all", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { rollover, chat, botId } = yield* setup;
        yield* rollover.startPrimarySession({
          botId,
          engine: "shuvcode",
          sessionId: "oc-restarted" as KernelSessionId,
        });
        // Restarted process, and the repair cannot run: no project (or an
        // unreachable kernel). Delegation really is down and the captain has
        // to be told — silence here would hide a broken bot behind a working
        // chat.
        yield* Ref.set(spy.adapterSessionLive, false);

        const resolved = yield* chat.startPrimaryChat(botId);

        assert.equal(resolved.toolsProbe, "missing");
        assert.isFalse(resolved.toolsAttached);
      }),
    ),
  );

  it.effect("stands the session back up after a restart, then believes the probe", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { sql, rollover, chat, botId } = yield* setup;
        yield* seedProject(sql);
        yield* Ref.set(spy.shellProjects, [
          { id: "p-demo", workspaceRoot: "/home/captain/repos/demo" },
        ]);
        const opened = yield* rollover.startPrimarySession({
          botId,
          engine: "shuvcode",
          sessionId: "oc-survivor" as KernelSessionId,
        });
        // The durable half survived the restart; nothing in the process did.
        yield* Ref.set(spy.adapterSessionLive, false);
        // The adapter re-adopts the kernel session the binding names.
        yield* Ref.set(spy.mintedSessionId, "oc-survivor");

        const resolved = yield* chat.startPrimaryChat(botId);

        // The repair: the resume path stands the session up like the fresh
        // path does, so the catalog is pushed and the probe can answer.
        assert.deepEqual(yield* Ref.get(spy.startedSessions), [
          `ade-bot-${botId}|/home/captain/repos/demo`,
        ]);
        assert.equal(resolved.toolsProbe, "attached");
        assert.isTrue(resolved.toolsAttached);
        assert.isFalse(resolved.startedNow);
        assert.equal(resolved.bindingId, opened.binding.id);
        assert.equal(resolved.sessionId, "oc-survivor");
      }),
    ),
  );

  it.effect("never restarts a session the adapter is already holding", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { sql, rollover, chat, botId } = yield* setup;
        yield* seedProject(sql);
        yield* Ref.set(spy.shellProjects, [
          { id: "p-demo", workspaceRoot: "/home/captain/repos/demo" },
        ]);
        yield* rollover.startPrimarySession({
          botId,
          engine: "shuvcode",
          sessionId: "oc-live" as KernelSessionId,
        });
        // The adapter holds this thread: same process, second visit.
        yield* Ref.set(spy.adapterSessionLive, true);
        // Set, so a start that should not happen would visibly succeed.
        yield* Ref.set(spy.mintedSessionId, "oc-live");

        const resolved = yield* chat.startPrimaryChat(botId);

        // Against an external shuvcode server the adapter cannot take its
        // adopt fast path, so `startSession` on a thread it already holds is a
        // *replace*: pump torn down, in-flight dynamic tool calls cancelled,
        // and an interrupted call re-run — double-executing side-effecting
        // fleet tools just because the captain opened a chat. Opening a chat
        // must stay inert here; the probe already has its answer.
        assert.deepEqual(yield* Ref.get(spy.startedSessions), []);
        assert.equal(resolved.toolsProbe, "attached");
        assert.equal(resolved.sessionId, "oc-live");
      }),
    ),
  );

  it.effect("serializes concurrent starts into one adapter session", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { sql, rollover, chat, botId } = yield* setup;
        yield* seedProject(sql);
        yield* Ref.set(spy.shellProjects, [
          { id: "p-demo", workspaceRoot: "/home/captain/repos/demo" },
        ]);
        yield* rollover.startPrimarySession({
          botId,
          engine: "shuvcode",
          sessionId: "oc-survivor" as KernelSessionId,
        });
        yield* Ref.set(spy.adapterSessionLive, false);
        yield* Ref.set(spy.mintedSessionId, "oc-survivor");

        // The captain pressing "Start chat" while the assignment runner briefs
        // the same bot. Nothing else serializes this path — the provider
        // service's lane only wraps `sendTurn` — and a second start would
        // orphan the first event pump: two pumps feeding the dynamic-tool
        // queue means every call id is dispatched twice.
        const [first, second] = yield* Effect.all(
          [chat.startPrimaryChat(botId), chat.startPrimaryChat(botId)],
          { concurrency: "unbounded" },
        );

        assert.deepEqual(yield* Ref.get(spy.startedSessions), [
          `ade-bot-${botId}|/home/captain/repos/demo`,
        ]);
        // The loser waits, re-reads, and reports the same thing.
        assert.deepEqual(first, second);
        assert.equal(first.toolsProbe, "attached");
      }),
    ),
  );

  it.effect("follows the kernel when the restart re-mints instead of adopting", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { sql, rollover, chat, botId } = yield* setup;
        yield* seedProject(sql);
        yield* Ref.set(spy.shellProjects, [
          { id: "p-demo", workspaceRoot: "/home/captain/repos/demo" },
        ]);
        const opened = yield* rollover.startPrimarySession({
          botId,
          engine: "shuvcode",
          sessionId: "oc-old" as KernelSessionId,
        });
        yield* Ref.set(spy.adapterSessionLive, false);
        // The kernel had forgotten the old session, so the adapter made a new
        // one. The durable row has to follow it or every S7 delivery and S8
        // lookup is stranded on an id that no longer exists.
        yield* Ref.set(spy.mintedSessionId, "oc-new");

        const resolved = yield* chat.startPrimaryChat(botId);

        assert.equal(resolved.bindingId, opened.binding.id);
        assert.equal(resolved.sessionId, "oc-new");
        const bindings = yield* rollover.listBindings(botId);
        assert.equal(
          bindings.find((binding) => binding.id === opened.binding.id)?.sessionId,
          "oc-new",
        );
        // Attribution follows too, so a tool call on the new session resolves
        // to this bot.
        assert.include(yield* Ref.get(spy.rebinds), `ade-bot-${botId}|oc-new|${botId}`);
        assert.equal(resolved.toolsProbe, "attached");
      }),
    ),
  );

  it.effect("takes the kernel's configured default rather than the catalog order", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { sql, chat, botId } = yield* setup;
        yield* seedProject(sql);
        yield* Ref.set(spy.shellProjects, [
          { id: "p-demo", workspaceRoot: "/home/captain/repos/demo" },
        ]);
        yield* Ref.set(spy.mintedSessionId, "oc-new");
        // The catalog as observed on the VM: the free liar sorts first.
        yield* Ref.set(spy.catalogModels, [
          { slug: "opencode/big-pickle", capabilities: { toolCalling: false, textOutput: true } },
          {
            slug: "openai/gpt-5.6-sol",
            isDefault: true,
            capabilities: { toolCalling: true, textOutput: true },
          },
        ]);

        const resolved = yield* chat.startPrimaryChat(botId);

        assert.equal(resolved.modelSlug, "openai/gpt-5.6-sol");
        assert.equal(resolved.modelHealth, "ok");
      }),
    ),
  );

  it.effect("names the failure when no model on the kernel can run a bot", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { sql, chat, botId } = yield* setup;
        yield* seedProject(sql);
        yield* Ref.set(spy.shellProjects, [
          { id: "p-demo", workspaceRoot: "/home/captain/repos/demo" },
        ]);
        yield* Ref.set(spy.mintedSessionId, "oc-new");
        // An image model and a model that cannot call tools. Taking the first
        // one is what produced turns that failed with nothing to read.
        yield* Ref.set(spy.catalogModels, [
          {
            slug: "openai/chatgpt-image-latest",
            capabilities: { toolCalling: true, textOutput: false },
          },
          { slug: "opencode/big-pickle", capabilities: { toolCalling: false, textOutput: true } },
        ]);

        const failure = yield* Effect.flip(chat.startPrimaryChat(botId));

        assert.equal(failure.reason, "model_not_agent_capable");
        assert.include(failure.message, "opencode.json");
        // Nothing was stood up: the refusal happens before the kernel is asked.
        assert.deepEqual(yield* Ref.get(spy.startedSessions), []);
      }),
    ),
  );

  it.effect("honours a pinned model the kernel says cannot call tools, and flags it", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { sql, chat, botId } = yield* setup;
        yield* seedProject(sql);
        yield* Ref.set(spy.shellProjects, [
          { id: "p-demo", workspaceRoot: "/home/captain/repos/demo" },
        ]);
        yield* Ref.set(spy.mintedSessionId, "oc-new");
        yield* Ref.set(spy.catalogModels, [
          { slug: "opencode/big-pickle", capabilities: { toolCalling: false, textOutput: true } },
          {
            slug: "openai/gpt-5.6-sol",
            isDefault: true,
            capabilities: { toolCalling: true, textOutput: true },
          },
        ]);
        // The captain already chose. Capability data is provider-reported and
        // can be wrong, and refusing here would leave no override anywhere.
        yield* Ref.set(spy.shellThreads, [
          {
            id: `ade-bot-${botId}`,
            modelSelection: { instanceId: "opencodeV2", model: "opencode/big-pickle" },
          },
        ]);

        const resolved = yield* chat.startPrimaryChat(botId);

        assert.equal(resolved.modelSlug, "opencode/big-pickle");
        assert.equal(resolved.modelHealth, "unreported-tools");
      }),
    ),
  );

  it.effect("reports tools present only on a non-empty catalog", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { rollover, chat, botId } = yield* setup;
        yield* rollover.startPrimarySession({
          botId,
          engine: "shuvcode",
          sessionId: "oc-full" as KernelSessionId,
        });
        yield* Ref.set(spy.catalog, [{ name: "fleet_read" }, { name: "create_assignment" }]);

        const resolved = yield* chat.startPrimaryChat(botId);
        assert.isTrue(resolved.toolsAttached);
      }),
    ),
  );

  it.effect("retires a binding whose kernel session the kernel has forgotten", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { rollover, chat, botId } = yield* setup;
        const opened = yield* rollover.startPrimarySession({
          botId,
          engine: "shuvcode",
          sessionId: "oc-dead" as KernelSessionId,
        });
        // Attach fails AND the kernel no longer holds the session: this is the
        // kernel-restart case, and the binding must not survive it or the bot
        // is permanently unopenable.
        yield* Ref.set(spy.attachFails, true);
        yield* Ref.set(spy.sessionGone, true);

        // Falls through to a fresh start, which stops at "no project" here.
        yield* Effect.flip(chat.startPrimaryChat(botId));

        const bindings = yield* rollover.listBindings(botId);
        assert.equal(bindings.find((binding) => binding.id === opened.binding.id)?.status, "lost");
      }),
    ),
  );

  it.effect("finds the workspace project it already created instead of re-creating it", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { sql, chat, botId } = yield* setup;
        // The ADE project stores a tilde path; the workspace project stores
        // the resolved root. Comparing them raw never matches, and the second
        // start then re-dispatches project.create — which the command receipt
        // rejects, turning "works once" into a permanent refusal.
        yield* seedProject(sql);

        yield* Effect.flip(chat.startPrimaryChat(botId));
        const firstDispatches = yield* Ref.get(spy.dispatches);
        yield* Effect.flip(chat.startPrimaryChat(botId));
        const secondDispatches = yield* Ref.get(spy.dispatches);

        // Nothing is created twice: the second start matched both the
        // normalized workspace root and the existing thread that the first
        // start registered.
        assert.deepEqual(firstDispatches, ["project.create", "thread.create"]);
        assert.deepEqual(secondDispatches, firstDispatches);
      }),
    ),
  );

  it.effect("survives a lost project.create race by looking the winner up", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { sql, chat, botId } = yield* setup;
        yield* seedProject(sql);
        // Two bots starting at once: this one loses the dispatch (the receipt
        // hash covers createdAt and the model, so an identical-in-spirit retry
        // is rejected rather than deduped) while the rival's project lands.
        yield* Ref.set(spy.rejectProjectCreate, true);
        yield* Ref.set(spy.shellProjects, [
          { id: "rival", workspaceRoot: "/home/captain/repos/demo" },
        ]);

        yield* Effect.flip(chat.startPrimaryChat(botId));

        // It proceeded on the rival's project instead of failing the chat.
        const dispatches = yield* Ref.get(spy.dispatches);
        assert.include(dispatches, "thread.create");
      }),
    ),
  );

  it.effect("refuses actionably when the fleet has no project at all", () =>
    withChat(() =>
      Effect.gen(function* () {
        const { chat, botId } = yield* setup;
        const error = yield* Effect.flip(chat.startPrimaryChat(botId));
        assert.equal(error.reason, "session_unavailable");
        assert.include(error.message, "Create one with a repository path");
      }),
    ),
  );

  it.effect("names the project, not a phantom missing one, when the repo is unbound (#212)", () =>
    withChat(() =>
      Effect.gen(function* () {
        const { sql, chat, botId } = yield* setup;
        // A project created before the CTA required a repository path. The old
        // copy said "This bot has no project. Create one from the Fleet page",
        // which was false — a project exists — and unactionable, because a
        // second project would be just as unbound.
        yield* sql`
          INSERT INTO ade_projects (
            project_id, name, second_mate_bot_id, repo_path, repo_remote,
            integration_policy_default, check_commands_json,
            shared_specialist_allow_list_json, limits_overrides_json,
            created_at, updated_at
          ) VALUES (
            'p-unbound', 'Ledger', 'sm1', NULL, NULL, 'agent-review', '[]', '"all"', NULL,
            '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z'
          )
        `;
        yield* sql`UPDATE ade_bots SET project_id = 'p-unbound' WHERE bot_id = ${botId}`;

        const error = yield* Effect.flip(chat.startPrimaryChat(botId));
        assert.equal(error.reason, "session_unavailable");
        assert.include(error.message, "'Ledger' has no repository path");
        assert.notInclude(error.message, "This bot has no project");
      }),
    ),
  );
});

// ---------------------------------------------------------------------------
// Setting a bot's model (issue #223 follow-up)
// ---------------------------------------------------------------------------

const shuvcodeSelection = (model: string) => ({
  instanceId: ProviderInstanceId.make("opencodeV2"),
  model,
});

/** The thread a pin is written to. `prepareThread` creates it on first chat. */
const pinnedThread = (botId: string, model = "openai/gpt-5.6-sol") => ({
  id: `ade-bot-${botId}`,
  modelSelection: { instanceId: "opencodeV2", model },
});

describe("AdeShuvcodeChatSession.setBotModel", () => {
  it.effect("writes the pin to the bot's own thread", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { chat, botId } = yield* setup;
        yield* Ref.set(spy.shellThreads, [pinnedThread(botId, "openai/old")]);
        yield* Ref.set(spy.catalogModels, [
          { slug: "openai/old" },
          { slug: "openai/gpt-5.6-sol", capabilities: { toolCalling: true, textOutput: true } },
        ]);

        const setting = yield* chat.setBotModel({
          botId,
          modelSelection: shuvcodeSelection("openai/gpt-5.6-sol"),
        });

        assert.equal(setting.modelSelection.model, "openai/gpt-5.6-sol");
        assert.include(yield* Ref.get(spy.dispatches), "thread.meta.update");
        assert.equal(yield* chat.readBotModelSlug(botId), "openai/gpt-5.6-sol");
      }),
    ),
  );

  it.effect("refuses a slug the kernel does not offer at all", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { chat, botId } = yield* setup;
        yield* Ref.set(spy.shellThreads, [pinnedThread(botId)]);
        yield* Ref.set(spy.catalogModels, [{ slug: "openai/gpt-5.6-sol" }]);

        const failure = yield* Effect.flip(
          chat.setBotModel({ botId, modelSelection: shuvcodeSelection("openai/typo") }),
        );

        assert.equal(failure.reason, "model_not_agent_capable");
        assert.include(failure.message, "openai/typo");
        // Nothing was written: a refused choice must not half-land.
        assert.notInclude(yield* Ref.get(spy.dispatches), "thread.meta.update");
      }),
    ),
  );

  it.effect("accepts a model the kernel says cannot call tools", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { chat, botId } = yield* setup;
        yield* Ref.set(spy.shellThreads, [pinnedThread(botId)]);
        yield* Ref.set(spy.catalogModels, [
          { slug: "openai/gpt-5.6-sol" },
          { slug: "opencode/big-pickle", capabilities: { toolCalling: false, textOutput: true } },
        ]);

        // Provider-reported capabilities can be stale or absent for a model the
        // captain knows works; refusing would leave no override in the product.
        const setting = yield* chat.setBotModel({
          botId,
          modelSelection: shuvcodeSelection("opencode/big-pickle"),
        });

        assert.equal(setting.modelSelection.model, "opencode/big-pickle");
      }),
    ),
  );

  it.effect("refuses a selection that points at another provider instance", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { chat, botId } = yield* setup;
        yield* Ref.set(spy.shellThreads, [pinnedThread(botId)]);

        const failure = yield* Effect.flip(
          chat.setBotModel({
            botId,
            modelSelection: {
              instanceId: ProviderInstanceId.make("codex"),
              model: "codex/gpt-5",
            },
          }),
        );

        assert.equal(failure.reason, "model_not_agent_capable");
        assert.include(failure.message, "codex");
      }),
    ),
  );

  it.effect("says which act comes first when the bot has no conversation yet", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { chat, botId } = yield* setup;
        yield* Ref.set(spy.catalogModels, [{ slug: "openai/gpt-5.6-sol" }]);

        const failure = yield* Effect.flip(
          chat.setBotModel({ botId, modelSelection: shuvcodeSelection("openai/gpt-5.6-sol") }),
        );

        assert.equal(failure.reason, "session_unavailable");
        assert.include(failure.message, "Open its chat once");
      }),
    ),
  );

  it.effect("reports a live session as still running the previous model", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { rollover, chat, botId } = yield* setup;
        yield* rollover.startPrimarySession({
          botId,
          engine: "shuvcode",
          sessionId: "oc-live" as KernelSessionId,
        });
        yield* Ref.set(spy.shellThreads, [pinnedThread(botId, "openai/old")]);
        yield* Ref.set(spy.catalogModels, [{ slug: "openai/old" }, { slug: "openai/gpt-5.6-sol" }]);

        const setting = yield* chat.setBotModel({
          botId,
          modelSelection: shuvcodeSelection("openai/gpt-5.6-sol"),
        });

        // The whole point of the flag: the pin landed, the bot has not moved.
        assert.isFalse(setting.appliesToLiveSession);
        assert.deepEqual(yield* Ref.get(spy.stoppedSessions), []);
      }),
    ),
  );

  it.effect("drops the live session when the captain asks for it", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { rollover, chat, botId } = yield* setup;
        yield* rollover.startPrimarySession({
          botId,
          engine: "shuvcode",
          sessionId: "oc-live" as KernelSessionId,
        });
        yield* Ref.set(spy.shellThreads, [pinnedThread(botId, "openai/old")]);
        yield* Ref.set(spy.catalogModels, [{ slug: "openai/old" }, { slug: "openai/gpt-5.6-sol" }]);

        const setting = yield* chat.setBotModel({
          botId,
          modelSelection: shuvcodeSelection("openai/gpt-5.6-sol"),
          restartSession: true,
        });

        assert.isTrue(setting.appliesToLiveSession);
        assert.deepEqual(yield* Ref.get(spy.stoppedSessions), [`ade-bot-${botId}`]);
      }),
    ),
  );

  it.effect("does not claim a restart that did not happen", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { rollover, chat, botId } = yield* setup;
        yield* rollover.startPrimarySession({
          botId,
          engine: "shuvcode",
          sessionId: "oc-live" as KernelSessionId,
        });
        yield* Ref.set(spy.shellThreads, [pinnedThread(botId, "openai/old")]);
        yield* Ref.set(spy.catalogModels, [{ slug: "openai/old" }, { slug: "openai/gpt-5.6-sol" }]);
        yield* Ref.set(spy.stopSessionFails, true);

        const setting = yield* chat.setBotModel({
          botId,
          modelSelection: shuvcodeSelection("openai/gpt-5.6-sol"),
          restartSession: true,
        });

        // The pin is real either way; only the "it took effect" half is not.
        assert.isFalse(setting.appliesToLiveSession);
        assert.equal(yield* chat.readBotModelSlug(botId), "openai/gpt-5.6-sol");
      }),
    ),
  );

  it.effect("reports a bot with no live session as already on the new model", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { chat, botId } = yield* setup;
        yield* Ref.set(spy.shellThreads, [pinnedThread(botId, "openai/old")]);
        yield* Ref.set(spy.catalogModels, [{ slug: "openai/old" }, { slug: "openai/gpt-5.6-sol" }]);

        const setting = yield* chat.setBotModel({
          botId,
          modelSelection: shuvcodeSelection("openai/gpt-5.6-sol"),
        });

        assert.isTrue(setting.appliesToLiveSession);
      }),
    ),
  );

  it.effect("reads no model for a thread bound to a different provider", () =>
    withChat((spy) =>
      Effect.gen(function* () {
        const { chat, botId } = yield* setup;
        yield* Ref.set(spy.shellThreads, [
          {
            id: `ade-bot-${botId}`,
            modelSelection: { instanceId: "codex", model: "codex/gpt-5" },
          },
        ]);

        assert.equal(yield* chat.readBotModelSlug(botId), null);
      }),
    ),
  );
});
