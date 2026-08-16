import { ProjectId, ThreadId, TurnId } from "@shuv2code/contracts";
import * as Effect from "effect/Effect";

import {
  ThreadControlError,
  ThreadControlService,
} from "../../../orchestration/Services/ThreadControlService.ts";
import { ThreadControlInvocationResolver } from "../../../orchestration/Services/ThreadControlInvocationResolver.ts";
import type {
  ThreadCreateInput,
  ThreadGetInput,
  ThreadInterruptInput,
  ThreadListInput,
  ThreadSendInput,
} from "./tools.ts";

const resolveAuthorization = Effect.fn("ThreadToolkit.resolveAuthorization")(function* (
  operation: "read" | "control",
) {
  const resolver = yield* ThreadControlInvocationResolver;
  return yield* resolver.resolveAuthorization(operation);
});

const requireAction = Effect.fn("ThreadToolkit.requireAction")(function* () {
  const resolver = yield* ThreadControlInvocationResolver;
  return yield* resolver.resolveMutation();
});

const parseCursor = (
  cursor: string | undefined,
): Effect.Effect<number | undefined, ThreadControlError> => {
  if (cursor === undefined) return Effect.succeed(undefined);
  if (!/^(0|[1-9]\d{0,8})$/.test(cursor)) {
    return Effect.fail(
      new ThreadControlError({
        code: "invalid_input",
        message: "The thread-list cursor is invalid.",
      }),
    );
  }
  return Effect.succeed(Number(cursor));
};

export const threadListHandler = Effect.fn("ThreadToolkit.thread_list")(function* (
  input: ThreadListInput,
) {
  const grant = yield* resolveAuthorization("read");
  const service = yield* ThreadControlService;
  const cursor = yield* parseCursor(input.cursor);
  const result = yield* service.list({
    grant,
    ...(input.projectQuery === undefined ? {} : { projectQuery: input.projectQuery }),
    ...(input.phase === undefined ? {} : { phase: input.phase }),
    ...(cursor === undefined ? {} : { cursor }),
  });
  return {
    ...result,
    nextCursor: result.nextCursor === null ? null : String(result.nextCursor),
  };
});

export const threadGetHandler = Effect.fn("ThreadToolkit.thread_get")(function* (
  input: ThreadGetInput,
) {
  const grant = yield* resolveAuthorization("read");
  const service = yield* ThreadControlService;
  return yield* service.get({
    grant,
    threadId: ThreadId.make(input.threadId),
    ...(input.includeUntrustedExcerpt === undefined
      ? {}
      : { includeUntrustedExcerpt: input.includeUntrustedExcerpt }),
  });
});

export const threadCreateHandler = Effect.fn("ThreadToolkit.thread_create")(function* (
  input: ThreadCreateInput,
) {
  const { action, grant } = yield* requireAction();
  const service = yield* ThreadControlService;
  return yield* service.create({
    grant,
    action,
    projectId: ProjectId.make(input.projectId),
    initialInstruction: input.initialInstruction,
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.model === undefined ? {} : { model: input.model }),
  });
});

export const threadSendHandler = Effect.fn("ThreadToolkit.thread_send")(function* (
  input: ThreadSendInput,
) {
  const { action, grant } = yield* requireAction();
  const service = yield* ThreadControlService;
  return input.disposition === "start"
    ? yield* service.send({
        grant,
        action,
        threadId: ThreadId.make(input.threadId),
        text: input.text,
        disposition: "start",
        expectedTurnId: null,
      })
    : yield* service.send({
        grant,
        action,
        threadId: ThreadId.make(input.threadId),
        text: input.text,
        disposition: "steer",
        expectedTurnId: TurnId.make(input.expectedTurnId),
      });
});

export const threadInterruptHandler = Effect.fn("ThreadToolkit.thread_interrupt")(function* (
  input: ThreadInterruptInput,
) {
  const { action, grant } = yield* requireAction();
  const service = yield* ThreadControlService;
  return yield* service.interrupt({
    grant,
    action,
    threadId: ThreadId.make(input.threadId),
    expectedTurnId: TurnId.make(input.expectedTurnId),
  });
});

export const threadHandlers = {
  thread_list: threadListHandler,
  thread_get: threadGetHandler,
  thread_create: threadCreateHandler,
  thread_send: threadSendHandler,
  thread_interrupt: threadInterruptHandler,
} as const;

export const __testing = {
  resolveAuthorization,
  requireAction,
  parseCursor,
};

export type ControllerThreadHandlerName = keyof typeof threadHandlers;

export const isControllerThreadHandlerName = (name: string): name is ControllerThreadHandlerName =>
  Object.hasOwn(threadHandlers, name);
