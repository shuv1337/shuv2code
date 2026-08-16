import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@shuv2code/contracts";

import * as McpProviderSession from "./McpProviderSession.ts";

it("clears one profile without disturbing the thread's ordinary provider session", () => {
  const threadId = ThreadId.make("provider-profile-clear");
  const base = {
    environmentId: EnvironmentId.make("environment-1"),
    threadId,
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "http://127.0.0.1/mcp",
    authorizationHeader: "Bearer token",
  };

  McpProviderSession.setMcpProviderSession({
    ...base,
    credentialId: "standard-credential",
    providerSessionId: "standard-session",
    profile: { kind: "standard-provider" },
  });
  McpProviderSession.setMcpProviderSession({
    ...base,
    credentialId: "controller-credential",
    providerSessionId: "controller-session",
    profile: {
      kind: "durable-thread-controller",
      controllerThreadId: threadId,
      providerIdentity: undefined,
      authorizedRuntimeCeiling: "full-access",
      controlEnabled: true,
    },
  });

  McpProviderSession.clearMcpProviderSessionProfile(threadId, "durable-thread-controller");

  expect(McpProviderSession.readMcpProviderSessions(threadId)).toHaveLength(1);
  expect(McpProviderSession.readMcpProviderSession(threadId)?.profile.kind).toBe(
    "standard-provider",
  );
  McpProviderSession.clearMcpProviderSession(threadId);
});
