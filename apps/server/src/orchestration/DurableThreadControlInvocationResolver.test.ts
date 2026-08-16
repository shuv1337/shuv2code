import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerEnvironment } from "../environment/ServerEnvironment.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import type { ThreadControlGrantRepositoryShape } from "../persistence/Services/ThreadControlGrants.ts";
import { makeDurableThreadControlInvocationResolver } from "./DurableThreadControlInvocationResolver.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const environmentId = EnvironmentId.make("durable-controller-environment");
const controllerThreadId = ThreadId.make("durable-controller-thread");
const providerInstanceId = ProviderInstanceId.make("codex");

const makeThreadControlGrants = (
  read: () => boolean = () => true,
): ThreadControlGrantRepositoryShape => ({
  getByThreadId: () =>
    Effect.succeed(
      read()
        ? Option.some({
            threadId: controllerThreadId,
            authorizedRuntimeCeiling: "auto-accept-edits",
            controlEnabled: true,
            createdAt: "2026-08-16T00:00:00.000Z",
            updatedAt: "2026-08-16T00:00:00.000Z",
          })
        : Option.none(),
    ),
  upsert: () => Effect.die("unused"),
  revoke: () => Effect.die("unused"),
});

const invocation: McpInvocationScope = {
  credentialId: "credential-1",
  environmentId,
  threadId: controllerThreadId,
  providerSessionId: "mcp-session-1",
  providerInstanceId,
  profile: {
    kind: "durable-thread-controller",
    controllerThreadId,
    providerIdentity: { providerThreadId: "provider-thread-1" },
    authorizedRuntimeCeiling: "auto-accept-edits",
    controlEnabled: true,
  },
  capabilities: new Set(["threads.read", "threads.control"]),
  issuedAt: 1,
};

const services = Layer.mergeAll(
  Layer.succeed(
    ServerEnvironment,
    ServerEnvironment.of({
      getEnvironmentId: Effect.succeed(environmentId),
      getDescriptor: Effect.die("unused"),
    }),
  ),
  Layer.mock(ProjectionSnapshotQuery)({
    getThreadDetailById: () =>
      Effect.succeed(
        Option.some({
          purpose: "standard",
          deletedAt: null,
          archivedAt: null,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5.6" },
          runtimeMode: "auto-accept-edits",
        } as never),
      ),
  }),
  NodeServices.layer,
);

it.effect("derives one stable durable action per provider turn and MCP request", () =>
  Effect.gen(function* () {
    const projection = yield* ProjectionSnapshotQuery;
    const crypto = yield* Crypto.Crypto;
    const threadControlGrants = makeThreadControlGrants();
    const make = (requestId: string) =>
      makeDurableThreadControlInvocationResolver(
        {
          invocation,
          request: {
            requestId,
            turnMetadata: {
              turnId: "turn-1",
              sessionId: "provider-thread-1",
              threadId: ThreadId.make("provider-thread-1"),
            },
          },
        },
        { currentEnvironmentId: environmentId, projection, threadControlGrants, crypto },
      );

    const first = yield* make("request-1").resolveMutation();
    const replay = yield* make("request-1").resolveMutation();
    const second = yield* make("request-2").resolveMutation();

    expect(first.action).toMatchObject({
      adapterKind: "durable-thread",
      controllerThreadId,
      credentialId: "credential-1",
      providerSessionId: "mcp-session-1",
      providerTurnId: "turn-1",
      providerRequestId: "request-1",
    });
    expect(replay.action.actionId).toBe(first.action.actionId);
    expect(second.action.actionId).not.toBe(first.action.actionId);
  }).pipe(Effect.provide(services)),
);

it.effect("does not reinterpret an ordinary provider credential as a controller grant", () =>
  Effect.gen(function* () {
    const projection = yield* ProjectionSnapshotQuery;
    const crypto = yield* Crypto.Crypto;
    const threadControlGrants = makeThreadControlGrants();
    const resolver = makeDurableThreadControlInvocationResolver(
      {
        invocation: {
          ...invocation,
          profile: { kind: "standard-provider" },
          capabilities: new Set(["preview", "automations"]),
        },
        request: { requestId: "request-1", turnMetadata: undefined },
      },
      { currentEnvironmentId: environmentId, projection, threadControlGrants, crypto },
    );
    const result = yield* Effect.exit(resolver.resolveAuthorization("read"));
    expect(result._tag).toBe("Failure");
  }).pipe(Effect.provide(services)),
);

it.effect("rejects an in-flight mutation after its durable grant is revoked", () =>
  Effect.gen(function* () {
    const projection = yield* ProjectionSnapshotQuery;
    const crypto = yield* Crypto.Crypto;
    let granted = true;
    const resolver = makeDurableThreadControlInvocationResolver(
      {
        invocation,
        request: {
          requestId: "request-revoked",
          turnMetadata: {
            turnId: "turn-1",
            sessionId: "provider-thread-1",
            threadId: ThreadId.make("provider-thread-1"),
          },
        },
      },
      {
        currentEnvironmentId: environmentId,
        projection,
        threadControlGrants: makeThreadControlGrants(() => granted),
        crypto,
      },
    );
    const mutation = yield* resolver.resolveMutation();

    granted = false;
    const result = yield* Effect.exit(
      mutation.grant.verifier.authorize(mutation.grant.authorization, "control"),
    );

    expect(result._tag).toBe("Failure");
  }).pipe(Effect.provide(services)),
);
