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

it("gives ordinary and controller profiles stable provider-facing server names", () => {
  const threadId = ThreadId.make("provider-session-names");
  const base = {
    credentialId: "credential",
    environmentId: EnvironmentId.make("environment-1"),
    threadId,
    providerSessionId: "provider-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
    endpoint: "http://127.0.0.1/mcp",
    authorizationHeader: "Bearer token",
  };

  expect(
    McpProviderSession.getMcpProviderSessionName({
      ...base,
      profile: { kind: "standard-provider" },
    }),
  ).toBe("shuv2code");
  expect(
    McpProviderSession.getMcpProviderSessionName({
      ...base,
      profile: {
        kind: "durable-thread-controller",
        controllerThreadId: threadId,
        providerIdentity: undefined,
        authorizedRuntimeCeiling: "full-access",
        controlEnabled: true,
      },
    }),
  ).toBe("shuv2code_controller");

  const standard = {
    ...base,
    profile: { kind: "standard-provider" as const },
  };
  const controller = {
    ...base,
    credentialId: "controller-credential",
    endpoint: "http://127.0.0.1/mcp/controller",
    authorizationHeader: "Bearer controller-token",
    profile: {
      kind: "durable-thread-controller" as const,
      controllerThreadId: threadId,
      providerIdentity: undefined,
      authorizedRuntimeCeiling: "full-access" as const,
      controlEnabled: true,
    },
  };
  expect(McpProviderSession.toNamedHttpMcpServers([standard, controller])).toEqual({
    shuv2code: {
      type: "http",
      url: "http://127.0.0.1/mcp",
      headers: { Authorization: "Bearer token" },
    },
    shuv2code_controller: {
      type: "http",
      url: "http://127.0.0.1/mcp/controller",
      headers: { Authorization: "Bearer controller-token" },
    },
  });
  expect(McpProviderSession.toAcpHttpMcpServers([standard, controller])).toEqual([
    {
      type: "http",
      name: "shuv2code",
      url: "http://127.0.0.1/mcp",
      headers: [{ name: "Authorization", value: "Bearer token" }],
    },
    {
      type: "http",
      name: "shuv2code_controller",
      url: "http://127.0.0.1/mcp/controller",
      headers: [{ name: "Authorization", value: "Bearer controller-token" }],
    },
  ]);
});
