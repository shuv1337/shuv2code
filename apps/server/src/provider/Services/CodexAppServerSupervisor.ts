import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { CodexAppServerClient } from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";

export type CodexAppServerTopology = "per-session" | "shared";

/**
 * Identity material for one supervised Codex app-server process.
 *
 * Process identity (`binaryPath` + `codexHome` + `launchArgs` + the
 * supervisor-resolved realtime enablement) determines the private control
 * socket. `cwd`/`environment` are spawn parameters and `runtimeDir` is socket
 * placement — they are not part of the identity, so they must be deterministic
 * per provider instance.
 */
export interface CodexAppServerSupervisorKey {
  readonly binaryPath: string;
  /** Resolved Codex home. An empty string selects the ambient default home. */
  readonly codexHome: string;
  readonly launchArgs: string;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeDir: string;
}

/** One issued connection to a supervised shared Codex app-server process. */
export interface CodexAppServerConnection {
  readonly client: CodexAppServerClient["Service"];
  /**
   * Resolves exactly once when this connection's transport terminates —
   * socket close, transport failure, or supervised process exit.
   */
  readonly terminated: Effect.Effect<CodexErrors.CodexAppServerError>;
}

export interface CodexAppServerSupervisorShape {
  readonly topology: CodexAppServerTopology;
  /**
   * Realtime conversation enablement decided once per supervised process from
   * the resolved voice policy at supervisor construction. Per-session flags
   * never influence shared launch identity.
   */
  readonly sharedRealtimeEnabled: boolean;
  /**
   * Issue one client connection to the shared process for `key`, spawning it
   * on first acquisition. Fails closed under `per-session` topology; callers
   * must keep spawning their own child in that mode.
   */
  readonly acquireConnection: (
    key: CodexAppServerSupervisorKey,
  ) => Effect.Effect<CodexAppServerConnection, CodexErrors.CodexAppServerError, Scope.Scope>;
}

export class CodexAppServerSupervisor extends Context.Service<
  CodexAppServerSupervisor,
  CodexAppServerSupervisorShape
>()("shuv2code/provider/Services/CodexAppServerSupervisor") {}
