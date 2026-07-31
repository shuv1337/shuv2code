import { ProjectId, ThreadId, TurnId } from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  ThreadControlError,
  ThreadControlService,
  type ThreadControlAuthorization,
} from "../../../orchestration/Services/ThreadControlService.ts";
import { VoiceControllerBindingRepository } from "../../../persistence/Services/VoiceControllerBindings.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import {
  ControllerActionContextError,
  ControllerActionContextResolver,
} from "../../../voice/Services/ControllerActionContextResolver.ts";
import {
  ControllerMcpRequestContext,
  McpInvocationContext,
  type McpInvocationScope,
  requireControllerMcpCapability,
} from "../../McpInvocationContext.ts";
import type {
  ThreadCreateInput,
  ThreadGetInput,
  ThreadInterruptInput,
  ThreadListInput,
  ThreadSendInput,
} from "./tools.ts";

const controllerAuthorizationError = (message: string) =>
  new ThreadControlError({
    code: "controller_mismatch",
    message,
  });

const settingsFailure = () =>
  new ThreadControlError({
    code: "dispatch_failed",
    message: "The live voice-control policy could not be read.",
  });

const bindingFailure = () =>
  new ThreadControlError({
    code: "dispatch_failed",
    message: "The live controller binding could not be verified.",
  });

const requireControllerInvocation = Effect.fn("ThreadToolkit.requireControllerInvocation")(
  function* () {
    const invocation = yield* McpInvocationContext;
    if (invocation.profile.kind !== "voice-controller") {
      return yield* controllerAuthorizationError(
        "A designated voice-controller credential is required.",
      );
    }
    return { ...invocation, profile: invocation.profile };
  },
);

const resolveAuthorization = Effect.fn("ThreadToolkit.resolveAuthorization")(function* (
  operation: "read" | "control",
) {
  const invocation = yield* requireControllerInvocation();
  yield* requireControllerMcpCapability("threads.read").pipe(
    Effect.mapError(() => controllerAuthorizationError("Voice thread reads are not granted.")),
  );

  const settingsService = yield* ServerSettings.ServerSettingsService;
  const settings = yield* settingsService.getSettings.pipe(Effect.mapError(settingsFailure));
  const policy = ServerSettings.resolveVoiceControlPolicy(settings);
  if (!policy.read) {
    return yield* new ThreadControlError({
      code: "read_disabled",
      message: "Voice thread reads are disabled by live server policy.",
    });
  }

  const bindings = yield* VoiceControllerBindingRepository;
  const binding = yield* bindings
    .getByControllerThreadId(invocation.profile.controllerThreadId)
    .pipe(Effect.mapError(bindingFailure));
  if (Option.isNone(binding)) {
    return yield* controllerAuthorizationError("The controller designation is no longer active.");
  }
  if (
    binding.value.environmentId !== invocation.environmentId ||
    binding.value.controllerThreadId !== invocation.profile.controllerThreadId ||
    binding.value.providerInstanceId !== invocation.providerInstanceId ||
    binding.value.state === "resetting"
  ) {
    return yield* controllerAuthorizationError(
      "The controller credential does not match the live designation.",
    );
  }

  const epochMatches = binding.value.controlEpoch === invocation.profile.controlEpoch;
  const credentialControls = invocation.capabilities.has("threads.control");
  const canControl = policy.control && credentialControls && epochMatches;
  if (operation === "control" && !canControl) {
    return yield* new ThreadControlError({
      code: "control_disabled",
      message: epochMatches
        ? "Voice thread control is disabled by live server policy."
        : "This controller credential belongs to a stale control epoch.",
    });
  }

  return {
    environmentId: invocation.environmentId,
    controllerThreadId: invocation.profile.controllerThreadId,
    providerInstanceId: invocation.providerInstanceId,
    authorizedRuntimeCeiling: binding.value.authorizedRuntimeCeiling,
    liveControllerRuntimeMode: invocation.profile.liveControllerRuntimeMode,
    bindingGeneration: binding.value.bindingGeneration,
    controlEpoch: binding.value.controlEpoch,
    canRead: true,
    canControl,
  } satisfies ThreadControlAuthorization;
});

const requireAction = Effect.fn("ThreadToolkit.requireAction")(function* () {
  // Live policy and epoch are checked first so a disabled write cannot reserve
  // or resolve an action context.
  const authorization = yield* resolveAuthorization("control");
  const invocation = yield* requireControllerInvocation();
  const request = yield* ControllerMcpRequestContext;
  const metadata = request.turnMetadata;
  if (metadata === undefined) {
    return yield* new ControllerActionContextError({
      code: "action_not_found",
      message: "Trusted Codex turn metadata is required for controller mutations.",
    });
  }
  const resolver = yield* ControllerActionContextResolver;
  const action = yield* resolver.resolve({
    controllerThreadId: invocation.profile.controllerThreadId,
    controllerRuntimeInstanceId: invocation.profile.runtimeInstanceId,
    codexProviderThreadId: metadata.threadId,
    providerTurnId: TurnId.make(metadata.turnId),
  });
  return { authorization, action };
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
  const authorization = yield* resolveAuthorization("read");
  const service = yield* ThreadControlService;
  const cursor = yield* parseCursor(input.cursor);
  const result = yield* service.list({
    authorization,
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
  const authorization = yield* resolveAuthorization("read");
  const service = yield* ThreadControlService;
  return yield* service.get({
    authorization,
    threadId: ThreadId.make(input.threadId),
    ...(input.includeUntrustedExcerpt === undefined
      ? {}
      : { includeUntrustedExcerpt: input.includeUntrustedExcerpt }),
  });
});

export const threadCreateHandler = Effect.fn("ThreadToolkit.thread_create")(function* (
  input: ThreadCreateInput,
) {
  const { action, authorization } = yield* requireAction();
  const service = yield* ThreadControlService;
  return yield* service.create({
    authorization,
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
  const { action, authorization } = yield* requireAction();
  const service = yield* ThreadControlService;
  return input.disposition === "start"
    ? yield* service.send({
        authorization,
        action,
        threadId: ThreadId.make(input.threadId),
        text: input.text,
        disposition: "start",
        expectedTurnId: null,
      })
    : yield* service.send({
        authorization,
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
  const { action, authorization } = yield* requireAction();
  const service = yield* ThreadControlService;
  return yield* service.interrupt({
    authorization,
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
  requireControllerInvocation,
  resolveAuthorization,
  requireAction,
  parseCursor,
};

export type ControllerThreadHandlerName = keyof typeof threadHandlers;

export const isControllerThreadHandlerName = (name: string): name is ControllerThreadHandlerName =>
  Object.hasOwn(threadHandlers, name);

export function invocationHasBoundProviderIdentity(invocation: McpInvocationScope): boolean {
  return (
    invocation.profile.kind === "voice-controller" &&
    invocation.profile.providerIdentity !== undefined
  );
}
