import { ThreadId, type EnvironmentId } from "@shuv2code/contracts";
import { stableStringify } from "@shuv2code/shared/relaySigning";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Option from "effect/Option";

import type { ControllerMcpRequestScope, McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import {
  ThreadControlInvocationError,
  ThreadControlInvocationResolver,
  type ThreadControlOperation,
} from "./Services/ThreadControlInvocationResolver.ts";
import type { ThreadControlExecutionCoordinatorShape } from "./Services/ThreadControlExecutionCoordinator.ts";
import type { ThreadControlGrantVerifierShape } from "./Services/ThreadControlGrantVerifier.ts";
import type { ThreadControlGrantRepositoryShape } from "../persistence/Services/ThreadControlGrants.ts";
import {
  ThreadControlError,
  type DurableThreadActionContext,
  type ThreadControlAuthorization,
} from "./Services/ThreadControlService.ts";

export interface DurableThreadControlInvocationResolverInput {
  readonly invocation: McpInvocationScope;
  readonly request: ControllerMcpRequestScope;
}

export interface DurableThreadControlInvocationResolverServices {
  readonly currentEnvironmentId: EnvironmentId;
  readonly projection: ProjectionSnapshotQuery["Service"];
  readonly threadControlGrants: ThreadControlGrantRepositoryShape;
  readonly crypto: Crypto.Crypto;
}

const mismatch = (message: string) =>
  new ThreadControlError({ code: "controller_mismatch", message });

const projectionFailure = () =>
  new ThreadControlError({
    code: "dispatch_failed",
    message: "The durable controller thread could not be revalidated.",
  });

export function makeDurableThreadControlInvocationResolver(
  input: DurableThreadControlInvocationResolverInput,
  services: DurableThreadControlInvocationResolverServices,
): ThreadControlInvocationResolver["Service"] {
  const { currentEnvironmentId, projection, threadControlGrants, crypto } = services;

  const requireProfile = Effect.fn("DurableThreadControlInvocationResolver.requireProfile")(
    function* () {
      const profile = input.invocation.profile;
      if (profile.kind !== "durable-thread-controller") {
        return yield* mismatch("A durable thread-controller credential is required.");
      }
      if (profile.providerIdentity === undefined) {
        return yield* mismatch("The controller credential is not bound to its provider thread.");
      }
      return profile;
    },
  );

  const readLiveController = Effect.fn("DurableThreadControlInvocationResolver.readLiveController")(
    function* () {
      const profile = yield* requireProfile();
      const persistedGrant = yield* threadControlGrants
        .getByThreadId(profile.controllerThreadId)
        .pipe(Effect.mapError(projectionFailure));
      if (
        Option.isNone(persistedGrant) ||
        persistedGrant.value.authorizedRuntimeCeiling !== profile.authorizedRuntimeCeiling ||
        persistedGrant.value.controlEnabled !== profile.controlEnabled
      ) {
        return yield* mismatch("The durable controller grant is no longer active.");
      }
      const controller = yield* projection
        .getThreadDetailById(profile.controllerThreadId)
        .pipe(Effect.mapError(projectionFailure));
      if (
        Option.isNone(controller) ||
        controller.value.purpose === "voice-transport" ||
        controller.value.deletedAt !== null ||
        controller.value.archivedAt !== null
      ) {
        return yield* mismatch("The granted durable controller thread is unavailable.");
      }
      if (controller.value.modelSelection.instanceId !== input.invocation.providerInstanceId) {
        return yield* mismatch("The controller grant is bound to a different provider instance.");
      }
      return controller.value;
    },
  );

  const authorize: ThreadControlGrantVerifierShape["authorize"] = Effect.fn(
    "DurableThreadControlGrantVerifier.authorize",
  )(function* (authorization, operation) {
    const profile = yield* requireProfile();
    if (
      input.invocation.environmentId !== currentEnvironmentId ||
      authorization.environmentId !== currentEnvironmentId
    ) {
      return yield* new ThreadControlError({
        code: "environment_mismatch",
        message: "The controller grant belongs to a different environment.",
      });
    }
    if (
      authorization.controllerThreadId !== profile.controllerThreadId ||
      authorization.providerInstanceId !== input.invocation.providerInstanceId
    ) {
      return yield* mismatch("The durable controller grant identity changed.");
    }
    if (!authorization.canRead || !input.invocation.capabilities.has("threads.read")) {
      return yield* new ThreadControlError({
        code: "read_disabled",
        message: "Thread reads are not granted to this durable controller.",
      });
    }
    if (
      operation === "control" &&
      (!authorization.canControl ||
        !profile.controlEnabled ||
        !input.invocation.capabilities.has("threads.control"))
    ) {
      return yield* new ThreadControlError({
        code: "control_disabled",
        message: "Thread control is not granted to this durable controller.",
      });
    }
    yield* readLiveController();
  });

  const readProviderTurnId = Effect.fn("DurableThreadControlInvocationResolver.readProviderTurnId")(
    function* () {
      const metadata = input.request.turnMetadata;
      if (metadata !== undefined) return metadata.turnId;

      // Codex supplies a trusted per-request turn envelope. Other providers call the
      // same authenticated controller endpoint without that Codex-specific metadata,
      // so use the active turn from the credential-bound controller thread instead.
      const controller = yield* readLiveController();
      const activeTurnId = controller.session?.activeTurnId ?? null;
      if (controller.session?.status !== "running" || activeTurnId === null) {
        return undefined;
      }
      return String(activeTurnId);
    },
  );

  const validateMutation: ThreadControlGrantVerifierShape["validateMutation"] = Effect.fn(
    "DurableThreadControlGrantVerifier.validateMutation",
  )(function* (authorization, action) {
    const providerTurnId = yield* readProviderTurnId();
    if (
      action.adapterKind !== "durable-thread" ||
      action.controllerThreadId !== authorization.controllerThreadId ||
      action.credentialId !== input.invocation.credentialId ||
      action.providerSessionId !== input.invocation.providerSessionId ||
      providerTurnId === undefined ||
      action.providerTurnId !== providerTurnId ||
      action.providerRequestId !== input.request.requestId
    ) {
      return yield* mismatch(
        "The durable controller action does not match this provider invocation.",
      );
    }
  });

  const verifier: ThreadControlGrantVerifierShape = { authorize, validateMutation };

  const requestHash = (canonicalRequest: string) =>
    crypto
      .digest("SHA-256", new TextEncoder().encode(canonicalRequest))
      .pipe(Effect.map(Encoding.encodeHex), Effect.mapError(projectionFailure));

  const execution: ThreadControlExecutionCoordinatorShape = {
    execute: Effect.fn("DurableThreadControlExecutionCoordinator.execute")(function* (mutation) {
      yield* mutation.revalidate;
      const canonicalRequestHash = yield* requestHash(mutation.canonicalRequest);
      return yield* mutation.dispatch({
        toolName: mutation.toolName,
        operation: mutation.operation,
        canonicalRequestHash,
      });
    }),
    setActiveTarget: () => Effect.void,
    clearActiveTargetIfMatching: () => Effect.void,
  };

  const resolveAuthorization = Effect.fn(
    "DurableThreadControlInvocationResolver.resolveAuthorization",
  )(function* (operation: ThreadControlOperation) {
    const profile = yield* requireProfile();
    const controller = yield* readLiveController();
    const authorization: ThreadControlAuthorization = {
      environmentId: input.invocation.environmentId,
      controllerThreadId: profile.controllerThreadId,
      providerInstanceId: input.invocation.providerInstanceId,
      authorizedRuntimeCeiling: profile.authorizedRuntimeCeiling,
      liveControllerRuntimeMode: controller.runtimeMode,
      bindingGeneration: 0,
      controlEpoch: 0,
      canRead: input.invocation.capabilities.has("threads.read"),
      canControl: profile.controlEnabled && input.invocation.capabilities.has("threads.control"),
    };
    yield* verifier.authorize(authorization, operation);
    return { authorization, verifier, execution };
  });

  const resolveMutation = Effect.fn("DurableThreadControlInvocationResolver.resolveMutation")(
    function* () {
      const grant = yield* resolveAuthorization("control");
      const providerTurnId = yield* readProviderTurnId();
      if (providerTurnId === undefined) {
        return yield* new ThreadControlInvocationError({
          code: "action_not_found",
          message: "The controller provider session has no active turn for this mutation.",
        });
      }
      const seed = stableStringify([
        input.invocation.credentialId,
        input.invocation.providerSessionId,
        providerTurnId,
        input.request.requestId,
      ]);
      const digest = yield* requestHash(seed);
      const actionId = `durable:${digest}`;
      const action: DurableThreadActionContext = {
        adapterKind: "durable-thread",
        actionId,
        operationIdPrefix: actionId,
        createdThreadId: ThreadId.make(`${actionId}:thread`),
        providerCreationId: `shuv2code/thread-controller/${digest}`,
        actorProvenance: {
          actorKind: "durable-thread-controller",
          controllerThreadId: grant.authorization.controllerThreadId,
          providerInstanceId: input.invocation.providerInstanceId,
          providerSessionId: input.invocation.providerSessionId,
          providerTurnId,
          providerRequestHash: digest,
        },
        controllerThreadId: grant.authorization.controllerThreadId,
        credentialId: input.invocation.credentialId,
        providerSessionId: input.invocation.providerSessionId,
        providerTurnId,
        providerRequestId: input.request.requestId,
      };
      yield* verifier.validateMutation(grant.authorization, action);
      return { grant, action };
    },
  );

  return ThreadControlInvocationResolver.of({ resolveAuthorization, resolveMutation });
}
