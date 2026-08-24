/**
 * ADE tool gate (spec `docs/ade/ADE-V1-SPEC.md` §3.1–3.2, issue #160).
 *
 * One gate, two kernel backends:
 *
 * - **Codex**: the gate emits the per-session `dynamicTools` specs for
 *   `thread/start` / restored on `thread/resume`, and manufactures the
 *   per-session `AdeCodexToolCallHandler` that the S5 adapter registers.
 * - **shuvcode**: the gate configures per-thread catalogs through the
 *   OpenCodeV2 `ProviderDynamicToolsShape` seam and owns the seam's single
 *   `takeSignal` consumer loop.
 *
 * **Attribution is structural** (spec §3.1): each kernel bridge is created for
 * exactly one {bot, session} principal, and invocations arrive on the
 * session-owning connection/thread. Dispatch resolves {bot, session} from
 * that registration — no credential exists anywhere in the tool plane.
 *
 * **Inline checks, no policy engine** (spec §3.2): the gate runs plain-code
 * checks per tool — routing target allowed, assignment ownership, Screenbox
 * eligibility — through the `AdeToolInlineChecks` / `AdeScreenboxToolPlane`
 * seams and turns refusals into typed denials returned to the model as
 * ordinary failed tool results. The default check layers fail closed until
 * S7 (assignment engine) and S14 (Screenbox) provide real backends.
 *
 * **Approvals are structurally absent** (spec §3.2): no approval operation is
 * in the catalog, handler surface, or Screenbox namespace, and the gate
 * refuses to dispatch — or ever register — any approval-shaped name
 * (`ADE_APPROVAL_NAME_PATTERN`). Captain approvals live only on the client
 * surface (WS + `ade:approve` scope, ADR §10.4).
 *
 * Tool behavior itself belongs to later tickets: S7 (assignments/fleet) and
 * S8 (memory) plug real implementations in via `AdeToolHandlers.layer*`
 * without touching this gate; until then every handler returns a typed
 * `AdeToolNotYetAvailableError`.
 */
import {
  AdeProjectId,
  AssignmentId,
  AssignmentTerminalStatus,
  ArtifactRef,
  AssignmentInstruction,
  AssignmentResultSummary,
  BotId,
  DeclaredRisk,
  KernelSessionId,
  MemoryDocumentContent,
  TrimmedNonEmptyString,
  type BotExecutionBindingPurpose,
  type KernelEngine,
  type ThreadId,
} from "@shuv2code/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import type {
  AdeCodexDynamicToolSpec,
  AdeCodexToolCallHandler,
  AdeCodexToolCallResult,
} from "./AdeCodexKernelAdapter.ts";
import {
  findProviderDynamicToolCatalogIssue,
  type ProviderDynamicToolCall,
  type ProviderDynamicToolResult,
  type ProviderDynamicToolsShape,
} from "../provider/Services/ProviderDynamicTools.ts";

// ---------------------------------------------------------------------------
// Principals & call context
// ---------------------------------------------------------------------------

/** The structural identity a kernel bridge is created for: one bot, one session. */
export interface AdeToolSessionPrincipal {
  readonly botId: BotId;
  readonly purpose: BotExecutionBindingPurpose;
}

/** Resolved caller of one tool invocation — derived, never client-supplied. */
export interface AdeToolCallContext extends AdeToolSessionPrincipal {
  readonly engine: KernelEngine;
  readonly sessionId: KernelSessionId;
  readonly tool: string;
  readonly callId?: string;
}

// ---------------------------------------------------------------------------
// Approval boundary (spec §3.2 — structural absence)
// ---------------------------------------------------------------------------

/**
 * No bot-reachable surface may name an approval operation. Any tool name
 * matching this pattern is rejected at registration time and treated as
 * unknown at dispatch time — even if a future seam tried to smuggle one in.
 *
 * Intent, not mechanism: the structural guarantee is that approvals have no
 * tool-plane surface at all — captain approvals live on the client surface
 * (WS + `ade:approve`, ADR §10.4), and the §4.7 two-phase verbal
 * `prepare_approval`/`commit_approval` pair is a captain-channel voice plane
 * (S16), deliberately not part of this gate. This denylist is V1
 * defense-in-depth on top of that absence. It only catches names containing
 * "approv"; if S14 upstream ever ships approval-adjacent desktop tool names
 * (e.g. `desktop_authorize`), revisit the pattern alongside that catalog.
 */
export const ADE_APPROVAL_NAME_PATTERN = /approv/i;

// ---------------------------------------------------------------------------
// Denials & outcomes
// ---------------------------------------------------------------------------

export type AdeToolDenial =
  | { readonly _tag: "unknown-tool"; readonly tool: string }
  | { readonly _tag: "invalid-input"; readonly tool: string; readonly issue: string }
  | {
      readonly _tag: "routing-target-not-allowed";
      readonly tool: string;
      readonly targetBotId: BotId;
      readonly reason: string;
    }
  | {
      readonly _tag: "assignment-not-owned";
      readonly tool: string;
      readonly assignmentId: AssignmentId;
      readonly reason: string;
    }
  | { readonly _tag: "screenbox-not-eligible"; readonly tool: string; readonly reason: string }
  | { readonly _tag: "not-yet-available"; readonly tool: string };

/**
 * The result of one gated dispatch. Never an Effect failure: every path —
 * success, typed denial, handler failure — returns to the model as an
 * ordinary tool result so a bot can read the refusal.
 */
export type AdeToolOutcome =
  | { readonly _tag: "completed"; readonly content: string }
  | { readonly _tag: "denied"; readonly denial: AdeToolDenial }
  | { readonly _tag: "failed"; readonly message: string };

