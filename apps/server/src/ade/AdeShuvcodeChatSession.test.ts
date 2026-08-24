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

import type { BotId, KernelSessionId } from "@shuv2code/contracts";

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

/** Tagged so the stub's failure stays distinguishable in the error channel. */
class StubAttachError extends Schema.TaggedErrorClass<StubAttachError>()("StubAttachError", {}) {}

interface Spy {
  /** Every `attachShuvcodeThread` call, as `threadId|sessionId|botId`. */
  readonly attaches: Ref.Ref<ReadonlyArray<string>>;
  /** Set to make the attach fail, standing in for a kernel refusing tools. */
  readonly attachFails: Ref.Ref<boolean>;
  /** Every local `rebindShuvcodeSession`, as `threadId|sessionId|botId`. */
  readonly rebinds: Ref.Ref<ReadonlyArray<string>>;
}

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
                ? Effect.fail(new StubAttachError())
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
          getByInstance: () => Effect.succeed({ dynamicTools: {}, syntheticInput: undefined }),
          streamChanges: Stream.empty,
        } as unknown as ProviderAdapterRegistry.ProviderAdapterRegistry["Service"]),
        Layer.succeed(ProviderRegistry.ProviderRegistry, {
          getProviders: Effect.succeed([]),
        } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
        Layer.succeed(ProviderService.ProviderService, {
          startSession: () => Effect.die("no session should be started in these cases"),
        } as unknown as ProviderService.ProviderService["Service"]),
        Layer.succeed(OrchestrationEngine.OrchestrationEngineService, {
          dispatch: () => Effect.succeed({ sequence: 1 }),
        } as unknown as OrchestrationEngine.OrchestrationEngineService["Service"]),
        Layer.succeed(ProjectionSnapshotQuery.ProjectionSnapshotQuery, {
          // No shuv2code project exists, so the fresh-start path stops with a
          // clear refusal instead of wandering into session creation.
          getShellSnapshot: () => Effect.succeed({ projects: [], threads: [] }),
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
        yield* Ref.set(spy.attachFails, true);

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

  it.effect("refuses actionably when the fleet has no project at all", () =>
    withChat(() =>
      Effect.gen(function* () {
        const { chat, botId } = yield* setup;
        const error = yield* Effect.flip(chat.startPrimaryChat(botId));
        assert.equal(error.reason, "session_unavailable");
        assert.include(error.message, "Create one from the Fleet page");
      }),
    ),
  );
});
