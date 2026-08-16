import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  VoiceRuntimeInstanceId,
} from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { ThreadControlInvocationResolver } from "../../../orchestration/Services/ThreadControlInvocationResolver.ts";
import { ThreadControlService } from "../../../orchestration/Services/ThreadControlService.ts";
import { VoiceControllerBindingRepository } from "../../../persistence/Services/VoiceControllerBindings.ts";
import { VoiceControllerBinding } from "../../../persistence/VoiceControlModels.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { ControllerActionContextResolver } from "../../../voice/Services/ControllerActionContextResolver.ts";
import { makeVoiceThreadControlInvocationResolver } from "../../../voice/VoiceThreadControlInvocationResolver.ts";
import { threadListHandler } from "./handlers.ts";

const environmentId = EnvironmentId.make("environment-controller-handler-test");
const controllerThreadId = ThreadId.make("controller-thread-handler-test");
const providerInstanceId = ProviderInstanceId.make("codex");
const verifier = {
  authorize: () => Effect.void,
  validateMutation: () => Effect.void,
};
const execution = {
  execute: () => Effect.die("unused"),
  setActiveTarget: () => Effect.void,
  clearActiveTargetIfMatching: () => Effect.void,
};

const invocation = {
  credentialId: "credential-handler-test",
  environmentId,
  threadId: controllerThreadId,
  providerSessionId: "mcp-session-handler-test",
  providerInstanceId,
  profile: {
    kind: "voice-controller" as const,
    controllerThreadId,
    runtimeInstanceId: VoiceRuntimeInstanceId.make("runtime-handler-test"),
    providerIdentity: { codexProviderThreadId: "codex-thread-handler-test" },
    scope: { kind: "managed-codex-environment" as const, environmentId },
    authorizedRuntimeCeiling: "full-access" as const,
    liveControllerRuntimeMode: "full-access" as const,
    controlEpoch: 6,
  },
  capabilities: new Set(["threads.read", "threads.control"] as const),
  issuedAt: 1,
};

const makeBindings = (controlEpoch: number, bindingGeneration: number) =>
  VoiceControllerBindingRepository.of({
    reserve: () => Effect.die("unused"),
    getByEnvironmentId: () => Effect.die("unused"),
    getByControllerThreadId: () =>
      Effect.succeed(
        Option.some(
          VoiceControllerBinding.make({
            environmentId,
            controllerThreadId,
            activeTargetThreadId: null,
            hostProjectId: ProjectId.make("controller-host-project"),
            providerInstanceId,
            authorizedRuntimeCeiling: "auto-accept-edits",
            bindingGeneration,
            controlEpoch,
            state: "active",
            createdAt: "2026-07-30T00:00:00.000Z",
            updatedAt: "2026-07-30T00:00:00.000Z",
          }),
        ),
      ),
    compareAndSetState: () => Effect.die("unused"),
    rotateControlEpoch: () => Effect.die("unused"),
    incrementControlEpoch: () => Effect.die("unused"),
    setActiveTarget: () => Effect.die("unused"),
    clearActiveTargetIfMatches: () => Effect.die("unused"),
    deleteResetting: () => Effect.die("unused"),
  });

const makeResolver = (bindings: VoiceControllerBindingRepository["Service"]) =>
  Effect.gen(function* () {
    const settingsService = yield* ServerSettings.ServerSettingsService;
    return makeVoiceThreadControlInvocationResolver({
      invocation,
      request: { turnMetadata: undefined },
      settingsService,
      bindingRepository: bindings,
      actionResolver: ControllerActionContextResolver.of({ resolve: () => Effect.die("unused") }),
      verifier,
      execution,
    });
  }).pipe(
    Effect.provide(
      ServerSettings.layerTest({
        enableVoiceThreadRead: true,
        enableVoiceThreadControl: true,
      }),
    ),
  );

it.effect("passes the live binding generation into thread-control authorization", () =>
  Effect.gen(function* () {
    const resolver = yield* makeResolver(makeBindings(6, 23));
    const { authorization } = yield* resolver.resolveAuthorization("read");

    expect(authorization.bindingGeneration).toBe(23);
    expect(authorization.controlEpoch).toBe(6);
    expect(authorization.authorizedRuntimeCeiling).toBe("auto-accept-edits");
    expect(authorization.canRead).toBe(true);
    expect(authorization.canControl).toBe(true);
  }),
);

it.effect("allows reads but rejects mutations from a stale control epoch", () =>
  Effect.gen(function* () {
    const resolver = yield* makeResolver(makeBindings(7, 24));
    const { authorization: readAuthorization } = yield* resolver.resolveAuthorization("read");
    expect(readAuthorization.bindingGeneration).toBe(24);
    expect(readAuthorization.canControl).toBe(false);

    const error = yield* Effect.flip(resolver.resolveAuthorization("control"));
    expect(error.code).toBe("control_disabled");
    expect(error.message).toContain("stale control epoch");
  }),
);

it.effect("runs the canonical thread toolkit against an app-level invocation resolver", () =>
  Effect.gen(function* () {
    const authorization = {
      environmentId,
      controllerThreadId,
      providerInstanceId,
      authorizedRuntimeCeiling: "approval-required" as const,
      liveControllerRuntimeMode: "approval-required" as const,
      bindingGeneration: 1,
      controlEpoch: 1,
      canRead: true,
      canControl: false,
    };
    const grant = { authorization, verifier, execution };
    const resolver = ThreadControlInvocationResolver.of({
      resolveAuthorization: () => Effect.succeed(grant),
      resolveMutation: () => Effect.die("unused"),
    });
    const threadControl = ThreadControlService.of({
      list: (input) =>
        Effect.succeed({
          snapshotSequence: input.grant.authorization.bindingGeneration,
          projects: [],
          threads: [],
          nextCursor: null,
        }),
      get: () => Effect.die("unused"),
      create: () => Effect.die("unused"),
      send: () => Effect.die("unused"),
      interrupt: () => Effect.die("unused"),
    });

    const result = yield* threadListHandler({}).pipe(
      Effect.provideService(ThreadControlInvocationResolver, resolver),
      Effect.provideService(ThreadControlService, threadControl),
    );

    expect(result).toEqual({
      snapshotSequence: 1,
      projects: [],
      threads: [],
      nextCursor: null,
    });
  }),
);
