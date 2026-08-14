import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, ThreadId } from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionThreadSessionRepository } from "../Services/ProjectionThreadSessions.ts";
import { ProjectionThreadSessionRepositoryLive } from "./ProjectionThreadSessions.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

const repositoryLayer = ProjectionThreadSessionRepositoryLive.pipe(
  Layer.provideMerge(SqlitePersistenceMemory),
);

describe("ProjectionThreadSessionRepository.remapOpenCodeV2Identity", () => {
  it.effect("rewrites only explicitly bound legacy rows", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadSessionRepository;
      const fromInstanceId = ProviderInstanceId.make("opencode");
      const toInstanceId = ProviderInstanceId.make("opencodeV2");
      const base = {
        status: "running" as const,
        providerName: "opencode",
        runtimeMode: "full-access" as const,
        activeTurnId: null,
        lastError: null,
        updatedAt: "2026-08-13T20:00:00.000Z",
      };

      yield* repository.upsert({
        ...base,
        threadId: ThreadId.make("thread-v2"),
        providerInstanceId: fromInstanceId,
      });
      yield* repository.upsert({
        ...base,
        threadId: ThreadId.make("thread-legacy-unbound"),
        providerInstanceId: null,
      });

      yield* repository.remapOpenCodeV2Identity({
        fromInstanceId,
        toInstanceId,
        toProviderName: "opencodeV2",
      });

      const migrated = Option.getOrThrow(
        yield* repository.getByThreadId({ threadId: ThreadId.make("thread-v2") }),
      );
      expect(migrated.providerName).toBe("opencodeV2");
      expect(migrated.providerInstanceId).toBe(toInstanceId);

      const untouched = Option.getOrThrow(
        yield* repository.getByThreadId({
          threadId: ThreadId.make("thread-legacy-unbound"),
        }),
      );
      expect(untouched.providerName).toBe("opencode");
      expect(untouched.providerInstanceId).toBeNull();
    }).pipe(Effect.provide(repositoryLayer)),
  );
});