/** Model-facing rendering of a denial: machine-greppable tag + human reason. */
export const renderAdeToolDenial = (denial: AdeToolDenial): string => {
  switch (denial._tag) {
    case "unknown-tool":
      return `[ade:unknown-tool] Tool '${denial.tool}' is not available to this session.`;
    case "invalid-input":
      return `[ade:invalid-input] Invalid input for '${denial.tool}': ${denial.issue}`;
    case "routing-target-not-allowed":
      return `[ade:routing-target-not-allowed] '${denial.tool}' may not target bot '${denial.targetBotId}': ${denial.reason}`;
    case "assignment-not-owned":
      return `[ade:assignment-not-owned] '${denial.tool}' refused for assignment '${denial.assignmentId}': ${denial.reason}`;
    case "screenbox-not-eligible":
      return `[ade:screenbox-not-eligible] '${denial.tool}' refused: ${denial.reason}`;
    case "not-yet-available":
      return `[ade:not-yet-available] Tool '${denial.tool}' is not available in this build yet.`;
  }
};

/**
 * Model-facing rendering of a non-success outcome. `failed` carries the same
 * machine-greppable `[ade:…]` marker shape as denials.
 */
export const renderAdeToolOutcomeFailure = (
  outcome: Exclude<AdeToolOutcome, { _tag: "completed" }>,
): string =>
  outcome._tag === "denied"
    ? renderAdeToolDenial(outcome.denial)
    : `[ade:failed] ${outcome.message}`;

// ---------------------------------------------------------------------------
// Handler seam errors (S7/S8 handlers fail with these)
// ---------------------------------------------------------------------------

/** Placeholder failure until the owning ticket (S7/S8/S14) plugs a handler in. */
export class AdeToolNotYetAvailableError extends Schema.TaggedErrorClass<AdeToolNotYetAvailableError>()(
  "AdeToolNotYetAvailableError",
  {
    tool: Schema.String,
  },
) {
  override get message(): string {
    return `ADE tool '${this.tool}' has no handler wired yet.`;
  }
}

/** Bound on how much handler-supplied failure detail may reach the model. */
export const ADE_TOOL_FAILURE_DETAIL_MAX_LENGTH = 2_000;

/**
 * Scrub handler-supplied failure detail before it becomes model-visible:
 * strip control characters (which can smuggle terminal escapes / protocol
 * noise into a tool result) and bound the length.
 */
export const sanitizeAdeToolFailureDetail = (detail: string): string => {
  // eslint-disable-next-line no-control-regex -- stripping controls is the point
  const scrubbed = detail.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, " ");
  return scrubbed.length <= ADE_TOOL_FAILURE_DETAIL_MAX_LENGTH
    ? scrubbed
    : `${scrubbed.slice(0, ADE_TOOL_FAILURE_DETAIL_MAX_LENGTH)}… (truncated)`;
};

/** Domain failure raised by a real handler; `detail` is model-visible (scrubbed + bounded). */
export class AdeToolExecutionError extends Schema.TaggedErrorClass<AdeToolExecutionError>()(
  "AdeToolExecutionError",
  {
    tool: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `ADE tool '${this.tool}' failed: ${sanitizeAdeToolFailureDetail(this.detail)}`;
  }
}

export type AdeToolHandlerError = AdeToolNotYetAvailableError | AdeToolExecutionError;

/** A handler returns the model-visible result content (plain text or JSON). */
export type AdeToolHandler<I> = (
  ctx: AdeToolCallContext,
  input: I,
) => Effect.Effect<string, AdeToolHandlerError>;

// ---------------------------------------------------------------------------
// V1 base catalog (spec §3.1/§4.2/§4.7) — input schemas
// ---------------------------------------------------------------------------

export const FleetReadInput = Schema.Struct({
  /** Optional narrowing; omitted → whole-fleet snapshot. */
  projectId: Schema.optionalKey(AdeProjectId),
});
export type FleetReadInput = typeof FleetReadInput.Type;

