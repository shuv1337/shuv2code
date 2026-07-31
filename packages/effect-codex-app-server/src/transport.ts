import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";
import type * as Stdio from "effect/Stdio";

import type * as CodexError from "./errors.ts";
import type {
  CodexAppServerIncomingNotification,
  CodexAppServerIncomingRequest,
  CodexAppServerPatchedProtocol,
  CodexAppServerProtocolLogEvent,
} from "./protocol.ts";

/**
 * Framed JSON-RPC transport used by CodexAppServerClient. Stdio is newline-
 * delimited JSON; Unix WebSocket is one JSON-RPC message per text frame.
 */
export interface CodexAppServerFramedTransportOptions {
  readonly logIncoming?: boolean;
  readonly logOutgoing?: boolean;
  readonly logger?: (event: CodexAppServerProtocolLogEvent) => Effect.Effect<void, never>;
  readonly terminationError?: Effect.Effect<CodexError.CodexAppServerError>;
  readonly onNotification: (
    notification: CodexAppServerIncomingNotification,
  ) => Effect.Effect<void, never>;
  readonly onRequest: (
    request: CodexAppServerIncomingRequest,
  ) => Effect.Effect<unknown, CodexError.CodexAppServerError>;
}

export type CodexAppServerFramedProtocol = CodexAppServerPatchedProtocol;

export type MakeFramedProtocol = (
  options: CodexAppServerFramedTransportOptions & {
    readonly stdio: Stdio.Stdio;
  },
) => Effect.Effect<CodexAppServerFramedProtocol, never, Scope.Scope>;
