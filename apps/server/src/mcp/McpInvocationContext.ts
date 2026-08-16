import {
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type RuntimeMode,
  type ThreadId,
  type VoiceRuntimeInstanceId,
} from "@shuv2code/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type StandardMcpCapability = "preview" | "automations";
export type ControllerMcpCapability = "threads.read" | "threads.control";
export type McpCapability = StandardMcpCapability | ControllerMcpCapability;

export interface StandardProviderMcpProfile {
  readonly kind: "standard-provider";
}

export interface VoiceControllerMcpProfile {
  readonly kind: "voice-controller";
  readonly controllerThreadId: ThreadId;
  readonly runtimeInstanceId: VoiceRuntimeInstanceId;
  readonly providerIdentity:
    | {
        readonly codexProviderThreadId: string;
      }
    | undefined;
  readonly scope: {
    readonly kind: "managed-codex-environment";
    readonly environmentId: EnvironmentId;
  };
  readonly authorizedRuntimeCeiling: RuntimeMode;
  readonly liveControllerRuntimeMode: RuntimeMode;
  readonly controlEpoch: number;
}

export type McpCredentialProfile = StandardProviderMcpProfile | VoiceControllerMcpProfile;

export interface McpInvocationScope {
  readonly credentialId: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly profile: McpCredentialProfile;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export interface CodexControllerTurnMetadata {
  readonly turnId: string;
  readonly sessionId: string;
  readonly threadId: ThreadId;
  readonly turnStartedAtUnixMs?: number | undefined;
}

/**
 * Per-request transport context for the controller endpoint.
 *
 * Unlike `McpInvocationContext`, this value is never derived from the bearer
 * token and is never retained between requests. It contains only the bounded
 * allowlist extracted from Codex's trusted `x-codex-turn-metadata` envelope.
 */
export interface ControllerMcpRequestScope {
  readonly turnMetadata: CodexControllerTurnMetadata | undefined;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("shuv2code/mcp/McpInvocationContext") {}

export class ControllerMcpRequestContext extends Context.Service<
  ControllerMcpRequestContext,
  ControllerMcpRequestScope
>()("shuv2code/mcp/McpInvocationContext/ControllerMcpRequestContext") {}

export const requireMcpCapability = Effect.fn("mcp.requireCapability")(function* (
  capability: StandardMcpCapability,
) {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has(capability)) {
    return yield* new PreviewAutomationUnavailableError({
      capability,
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});

export class ControllerMcpCapabilityUnavailableError extends Schema.TaggedErrorClass<ControllerMcpCapabilityUnavailableError>()(
  "ControllerMcpCapabilityUnavailableError",
  {
    capability: Schema.Literals(["threads.read", "threads.control"]),
  },
) {}

export const requireControllerMcpCapability = Effect.fn("mcp.requireControllerCapability")(
  function* (capability: ControllerMcpCapability) {
    const invocation = yield* McpInvocationContext;
    if (!invocation.capabilities.has(capability)) {
      return yield* new ControllerMcpCapabilityUnavailableError({ capability });
    }
    return invocation;
  },
);