export const CreateAssignmentInput = Schema.Struct({
  recipientBotId: BotId,
  instruction: AssignmentInstruction,
  declaredRisk: Schema.optionalKey(DeclaredRisk),
  projectId: Schema.optionalKey(AdeProjectId),
  parentAssignmentId: Schema.optionalKey(AssignmentId),
  idempotencyKey: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CreateAssignmentInput = typeof CreateAssignmentInput.Type;

export const SteerPrimaryInput = Schema.Struct({
  targetBotId: BotId,
  text: TrimmedNonEmptyString,
});
export type SteerPrimaryInput = typeof SteerPrimaryInput.Type;

export const ReportAssignmentResultInput = Schema.Struct({
  assignmentId: AssignmentId,
  status: AssignmentTerminalStatus,
  summary: AssignmentResultSummary,
  artifacts: Schema.optionalKey(Schema.Array(ArtifactRef)),
});
export type ReportAssignmentResultInput = typeof ReportAssignmentResultInput.Type;

export const UpdateMemoryInput = Schema.Struct({
  content: MemoryDocumentContent,
});
export type UpdateMemoryInput = typeof UpdateMemoryInput.Type;

// ---------------------------------------------------------------------------
// Handler seam (S7 assignments/fleet, S8 memory plug in here)
// ---------------------------------------------------------------------------

export interface AdeToolHandlersShape {
  readonly fleetRead: AdeToolHandler<FleetReadInput>;
  readonly createAssignment: AdeToolHandler<CreateAssignmentInput>;
  readonly steerPrimary: AdeToolHandler<SteerPrimaryInput>;
  readonly reportAssignmentResult: AdeToolHandler<ReportAssignmentResultInput>;
  readonly updateMemory: AdeToolHandler<UpdateMemoryInput>;
}

const unavailableHandler =
  <I>(): AdeToolHandler<I> =>
  (ctx) =>
    Effect.fail(new AdeToolNotYetAvailableError({ tool: ctx.tool }));

/** Every handler refuses with a typed not-yet-available failure. */
export const adeToolHandlersUnavailable: AdeToolHandlersShape = {
  fleetRead: unavailableHandler(),
  createAssignment: unavailableHandler(),
  steerPrimary: unavailableHandler(),
  reportAssignmentResult: unavailableHandler(),
  updateMemory: unavailableHandler(),
};

/**
 * Handler seam. Idempotency contract: the gate's shuvcode re-request dedupe
 * (see `runShuvcodeDispatchLoop`) is **in-memory only** — after a process
 * restart a re-requested call that already executed will execute again.
 * Handlers (S7 assignments, S8 memory, S14 Screenbox forward) therefore
 * remain responsible for their own durable idempotency (e.g. assignment
 * `idempotencyKey`, last-write-wins memory replace).
 */
export class AdeToolHandlers extends Context.Service<AdeToolHandlers, AdeToolHandlersShape>()(
  "shuv2code/ade/AdeToolGate/AdeToolHandlers",
) {
  /** Default until S7/S8 land: registration+dispatch work, behavior does not. */
  static readonly layerUnavailable = Layer.succeed(AdeToolHandlers, adeToolHandlersUnavailable);
  /**
   * Patch-style partial override: spreads `overrides` over the service
   * provided underneath, so S7 and S8 each wire only their own slice and the
   * layers stack (`layerPartial(s7) ∘ layerPartial(s8) ∘ layerUnavailable`)
   * without reverting each other to not-yet-available.
   */
  static layerPartial(
    overrides: Partial<AdeToolHandlersShape>,
  ): Layer.Layer<AdeToolHandlers, never, AdeToolHandlers> {
    return Layer.effect(
      AdeToolHandlers,
      Effect.gen(function* () {
        const base = yield* AdeToolHandlers;
        return { ...base, ...overrides };
      }),
    );
  }
}

// ---------------------------------------------------------------------------
// Inline-check seams (spec §3.2 — plain code, fail closed by default)
// ---------------------------------------------------------------------------

export type AdeInlineCheckDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export interface AdeToolInlineChecksShape {
  /** May `caller` route work/steering at `targetBotId`? (structural role rules + project allow-list) */
  readonly isRoutingTargetAllowed: (input: {
    readonly caller: AdeToolCallContext;
    readonly targetBotId: BotId;
  }) => Effect.Effect<AdeInlineCheckDecision>;
  /** Is `assignmentId` currently owned (assigned-to) by the calling bot? */
  readonly isAssignmentOwnedBy: (input: {
    readonly caller: AdeToolCallContext;
    readonly assignmentId: AssignmentId;
  }) => Effect.Effect<AdeInlineCheckDecision>;
}

export class AdeToolInlineChecks extends Context.Service<
  AdeToolInlineChecks,
  AdeToolInlineChecksShape
>()("shuv2code/ade/AdeToolGate/AdeToolInlineChecks") {
  /** Fail-closed defaults until the S7 assignment engine provides real data. */
  static readonly layerFailClosed = Layer.succeed(AdeToolInlineChecks, {
    isRoutingTargetAllowed: () =>
      Effect.succeed({
        allowed: false,
        reason: "routing rules are not available yet (assignment engine not built)",
      } as const),
    isAssignmentOwnedBy: () =>
      Effect.succeed({
        allowed: false,
        reason: "assignment ownership is not available yet (assignment engine not built)",
      } as const),
  });
}

// ---------------------------------------------------------------------------
// Screenbox seam (spec §4.6 — S14 provides the backend)
// ---------------------------------------------------------------------------

/** All Screenbox-proxied tools live under this reserved name prefix. */
export const ADE_SCREENBOX_TOOL_PREFIX = "desktop_";

export type AdeScreenboxEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: string };

export interface AdeToolDefinition {
  readonly name: string;
  readonly description: string;
  /** Raw JSON Schema for the tool input. */
  readonly parameters: Readonly<Record<string, unknown>>;
}

export interface AdeScreenboxToolPlaneShape {
  /** Operate-only tool defs for this principal ([] when computer use is off). */
  readonly toolsFor: (
    principal: AdeToolSessionPrincipal,
  ) => Effect.Effect<ReadonlyArray<AdeToolDefinition>>;
  /** Screenbox eligibility inline check (per-bot computerUse, runtime health). */
  readonly eligibility: (ctx: AdeToolCallContext) => Effect.Effect<AdeScreenboxEligibility>;
  /** Forward one eligible invocation to the Screenbox runtime. */
  readonly forward: (
    ctx: AdeToolCallContext,
    input: unknown,
  ) => Effect.Effect<string, AdeToolHandlerError>;
}

export class AdeScreenboxToolPlane extends Context.Service<
  AdeScreenboxToolPlane,
  AdeScreenboxToolPlaneShape
>()("shuv2code/ade/AdeToolGate/AdeScreenboxToolPlane") {
  /** Screenbox does not exist yet (S14): no tools, never eligible. */
  static readonly layerNotEligible = Layer.succeed(AdeScreenboxToolPlane, {
    toolsFor: () => Effect.succeed([]),
    eligibility: () =>
      Effect.succeed({
        eligible: false,
        reason: "Screenbox runtime is not available in this build",
      } as const),
    forward: (ctx) => Effect.fail(new AdeToolNotYetAvailableError({ tool: ctx.tool })),
  });
}

// ---------------------------------------------------------------------------
// Base catalog wiring
// ---------------------------------------------------------------------------

type AdeInlineCheckSpec =
  | { readonly kind: "none" }
  | { readonly kind: "routing-target"; readonly target: (input: never) => BotId }
  | { readonly kind: "assignment-ownership"; readonly assignment: (input: never) => AssignmentId };

interface AdeBaseToolSpec<I> {
  readonly definition: AdeToolDefinition;
  readonly decode: (input: unknown) => Effect.Effect<I, Schema.SchemaError>;
  readonly check: AdeInlineCheckSpec;
  readonly run: (handlers: AdeToolHandlersShape) => AdeToolHandler<I>;
}

const baseTool = <I>(spec: AdeBaseToolSpec<I>): AdeBaseToolSpec<unknown> =>
  spec as unknown as AdeBaseToolSpec<unknown>;

const BOT_ID_PARAM = { type: "string", minLength: 1 } as const;

/**
 * The V1 ADE base tool catalog (spec §4.2/§4.7 shared toolkit). Screenbox
 * `desktop_*` tools are appended per-principal by `AdeScreenboxToolPlane`.
 */
const ADE_BASE_TOOLS: ReadonlyArray<AdeBaseToolSpec<unknown>> = [
  baseTool({
    definition: {
      name: "fleet_read",
      description:
        "Read the current fleet snapshot: bots, their assignments and statuses. Optionally narrowed to one project.",
      parameters: {
        type: "object",
        properties: { projectId: { type: "string", minLength: 1 } },
        additionalProperties: false,
      },
    },
    decode: Schema.decodeUnknownEffect(FleetReadInput),
    check: { kind: "none" },
    run: (handlers) => handlers.fleetRead,
  }),
  baseTool({
    definition: {
      name: "create_assignment",
      description:
        "Create an assignment for another bot. Queued FIFO on the recipient; completion is delivered back as structured synthetic input.",
      parameters: {
        type: "object",
        properties: {
          recipientBotId: BOT_ID_PARAM,
          instruction: { type: "string", minLength: 1 },
          declaredRisk: { type: "string", enum: ["mechanical", "normal", "protected"] },
          projectId: { type: "string", minLength: 1 },
          parentAssignmentId: { type: "string", minLength: 1 },
          idempotencyKey: { type: "string", minLength: 1 },
        },
        required: ["recipientBotId", "instruction"],
        additionalProperties: false,
      },
    },
    decode: Schema.decodeUnknownEffect(CreateAssignmentInput),
    check: {
      kind: "routing-target",
      target: (input: CreateAssignmentInput) => input.recipientBotId,
    },
    run: (handlers) => handlers.createAssignment,
  }),
  baseTool({
    definition: {
      name: "steer_primary",
      description:
        "Steer another bot's active primary session with a short redirection. Never interrupts (steer is not cancel).",
      parameters: {
        type: "object",
        properties: {
          targetBotId: BOT_ID_PARAM,
          text: { type: "string", minLength: 1 },
        },
        required: ["targetBotId", "text"],
        additionalProperties: false,
      },
    },
    decode: Schema.decodeUnknownEffect(SteerPrimaryInput),
    check: { kind: "routing-target", target: (input: SteerPrimaryInput) => input.targetBotId },
    run: (handlers) => handlers.steerPrimary,
  }),
  baseTool({
    definition: {
      name: "report_assignment_result",
      description:
        "Report the structured result of an assignment you own: terminal status, bounded summary, typed artifact references.",
      parameters: {
        type: "object",
        properties: {
          assignmentId: { type: "string", minLength: 1 },
          status: { type: "string", enum: ["completed", "failed", "cancelled"] },
          summary: { type: "string" },
          artifacts: { type: "array", items: { type: "object" } },
        },
        required: ["assignmentId", "status", "summary"],
        additionalProperties: false,
      },
    },
    decode: Schema.decodeUnknownEffect(ReportAssignmentResultInput),
    check: {
      kind: "assignment-ownership",
      assignment: (input: ReportAssignmentResultInput) => input.assignmentId,
    },
    run: (handlers) => handlers.reportAssignmentResult,
  }),
  baseTool({
    definition: {
      name: "update_memory",
      description:
        "Replace your bounded memory document. Writes apply to the calling bot only — memory is tool-mediated and per-bot.",
      parameters: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
        additionalProperties: false,
      },
    },
    decode: Schema.decodeUnknownEffect(UpdateMemoryInput),
    check: { kind: "none" },
    run: (handlers) => handlers.updateMemory,
  }),
];

