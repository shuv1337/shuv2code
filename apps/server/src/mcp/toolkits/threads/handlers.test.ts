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

import { VoiceControllerBindingRepository } from "../../../persistence/Services/VoiceControllerBindings.ts";
import { VoiceControllerBinding } from "../../../persistence/VoiceControlModels.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { __testing } from "./handlers.ts";

const environmentId = EnvironmentId.make("environment-controller-handler-test");
const controllerThreadId = ThreadId.make("controller-thread-handler-test");
const providerInstanceId = ProviderInstanceId.make("codex");

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

const provideAuthorizationServices = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  bindings: VoiceControllerBindingRepository["Service"],
) =>
  effect.pipe(
    Effect.provideService(McpInvocationContext, invocation),
    Effect.provideService(VoiceControllerBindingRepository, bindings),
    Effect.provide(
      ServerSettings.layerTest({
        enableVoiceThreadRead: true,
        enableVoiceThreadControl: true,
      }),
    ),
  );

it.effect("passes the live binding generation into thread-control authorization", () =>
  Effect.gen(function* () {
    const authorization = yield* provideAuthorizationServices(
      __testing.resolveAuthorization("read"),
      makeBindings(6, 23),
    );

    expect(authorization.bindingGeneration).toBe(23);
    expect(authorization.controlEpoch).toBe(6);
    expect(authorization.authorizedRuntimeCeiling).toBe("auto-accept-edits");
    expect(authorization.canRead).toBe(true);
    expect(authorization.canControl).toBe(true);
  }),
);

it.effect("allows reads but rejects mutations from a stale control epoch", () =>
  Effect.gen(function* () {
    const bindings = makeBindings(7, 24);
    const readAuthorization = yield* provideAuthorizationServices(
      __testing.resolveAuthorization("read"),
      bindings,
    );
    expect(readAuthorization.bindingGeneration).toBe(24);
    expect(readAuthorization.canControl).toBe(false);

    const error = yield* provideAuthorizationServices(
      Effect.flip(__testing.resolveAuthorization("control")),
      bindings,
    );
    expect(error.code).toBe("control_disabled");
    expect(error.message).toContain("stale control epoch");
  }),
);
