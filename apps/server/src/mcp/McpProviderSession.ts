import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@shuv2code/contracts";
import type { McpCredentialProfile } from "./McpInvocationContext.ts";

export interface McpProviderSessionConfig {
  readonly credentialId: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly profile: McpCredentialProfile;
  readonly endpoint: string;
  readonly authorizationHeader: string;
}

const sessionsByThread = new Map<ThreadId, ReadonlyArray<McpProviderSessionConfig>>();

export function setMcpProviderSession(config: McpProviderSessionConfig): void {
  const current = sessionsByThread.get(config.threadId) ?? [];
  sessionsByThread.set(config.threadId, [
    ...current.filter((entry) => entry.profile.kind !== config.profile.kind),
    config,
  ]);
}

export function readMcpProviderSession(threadId: ThreadId): McpProviderSessionConfig | undefined {
  const sessions = sessionsByThread.get(threadId);
  return sessions?.find((entry) => entry.profile.kind === "standard-provider") ?? sessions?.[0];
}

export function readMcpProviderSessions(
  threadId: ThreadId,
): ReadonlyArray<McpProviderSessionConfig> {
  return sessionsByThread.get(threadId) ?? [];
}

export function clearMcpProviderSession(threadId: ThreadId): void {
  sessionsByThread.delete(threadId);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