const ADE_BASE_TOOLS_BY_NAME: ReadonlyMap<string, AdeBaseToolSpec<unknown>> = new Map(
  ADE_BASE_TOOLS.map((spec) => [spec.definition.name, spec]),
);

/** Names of the V1 base catalog, exported for tests and callers. */
export const ADE_BASE_TOOL_NAMES: ReadonlyArray<string> = ADE_BASE_TOOLS.map(
  (spec) => spec.definition.name,
);

// Construction-time invariants: the base catalog must be registrable on both
// kernels and must not be able to name an approval operation.
{
  const issue = findProviderDynamicToolCatalogIssue(
    ADE_BASE_TOOLS.map((spec) => ({ ...spec.definition })),
  );
  if (issue !== null) {
    throw new Error(`ADE base tool catalog is invalid: ${issue}`);
  }
  for (const name of ADE_BASE_TOOLS_BY_NAME.keys()) {
    if (ADE_APPROVAL_NAME_PATTERN.test(name)) {
      throw new Error(`ADE base tool catalog must not name an approval operation: '${name}'`);
    }
  }
}

/**
 * Filter seam-supplied Screenbox defs down to registrable, prefix-correct,
 * non-approval, non-colliding names. Anything else is dropped (the seam is
 * data, not authority — the gate decides what a bot can reach).
 */
const sanitizeScreenboxDefinitions = (
  definitions: ReadonlyArray<AdeToolDefinition>,
): ReadonlyArray<AdeToolDefinition> => {
  const accepted: Array<AdeToolDefinition> = [];
  const seen = new Set<string>();
  for (const definition of definitions) {
    if (!definition.name.startsWith(ADE_SCREENBOX_TOOL_PREFIX)) continue;
    if (ADE_APPROVAL_NAME_PATTERN.test(definition.name)) continue;
    if (ADE_BASE_TOOLS_BY_NAME.has(definition.name) || seen.has(definition.name)) continue;
    if (findProviderDynamicToolCatalogIssue([definition]) !== null) continue;
    seen.add(definition.name);
    accepted.push(definition);
  }
  return accepted;
};

// ---------------------------------------------------------------------------
// Gate service
// ---------------------------------------------------------------------------

