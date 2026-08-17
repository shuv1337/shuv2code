import { assert, it } from "@effect/vitest";
import { ThreadId } from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ThreadControlGrantRepository } from "../Services/ThreadControlGrants.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ThreadControlGrantRepositoryLive } from "./ThreadControlGrants.ts";

const layer = it.layer(
  ThreadControlGrantRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

layer("ThreadControlGrantRepository", (it) => {
  it.effect("persists, updates, and revokes an explicit durable controller grant", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadControlGrantRepository;
      const threadId = ThreadId.make("durable-controller-thread");
      yield* repository.upsert({
        threadId,
        authorizedRuntimeCeiling: "approval-required",
        controlEnabled: false,
        createdAt: "2026-08-16T00:00:00.000Z",
        updatedAt: "2026-08-16T00:00:00.000Z",
      });
      yield* repository.upsert({
        threadId,
        authorizedRuntimeCeiling: "auto-accept-edits",
        controlEnabled: true,
        createdAt: "2026-08-16T00:00:00.000Z",
        updatedAt: "2026-08-16T00:01:00.000Z",
      });

      const stored = yield* repository.getByThreadId(threadId);
      assert.isTrue(Option.isSome(stored));
      if (Option.isSome(stored)) {
        assert.deepEqual(stored.value, {
          threadId,
          authorizedRuntimeCeiling: "auto-accept-edits",
          controlEnabled: true,
          createdAt: "2026-08-16T00:00:00.000Z",
          updatedAt: "2026-08-16T00:01:00.000Z",
        });
      }
      assert.isTrue(yield* repository.revoke(threadId));
      assert.isTrue(Option.isNone(yield* repository.getByThreadId(threadId)));
    }),
  );
});
