import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

import type { CodexAppServerClient } from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";

export type CodexAppServerTopology = "per-session" | "shared";

export interface CodexAppServerSupervisorKey {
  readonly binaryPath: string;
  readonly codexHome: string;
  readonly launchArgs: string;
  readonly enableRealtimeConversation: boolean;
  readonly cwd: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly runtimeDir: string;
}

export interface CodexAppServerSupervisorShape {
  readonly topology: CodexAppServerTopology;
  /**
   * Issue one initialized client connection. Shared topology reuses a process
   * per key; per-session topology is a no-op passthrough (caller still spawns).
   */
  readonly acquireConnection: (
    key: CodexAppServerSupervisorKey,
  ) => Effect.Effect<CodexAppServerClient["Service"], CodexErrors.CodexAppServerError, Scope.Scope>;
}

export class CodexAppServerSupervisor extends Context.Service<
  CodexAppServerSupervisor,
  CodexAppServerSupervisorShape
>()("shuv2code/provider/Services/CodexAppServerSupervisor") {}