export interface AdeShuvcodeAttachOptions {
  readonly threadId: ThreadId;
  /**
   * The kernel-native session id (shuvcode `openCodeSessionId`) recorded on
   * the `BotExecutionBinding` — NOT the shuv2code `ThreadId`. S7/S8 binding
   * lookups key on this, so the caller supplies it from the adapter.
   */
  readonly sessionId: KernelSessionId;
  readonly principal: AdeToolSessionPrincipal;
}

/**
 * A shuvcode thread is already attached for a different principal. Detach
 * first; the gate refuses to silently re-attribute a live thread.
 */
export class AdeShuvcodeAttachConflictError extends Schema.TaggedErrorClass<AdeShuvcodeAttachConflictError>()(
  "AdeShuvcodeAttachConflictError",
  {
    threadId: Schema.String,
    attachedBotId: Schema.String,
    requestedBotId: Schema.String,
  },
) {
  override get message(): string {
    return `shuvcode thread '${this.threadId}' is already attached for bot '${this.attachedBotId}'; refusing re-attach for bot '${this.requestedBotId}'.`;
  }
}

/** Bound on remembered executed-call outcomes per thread (re-request dedupe). */
export const ADE_SETTLED_CALLS_PER_THREAD_LIMIT = 256;

export interface AdeShuvcodeLoopOptions {
  /**
   * Recognize the seam's benign already-settled reply conflict (structured
   * 409) so a race between provider-side cancellation and our reply is not
   * treated as a failure. Defaults to `status === 409` on the error object.
   */
  readonly isBenignReplyConflict?: (error: unknown) => boolean;
}

export interface AdeToolGateShape {
  /** Full model-visible catalog for one principal (base + Screenbox tools). */
  readonly catalogFor: (
    principal: AdeToolSessionPrincipal,
  ) => Effect.Effect<ReadonlyArray<AdeToolDefinition>>;

  /**
   * The single dispatch layer (spec §3.2): resolve the tool, validate input,
   * run the inline checks, invoke the handler. Total — every path returns an
   * `AdeToolOutcome`; handler defects are contained as `failed`.
   */
  readonly dispatch: (ctx: AdeToolCallContext, input: unknown) => Effect.Effect<AdeToolOutcome>;

  // -- Codex backend (S5 adapter seam) --------------------------------------

  /** `dynamicTools` specs for `thread/start` for one principal. */
  readonly codexDynamicToolsFor: (
    principal: AdeToolSessionPrincipal,
  ) => Effect.Effect<ReadonlyArray<AdeCodexDynamicToolSpec>>;

  /**
   * The per-session `onToolCall` for `startThread`/`resumeThread`. The
   * returned handler is bound to `principal`; the session id is taken from
   * the invocation's owning thread (structural attribution).
   */
  readonly makeCodexToolCallHandler: (
    principal: AdeToolSessionPrincipal,
  ) => AdeCodexToolCallHandler;

  // -- shuvcode backend (OpenCodeV2 dynamic-tool seam) ----------------------

  /**
   * Register the principal's catalog on a shuvcode thread and record the
   * thread → binding for dispatch. Call before `startSession` (including
   * after restarts) so the catalog rides session creation. The binding is
   * recorded before the seam configure (which may drain pending calls into
   * the signal feed) and rolled back if the configure fails. Re-attaching
   * the same principal (restart path) is allowed and fences out dispatches
   * taken under the previous attach; re-attaching a different principal
   * fails with `AdeShuvcodeAttachConflictError`.
   */
  readonly attachShuvcodeThread: <E>(
    seam: ProviderDynamicToolsShape<E>,
    options: AdeShuvcodeAttachOptions,
  ) => Effect.Effect<void, E | AdeShuvcodeAttachConflictError>;

  /**
   * Record (or correct) a shuvcode thread's principal and kernel session id
   * **without touching the provider**.
   *
   * The kernel-native session id only exists after the session is created,
   * but the tool catalog has to be configured *before* creation to ride the
   * `session.create` payload. Re-running the full attach afterwards just to
   * correct the recorded id would push the catalog a second time — a live
   * `PUT /session/:id/tools` that is both redundant (the tools already rode
   * creation) and fatal on a kernel build without the dynamic-tool routes.
   * This is the local half of an attach, so the gate can attribute
   * invocations to the right {bot, session} even when the provider refuses
   * a catalog write.
   */
  readonly rebindShuvcodeSession: (
    options: AdeShuvcodeAttachOptions,
  ) => Effect.Effect<void, AdeShuvcodeAttachConflictError>;

  /** Drop the thread's catalog and binding; interrupts in-flight dispatches. */
  readonly detachShuvcodeThread: <E>(
    seam: ProviderDynamicToolsShape<E>,
    threadId: ThreadId,
  ) => Effect.Effect<void, E>;

  /**
   * Own the seam's single-consumer `takeSignal` loop: dispatch `requested`
   * signals (concurrently, one fiber per call), reply through the seam, and
   * interrupt in-flight dispatches on `cancelled` (interruption is forked so
   * a slow finalizer cannot stall the loop). Re-`requested` calls that
   * already executed replay the recorded outcome instead of re-running the
   * handler; that dedupe is in-memory only (see `AdeToolHandlers`).
   *
   * Run exactly ONCE per seam — `takeSignal` is destructive and there is no
   * runtime guard against a second concurrent consumer. Ends only with its
   * scope.
   */
  readonly runShuvcodeDispatchLoop: <E>(
    seam: ProviderDynamicToolsShape<E>,
    options?: AdeShuvcodeLoopOptions,
  ) => Effect.Effect<never>;
}

const defaultIsBenignReplyConflict = (error: unknown): boolean =>
  typeof error === "object" &&
  error !== null &&
  "status" in error &&
  (error as { status?: unknown }).status === 409;

const shuvcodeResultFor = (outcome: AdeToolOutcome): ProviderDynamicToolResult =>
  outcome._tag === "completed"
    ? { status: "completed", content: outcome.content }
    : { status: "failed", message: renderAdeToolOutcomeFailure(outcome) };

