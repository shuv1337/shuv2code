/**
 * ProviderDynamicTools - session-scoped dynamic tool seam (ADE §3.1).
 *
 * A provider adapter that supports session-scoped dynamic tools exposes this
 * surface next to its `ProviderAdapterShape`. A caller (the ADE tool gate,
 * S6/#160) configures a per-thread tool catalog before the session starts,
 * consumes invocation signals one at a time through `takeSignal`, and settles
 * each call through `replyToCall`. Attribution is structural: every signal
 * carries the owning `threadId`, resolved from the session-owning connection.
 *
 * Signal lifecycle contract: every `requested` signal is eventually paired
 * with either a successful `replyToCall` by the consumer or a `cancelled`
 * signal (provider-side cancellation, or synthesized by the adapter when the
 * owning session context is torn down). A call is never `requested` twice
 * while it is outstanding; after a `cancelled`, a still-pending call may be
 * re-`requested` on the next attach.
 *
 * @module provider/Services/ProviderDynamicTools
 */
import type { ThreadId } from "@shuv2code/contracts";
import type * as Effect from "effect/Effect";

/** Upstream shuvcode constraint: `^[A-Za-z][A-Za-z0-9_-]{0,63}$`. */
export const PROVIDER_DYNAMIC_TOOL_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/** Upstream shuvcode reserves `execute` for the built-in code-mode tool. */
export const PROVIDER_DYNAMIC_TOOL_RESERVED_NAMES: ReadonlySet<string> = new Set(["execute"]);

export interface ProviderDynamicToolDefinition {
  readonly name: string;
  readonly description: string;
  /** Raw JSON Schema for the tool input. Defaults to an empty object schema. */
  readonly parameters?: Readonly<Record<string, unknown>>;
}

export interface ProviderDynamicToolCall {
  readonly threadId: ThreadId;
  readonly callId: string;
  readonly tool: string;
  readonly input: unknown;
  /** ISO timestamp of the provider-side dispatch, when known. */
  readonly requestedAt?: string;
}

export type ProviderDynamicToolResult =
  | { readonly status: "completed"; readonly content: string }
  | { readonly status: "failed"; readonly message: string };

export type ProviderDynamicToolSignal =
  | { readonly kind: "requested"; readonly call: ProviderDynamicToolCall }
  | { readonly kind: "cancelled"; readonly threadId: ThreadId; readonly callId: string }
  /**
   * The model emitted a tool call whose arguments were not valid JSON, so the
   * provider never executed it. There is no `callId` to settle — nothing was
   * ever dispatched — which is exactly why this needs its own variant: the
   * consumer's only useful response is to count it and, past a threshold, say
   * the model cannot call tools instead of watching it loop.
   */
  | { readonly kind: "input-malformed"; readonly threadId: ThreadId; readonly tool: string };

export interface ProviderDynamicToolThreadConfig {
  readonly tools: ReadonlyArray<ProviderDynamicToolDefinition>;
  /**
   * Ownership-tagging metadata passed through to the provider session at
   * creation. Immutable after the provider session exists.
   */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ProviderDynamicToolsShape<TError> {
  /**
   * Set the thread's session-scoped tool catalog. Configured before
   * `startSession` it rides session creation (with `metadata`); configured
   * while the session is live it replace-sets the registered tools
   * (`metadata` cannot change on a live session and is ignored there) and
   * drains provider-side pending calls into the signal feed.
   */
  readonly configureThread: (input: {
    readonly threadId: ThreadId;
    readonly tools: ReadonlyArray<ProviderDynamicToolDefinition>;
    readonly metadata?: Readonly<Record<string, unknown>>;
  }) => Effect.Effect<void, TError>;

  /** Drop the thread's configuration and clear tools on the live session, if any. */
  readonly clearThread: (threadId: ThreadId) => Effect.Effect<void, TError>;

  /** Provider-authoritative registered tool set for a live session. */
  readonly listTools: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ProviderDynamicToolDefinition>, TError>;

  /** In-flight invocations awaiting a reply on a live session. */
  readonly pendingCalls: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<ProviderDynamicToolCall>, TError>;

  /** Settle one invocation with the owning caller's result. */
  readonly replyToCall: (input: {
    readonly threadId: ThreadId;
    readonly callId: string;
    readonly result: ProviderDynamicToolResult;
  }) => Effect.Effect<void, TError>;

  /**
   * Take the next dispatch signal across all threads. Single-consumer,
   * blocking, in-order, lossless: the adapter buffers signals until they are
   * taken, so a late or restarted consumer misses nothing. Re-attach drains
   * provider-side pending calls into this feed before live events flow,
   * deduplicated by call id against outstanding (not-yet-settled) calls.
   */
  readonly takeSignal: Effect.Effect<ProviderDynamicToolSignal>;
}

/**
 * Validate a tool catalog against the upstream constraints so misconfigured
 * catalogs fail fast at the seam instead of surfacing as provider 400s.
 * Returns the first violation, or null for a valid catalog.
 */
export function findProviderDynamicToolCatalogIssue(
  tools: ReadonlyArray<ProviderDynamicToolDefinition>,
): string | null {
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!PROVIDER_DYNAMIC_TOOL_NAME_PATTERN.test(tool.name)) {
      return `Dynamic tool name '${tool.name}' must match ${String(PROVIDER_DYNAMIC_TOOL_NAME_PATTERN)}.`;
    }
    if (PROVIDER_DYNAMIC_TOOL_RESERVED_NAMES.has(tool.name)) {
      return `Dynamic tool name '${tool.name}' is reserved.`;
    }
    if (seen.has(tool.name)) {
      return `Dynamic tool name '${tool.name}' is duplicated.`;
    }
    seen.add(tool.name);
  }
  return null;
}
