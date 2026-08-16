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

export function getMcpProviderSessionName(config: McpProviderSessionConfig): string {
  return config.profile.kind === "standard-provider" ? "shuv2code" : "shuv2code_controller";
}

export function toNamedHttpMcpServers(sessions: ReadonlyArray<McpProviderSessionConfig>): Record<
  string,
  {
    readonly type: "http";
    readonly url: string;
    readonly headers: { readonly Authorization: string };
  }
> {
  return Object.fromEntries(
    sessions.map((session) => [
      getMcpProviderSessionName(session),
      {
        type: "http" as const,
        url: session.endpoint,
        headers: { Authorization: session.authorizationHeader },
      },
    ]),
  );
}

export function toAcpHttpMcpServers(sessions: ReadonlyArray<McpProviderSessionConfig>) {
  return sessions.map((session) => ({
    type: "http" as const,
    name: getMcpProviderSessionName(session),
    url: session.endpoint,
    headers: [{ name: "Authorization", value: session.authorizationHeader }],
  }));
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

export function clearMcpProviderSessionProfile(
  threadId: ThreadId,
  profileKind: McpCredentialProfile["kind"],
): void {
  const current = sessionsByThread.get(threadId);
  if (!current) return;
  const next = current.filter((entry) => entry.profile.kind !== profileKind);
  if (next.length === 0) {
    sessionsByThread.delete(threadId);
    return;
  }
  sessionsByThread.set(threadId, next);
}

export function clearAllMcpProviderSessions(): void {
  sessionsByThread.clear();
}