const codexResultFor = (outcome: AdeToolOutcome): AdeCodexToolCallResult =>
  outcome._tag === "completed"
    ? { success: true, contentItems: [{ type: "inputText", text: outcome.content }] }
    : {
        success: false,
        contentItems: [{ type: "inputText", text: renderAdeToolOutcomeFailure(outcome) }],
      };

export class AdeToolGate extends Context.Service<AdeToolGate, AdeToolGateShape>()(
  "shuv2code/ade/AdeToolGate",
) {
  static readonly layer: Layer.Layer<
    AdeToolGate,
    never,
    AdeToolHandlers | AdeToolInlineChecks | AdeScreenboxToolPlane
  > = Layer.effect(
    AdeToolGate,
    Effect.gen(function* () {
      const handlers = yield* AdeToolHandlers;
      const checks = yield* AdeToolInlineChecks;
      const screenbox = yield* AdeScreenboxToolPlane;
      return makeAdeToolGate({ handlers, checks, screenbox });
    }),
  );

  /** Fail-closed wiring: placeholder handlers, deny-by-default checks, no Screenbox. */
  static readonly layerFailClosed: Layer.Layer<AdeToolGate> = AdeToolGate.layer.pipe(
    Layer.provide(AdeToolHandlers.layerUnavailable),
    Layer.provide(AdeToolInlineChecks.layerFailClosed),
    Layer.provide(AdeScreenboxToolPlane.layerNotEligible),
  );
}

export interface MakeAdeToolGateOptions {
  readonly handlers: AdeToolHandlersShape;
  readonly checks: AdeToolInlineChecksShape;
  readonly screenbox: AdeScreenboxToolPlaneShape;
}

