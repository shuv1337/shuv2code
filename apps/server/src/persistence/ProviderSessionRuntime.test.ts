import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, ThreadId } from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { SqlitePersistenceMemory } from "./Layers/Sqlite.ts";
import { layer, ProviderSessionRuntimeRepository } from "./ProviderSessionRuntime.ts";

const repositoryLayer = layer.pipe(Layer.provideMerge(SqlitePersistenceMemory));

describe("ProviderSessionRuntimeRepository.remapOpenCodeV2Identity", () => {
  it.effect("rewrites only explicitly bound legacy rows and converts the resume cursor", () =>
    Effect.gen(function* () {
      const repository = yield* ProviderSessionRuntimeRepository;
      const fromInstanceId = ProviderInstanceId.make("opencode");
      const toInstanceId = ProviderInstanceId.make("opencodeV2");
      const base = {
        providerName: "opencode",
        adapterKey: "opencode",
        runtimeMode: "full-access" as const,
        status: "running" as const,
        lastSeenAt: "2026-08-13T20:00:00.000Z",
        runtimePayload: null,
      };
      yield* repository.upsert({
        ...base,
        threadId: ThreadId.make("thread-v2"),
        providerInstanceId: fromInstanceId,
        resumeCursor: { sessionId: "ses_v2", activeTurnId: "turn_1" },
      });
      yield* repository.upsert({
        ...base,
        threadId: ThreadId.make("thread-legacy-unbound"),
        providerInstanceId: null,
        resumeCursor: { sessionId: "ses_v1" },
      });

      yield* repository.remapOpenCodeV2Identity({
        fromInstanceId,
        toInstanceId,
        toProviderName: ProviderDriverKind.make("opencodeV2"),
      });

      const migrated = yield* repository.getByThreadId({ threadId: ThreadId.make("thread-v2") });
      expect(Option.getOrThrow(migrated).providerInstanceId).toBe(toInstanceId);
      expect(Option.getOrThrow(migrated).resumeCursor).toEqual({
        kind: "opencode-v2",
        schemaVersion: 1,
        sessionId: "ses_v2",
        activeTurnId: "turn_1",
      });
      const untouched = yield* repository.getByThreadId({
        threadId: ThreadId.make("thread-legacy-unbound"),
      });
      expect(Option.getOrThrow(untouched).providerInstanceId).toBeNull();
      expect(Option.getOrThrow(untouched).resumeCursor).toEqual({ sessionId: "ses_v1" });
    }).pipe(Effect.provide(repositoryLayer)),
  );
});
