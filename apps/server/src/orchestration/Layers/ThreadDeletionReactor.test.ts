import { EventId, ThreadId, type OrchestrationEvent } from "@shuv2code/contracts";
import { it as effectIt } from "@effect/vitest";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import { describe, expect, it, vi } from "vite-plus/test";

import * as McpSessionRegistry from "../../mcp/McpSessionRegistry.ts";
import { ThreadControlGrantRepository } from "../../persistence/Services/ThreadControlGrants.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import * as TerminalManager from "../../terminal/Manager.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ThreadDeletionReactor } from "../Services/ThreadDeletionReactor.ts";
import {
  logCleanupCauseUnlessInterrupted,
  ThreadDeletionReactorLive,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});

effectIt.effect("revokes durable controller authority when its thread is deleted", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("deleted-durable-controller-thread");
    const cleanupStarted = yield* Deferred.make<void>();
    const revokedGrants: ThreadId[] = [];
    const revokedProfiles: Array<readonly [ThreadId, string]> = [];
    const stoppedProviderSessions: ThreadId[] = [];
    const closedTerminalSessions: ThreadId[] = [];
    const deletedEvent = {
      sequence: 1,
      eventId: EventId.make("event-durable-controller-thread-deleted"),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: "2026-08-16T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.deleted",
      payload: {
        threadId,
        deletedAt: "2026-08-16T00:00:00.000Z",
      },
    } satisfies Extract<OrchestrationEvent, { type: "thread.deleted" }>;
    const revokeProfile = vi
      .spyOn(McpSessionRegistry, "revokeActiveMcpThreadProfile")
      .mockImplementation((revokedThreadId, profileKind) =>
        Effect.sync(() => {
          revokedProfiles.push([revokedThreadId, profileKind]);
        }),
      );

    const layer = ThreadDeletionReactorLive.pipe(
      Layer.provideMerge(
        Layer.mock(OrchestrationEngineService)({
          subscribeDomainEvents: Effect.succeed(Stream.make(deletedEvent)),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ThreadControlGrantRepository)({
          revoke: (revokedThreadId) =>
            Effect.sync(() => {
              revokedGrants.push(revokedThreadId);
            }).pipe(Effect.andThen(Deferred.succeed(cleanupStarted, undefined)), Effect.as(true)),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(ProviderService)({
          stopSession: ({ threadId: stoppedThreadId }) =>
            Effect.sync(() => {
              stoppedProviderSessions.push(stoppedThreadId);
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(TerminalManager.TerminalManager)({
          close: ({ threadId: closedThreadId }) =>
            Effect.sync(() => {
              closedTerminalSessions.push(ThreadId.make(closedThreadId));
            }),
        }),
      ),
    );

    yield* Effect.gen(function* () {
      const reactor = yield* ThreadDeletionReactor;
      yield* reactor.start();
      yield* Deferred.await(cleanupStarted);
      yield* reactor.drain;

      expect(revokedGrants).toEqual([threadId]);
      expect(revokedProfiles).toEqual([[threadId, "durable-thread-controller"]]);
      expect(stoppedProviderSessions).toEqual([threadId]);
      expect(closedTerminalSessions).toEqual([threadId]);
    }).pipe(
      Effect.provide(layer),
      Effect.scoped,
      Effect.ensuring(Effect.sync(() => revokeProfile.mockRestore())),
    );
  }),
);