export const makeAdeToolGate = (options: MakeAdeToolGateOptions): AdeToolGateShape => {
  const { handlers, checks, screenbox } = options;

  const catalogFor: AdeToolGateShape["catalogFor"] = Effect.fn("AdeToolGate.catalogFor")(
    function* (principal) {
      const screenboxTools = sanitizeScreenboxDefinitions(yield* screenbox.toolsFor(principal));
      return [...ADE_BASE_TOOLS.map((spec) => spec.definition), ...screenboxTools];
    },
  );

  const runInlineCheck = (
    ctx: AdeToolCallContext,
    check: AdeInlineCheckSpec,
    input: unknown,
  ): Effect.Effect<AdeToolDenial | null> => {
    switch (check.kind) {
      case "none":
        return Effect.succeed(null);
      case "routing-target": {
        const targetBotId = check.target(input as never);
        return checks.isRoutingTargetAllowed({ caller: ctx, targetBotId }).pipe(
          Effect.map((decision) =>
            decision.allowed
              ? null
              : ({
                  _tag: "routing-target-not-allowed",
                  tool: ctx.tool,
                  targetBotId,
                  reason: decision.reason,
                } as const),
          ),
        );
      }
      case "assignment-ownership": {
        const assignmentId = check.assignment(input as never);
        return checks.isAssignmentOwnedBy({ caller: ctx, assignmentId }).pipe(
          Effect.map((decision) =>
            decision.allowed
              ? null
              : ({
                  _tag: "assignment-not-owned",
                  tool: ctx.tool,
                  assignmentId,
                  reason: decision.reason,
                } as const),
          ),
        );
      }
    }
  };

  const runToTotalOutcome = (
    effect: Effect.Effect<string, AdeToolHandlerError>,
    tool: string,
  ): Effect.Effect<AdeToolOutcome> =>
    effect.pipe(
      Effect.map((content): AdeToolOutcome => ({ _tag: "completed", content })),
      Effect.catchTags({
        AdeToolNotYetAvailableError: () =>
          Effect.succeed<AdeToolOutcome>({
            _tag: "denied",
            denial: { _tag: "not-yet-available", tool },
          }),
        AdeToolExecutionError: (error) =>
          Effect.succeed<AdeToolOutcome>({ _tag: "failed", message: error.message }),
      }),
      Effect.catchDefect((defect) =>
        Effect.logError("ADE tool handler defect", { tool, defect }).pipe(
          Effect.as<AdeToolOutcome>({
            _tag: "failed",
            message: `ADE tool '${tool}' failed with an internal error.`,
          }),
        ),
      ),
    );

  const dispatchUncontained = Effect.fn("AdeToolGate.dispatch")(function* (
    ctx: AdeToolCallContext,
    rawInput: unknown,
  ): Effect.fn.Return<AdeToolOutcome> {
    const tool = ctx.tool;
    // Approval operations are structurally absent from this plane: even a
    // name smuggled into a session catalog dispatches as unknown.
    if (ADE_APPROVAL_NAME_PATTERN.test(tool)) {
      return { _tag: "denied", denial: { _tag: "unknown-tool", tool } } as const;
    }
    if (tool.startsWith(ADE_SCREENBOX_TOOL_PREFIX)) {
      // Resolve against the principal's sanitized Screenbox catalog first:
      // names the sanitizer dropped — or that the model guessed — must get
      // the standard unknown-tool denial, never reach eligibility/forward.
      const screenboxTools = sanitizeScreenboxDefinitions(yield* screenbox.toolsFor(ctx));
      if (!screenboxTools.some((definition) => definition.name === tool)) {
        return { _tag: "denied", denial: { _tag: "unknown-tool", tool } } as const;
      }
      const eligibility = yield* screenbox.eligibility(ctx);
      if (!eligibility.eligible) {
        return {
          _tag: "denied",
          denial: { _tag: "screenbox-not-eligible", tool, reason: eligibility.reason },
        } as const;
      }
      return yield* runToTotalOutcome(screenbox.forward(ctx, rawInput), tool);
    }
    const spec = ADE_BASE_TOOLS_BY_NAME.get(tool);
    if (spec === undefined) {
      return { _tag: "denied", denial: { _tag: "unknown-tool", tool } } as const;
    }
    const decoded = yield* spec.decode(rawInput).pipe(Effect.result);
    if (Result.isFailure(decoded)) {
      return {
        _tag: "denied",
        denial: { _tag: "invalid-input", tool, issue: decoded.failure.message },
      } as const;
    }
    const denial = yield* runInlineCheck(ctx, spec.check, decoded.success);
    if (denial !== null) {
      return { _tag: "denied", denial } as const;
    }
    return yield* runToTotalOutcome(spec.run(handlers)(ctx, decoded.success), tool);
  });

  // Total by construction: defects from ANY step — inline checks, Screenbox
  // eligibility/toolsFor, input decode, handlers — are contained here so both
  // kernel bridges always settle the call instead of dying mid-request.
  const dispatch: AdeToolGateShape["dispatch"] = (ctx, rawInput) =>
    dispatchUncontained(ctx, rawInput).pipe(
      Effect.catchDefect((defect) =>
        Effect.logError("ADE tool dispatch defect", { tool: ctx.tool, defect }).pipe(
          Effect.as<AdeToolOutcome>({
            _tag: "failed",
            message: `ADE tool '${ctx.tool}' failed with an internal error.`,
          }),
        ),
      ),
    );

  // -- Codex backend --------------------------------------------------------

  const codexDynamicToolsFor: AdeToolGateShape["codexDynamicToolsFor"] = (principal) =>
    catalogFor(principal).pipe(
      Effect.map((catalog) =>
        catalog.map(
          (definition): AdeCodexDynamicToolSpec => ({
            type: "function",
            name: definition.name,
            description: definition.description,
            inputSchema: definition.parameters as Schema.Json,
          }),
        ),
      ),
    );

  const makeCodexToolCallHandler: AdeToolGateShape["makeCodexToolCallHandler"] =
    (principal) => (invocation) =>
      dispatch(
        {
          ...principal,
          engine: "codex",
          sessionId: KernelSessionId.make(invocation.threadId),
          tool: invocation.tool,
          callId: invocation.callId,
        },
        invocation.arguments,
      ).pipe(Effect.map(codexResultFor));

  // -- shuvcode backend -----------------------------------------------------

  interface ShuvcodeBinding {
    readonly principal: AdeToolSessionPrincipal;
    readonly sessionId: KernelSessionId;
    /** Fencing token: bumped on every attach, gone on detach. */
    readonly generation: number;
  }

  const shuvcodeBindings = new Map<ThreadId, ShuvcodeBinding>();
  let attachGenerationCounter = 0;
  const inFlight = new Map<string, Fiber.Fiber<void>>();
  const inFlightKey = (threadId: ThreadId, callId: string): string => `${threadId}\n${callId}`;
  /**
   * Executed-call outcomes per thread, insertion-ordered and bounded. S4
   * permits a still-pending call to be re-`requested` after `cancelled` (and
   * a benign 409 means our reply raced provider-side settlement) — without
   * this, a re-request would re-execute a call that already ran. In-memory
   * only: handler idempotency across restarts stays with S7/S8.
   */
  const settledCalls = new Map<ThreadId, Map<string, AdeToolOutcome>>();

  const recordSettledCall = (threadId: ThreadId, callId: string, outcome: AdeToolOutcome): void => {
    let forThread = settledCalls.get(threadId);
    if (forThread === undefined) {
      forThread = new Map();
      settledCalls.set(threadId, forThread);
    }
    while (forThread.size >= ADE_SETTLED_CALLS_PER_THREAD_LIMIT) {
      const oldest = forThread.keys().next();
      if (oldest.done === true) break;
      forThread.delete(oldest.value);
    }
    forThread.set(callId, outcome);
  };

  // Forked interruption: a slow dispatch finalizer must never stall the
  // caller (detach or the single-consumer signal loop).
  const interruptInFlightForked = (key: string): Effect.Effect<void> =>
    Effect.suspend(() => {
      const fiber = inFlight.get(key);
      if (fiber === undefined) return Effect.void;
      inFlight.delete(key);
      return Fiber.interrupt(fiber).pipe(Effect.forkChild, Effect.asVoid);
    });

  const interruptThreadCalls = (threadId: ThreadId): Effect.Effect<void> =>
    Effect.suspend(() => {
      const prefix = `${threadId}\n`;
      const keys = Array.from(inFlight.keys()).filter((key) => key.startsWith(prefix));
      return Effect.forEach(keys, interruptInFlightForked, { discard: true });
    });

  const attachShuvcodeThread: AdeToolGateShape["attachShuvcodeThread"] = <E>(
    seam: ProviderDynamicToolsShape<E>,
    options: AdeShuvcodeAttachOptions,
  ) =>
    Effect.gen(function* () {
      const existing = shuvcodeBindings.get(options.threadId);
      if (
        existing !== undefined &&
        (existing.principal.botId !== options.principal.botId ||
          existing.principal.purpose !== options.principal.purpose)
      ) {
        return yield* new AdeShuvcodeAttachConflictError({
          threadId: options.threadId,
          attachedBotId: existing.principal.botId,
          requestedBotId: options.principal.botId,
        });
      }
      const catalog = yield* catalogFor(options.principal);
      // Record the binding BEFORE configuring: configureThread on a live
      // session drains provider-side pending calls into the signal feed, and
      // the loop may dispatch them immediately — they must attribute.
      attachGenerationCounter += 1;
      shuvcodeBindings.set(options.threadId, {
        principal: options.principal,
        sessionId: options.sessionId,
        generation: attachGenerationCounter,
      });
      yield* seam
        .configureThread({
          threadId: options.threadId,
          tools: catalog.map((definition) => ({
            name: definition.name,
            description: definition.description,
            parameters: definition.parameters,
          })),
          metadata: {
            "shuv2code/ade": {
              botId: options.principal.botId,
              purpose: options.principal.purpose,
            },
          },
        })
        .pipe(
          Effect.tapError(() =>
            Effect.sync(() => {
              // Roll back to the pre-call state: the prior same-principal
              // binding on re-attach, or nothing on first attach.
              if (existing !== undefined) {
                shuvcodeBindings.set(options.threadId, existing);
              } else {
                shuvcodeBindings.delete(options.threadId);
              }
            }),
          ),
        );
    });

  const rebindShuvcodeSession: AdeToolGateShape["rebindShuvcodeSession"] = (options) =>
    Effect.gen(function* () {
      const existing = shuvcodeBindings.get(options.threadId);
      if (
        existing !== undefined &&
        (existing.principal.botId !== options.principal.botId ||
          existing.principal.purpose !== options.principal.purpose)
      ) {
        return yield* new AdeShuvcodeAttachConflictError({
          threadId: options.threadId,
          attachedBotId: existing.principal.botId,
          requestedBotId: options.principal.botId,
        });
      }
      // A new generation fences dispatches taken under the provisional id, so
      // an invocation in flight across the rebind cannot settle against the
      // wrong session.
      attachGenerationCounter += 1;
      shuvcodeBindings.set(options.threadId, {
        principal: options.principal,
        sessionId: options.sessionId,
        generation: attachGenerationCounter,
      });
    });

  const detachShuvcodeThread: AdeToolGateShape["detachShuvcodeThread"] = (seam, threadId) =>
    Effect.gen(function* () {
      shuvcodeBindings.delete(threadId);
      settledCalls.delete(threadId);
      yield* interruptThreadCalls(threadId);
      yield* seam.clearThread(threadId);
    });

  const replyShuvcode = <E>(
    seam: ProviderDynamicToolsShape<E>,
    call: ProviderDynamicToolCall,
    outcome: AdeToolOutcome,
    isBenignReplyConflict: (error: unknown) => boolean,
  ): Effect.Effect<void> =>
    seam
      .replyToCall({
        threadId: call.threadId,
        callId: call.callId,
        result: shuvcodeResultFor(outcome),
      })
      .pipe(
        Effect.catch((error) =>
          isBenignReplyConflict(error)
            ? Effect.void
            : Effect.logWarning("ADE tool gate failed to reply to a shuvcode tool call", {
                threadId: call.threadId,
                callId: call.callId,
                tool: call.tool,
                error,
              }),
        ),
        Effect.catchDefect((defect) =>
          Effect.logError("ADE tool gate reply defect", {
            threadId: call.threadId,
            callId: call.callId,
            defect,
          }),
        ),
      );

  const dispatchShuvcodeCall = <E>(
    seam: ProviderDynamicToolsShape<E>,
    call: ProviderDynamicToolCall,
    takenUnder: ShuvcodeBinding | undefined,
    isBenignReplyConflict: (error: unknown) => boolean,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      // Re-request of an already-executed call (post-cancel or post-409
      // replay): reply with the recorded outcome, never run the handler twice.
      const priorOutcome = settledCalls.get(call.threadId)?.get(call.callId);
      if (priorOutcome !== undefined) {
        return yield* replyShuvcode(seam, call, priorOutcome, isBenignReplyConflict);
      }
      if (takenUnder === undefined) {
        // A call on a thread the gate never attached is not attributable to
        // any bot — refuse it rather than guess.
        return yield* replyShuvcode(
          seam,
          call,
          { _tag: "denied", denial: { _tag: "unknown-tool", tool: call.tool } },
          isBenignReplyConflict,
        );
      }
      const current = shuvcodeBindings.get(call.threadId);
      if (current === undefined || current.generation !== takenUnder.generation) {
        // Fencing: the attach this call was taken under has been superseded
        // (detach, or re-attach which re-requests still-pending calls). Drop
        // without executing; the current attach's drain owns the call now.
        return yield* replyShuvcode(
          seam,
          call,
          {
            _tag: "failed",
            message: `ADE tool call '${call.callId}' was taken under a superseded session attach and was not executed.`,
          },
          isBenignReplyConflict,
        );
      }
      const outcome = yield* dispatch(
        {
          ...takenUnder.principal,
          engine: "shuvcode",
          sessionId: takenUnder.sessionId,
          tool: call.tool,
          callId: call.callId,
        },
        call.input,
      );
      recordSettledCall(call.threadId, call.callId, outcome);
      yield* replyShuvcode(seam, call, outcome, isBenignReplyConflict);
    });

  const runShuvcodeDispatchLoop: AdeToolGateShape["runShuvcodeDispatchLoop"] = <E>(
    seam: ProviderDynamicToolsShape<E>,
    options: AdeShuvcodeLoopOptions = {},
  ) => {
    const isBenignReplyConflict = options.isBenignReplyConflict ?? defaultIsBenignReplyConflict;
    return Effect.gen(function* () {
      const signal = yield* seam.takeSignal;
      if (signal.kind === "cancelled") {
        yield* interruptInFlightForked(inFlightKey(signal.threadId, signal.callId));
        return;
      }
      const call = signal.call;
      const key = inFlightKey(call.threadId, call.callId);
      // Snapshot the binding at take time; the dispatch fiber re-validates
      // the generation before executing.
      const takenUnder = shuvcodeBindings.get(call.threadId);
      const fiber = yield* dispatchShuvcodeCall(seam, call, takenUnder, isBenignReplyConflict).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            inFlight.delete(key);
          }),
        ),
        Effect.forkChild,
      );
      if (fiber.pollUnsafe() === undefined) {
        // Only track fibers that are actually still running: a synchronous
        // completion already ran the ensuring cleanup before this line.
        inFlight.set(key, fiber);
      }
    }).pipe(Effect.forever);
  };

  return {
    catalogFor,
    dispatch,
    codexDynamicToolsFor,
    makeCodexToolCallHandler,
    attachShuvcodeThread,
    rebindShuvcodeSession,
    detachShuvcodeThread,
    runShuvcodeDispatchLoop,
  } satisfies AdeToolGateShape;
};
