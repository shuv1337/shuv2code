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

export const renderAdeToolOutcomeFailure = (
  outcome: Exclude<AdeToolOutcome, { _tag: "completed" }>,
): string => (outcome._tag === "denied" ? renderAdeToolDenial(outcome.denial) : outcome.message);

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

/** Domain failure raised by a real handler; `detail` is model-visible. */
export class AdeToolExecutionError extends Schema.TaggedErrorClass<AdeToolExecutionError>()(
  "AdeToolExecutionError",
  {
    tool: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `ADE tool '${this.tool}' failed: ${this.detail}`;
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

export class AdeToolHandlers extends Context.Service<AdeToolHandlers, AdeToolHandlersShape>()(
  "shuv2code/ade/AdeToolGate/AdeToolHandlers",
) {
  /** Default until S7/S8 land: registration+dispatch work, behavior does not. */
  static readonly layerUnavailable = Layer.succeed(AdeToolHandlers, adeToolHandlersUnavailable);
  /** Partial override helper so S7/S8 wire only their own handlers. */
  static layerPartial(overrides: Partial<AdeToolHandlersShape>): Layer.Layer<AdeToolHandlers> {
    return Layer.succeed(AdeToolHandlers, { ...adeToolHandlersUnavailable, ...overrides });
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
  readonly principal: AdeToolSessionPrincipal;
}

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
   * thread → principal binding for dispatch. Call before `startSession`
   * (including after restarts) so the catalog rides session creation.
   */
  readonly attachShuvcodeThread: <E>(
    seam: ProviderDynamicToolsShape<E>,
    options: AdeShuvcodeAttachOptions,
  ) => Effect.Effect<void, E>;

  /** Drop the thread's catalog and binding; interrupts in-flight dispatches. */
  readonly detachShuvcodeThread: <E>(
    seam: ProviderDynamicToolsShape<E>,
    threadId: ThreadId,
  ) => Effect.Effect<void, E>;

  /**
   * Own the seam's single-consumer `takeSignal` loop: dispatch `requested`
   * signals (concurrently, one fiber per call), reply through the seam, and
   * interrupt in-flight dispatches on `cancelled`. Run exactly once per seam;
   * ends only with its scope.
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

  const dispatch: AdeToolGateShape["dispatch"] = Effect.fn("AdeToolGate.dispatch")(
    function* (ctx, rawInput) {
      const tool = ctx.tool;
      // Approval operations are structurally absent from this plane: even a
      // name smuggled into a session catalog dispatches as unknown.
      if (ADE_APPROVAL_NAME_PATTERN.test(tool)) {
        return { _tag: "denied", denial: { _tag: "unknown-tool", tool } } as const;
      }
      if (tool.startsWith(ADE_SCREENBOX_TOOL_PREFIX)) {
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
    },
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

  const shuvcodePrincipals = new Map<ThreadId, AdeToolSessionPrincipal>();
  const inFlight = new Map<string, Fiber.Fiber<void>>();
  const inFlightKey = (threadId: ThreadId, callId: string): string => `${threadId}\n${callId}`;

  const interruptThreadCalls = (threadId: ThreadId): Effect.Effect<void> =>
    Effect.gen(function* () {
      const prefix = `${threadId}\n`;
      // Snapshot: interruption yields, and finalizers mutate the map.
      const threadCalls = Array.from(inFlight).filter(([key]) => key.startsWith(prefix));
      for (const [key, fiber] of threadCalls) {
        inFlight.delete(key);
        yield* Fiber.interrupt(fiber);
      }
    });

  const attachShuvcodeThread: AdeToolGateShape["attachShuvcodeThread"] = (seam, options) =>
    Effect.gen(function* () {
      const catalog = yield* catalogFor(options.principal);
      yield* seam.configureThread({
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
      });
      shuvcodePrincipals.set(options.threadId, options.principal);
    });

  const detachShuvcodeThread: AdeToolGateShape["detachShuvcodeThread"] = (seam, threadId) =>
    Effect.gen(function* () {
      shuvcodePrincipals.delete(threadId);
      yield* interruptThreadCalls(threadId);
      yield* seam.clearThread(threadId);
    });

  const dispatchShuvcodeCall = <E>(
    seam: ProviderDynamicToolsShape<E>,
    call: ProviderDynamicToolCall,
    isBenignReplyConflict: (error: unknown) => boolean,
  ): Effect.Effect<void> =>
    Effect.gen(function* () {
      const principal = shuvcodePrincipals.get(call.threadId);
      const outcome: AdeToolOutcome =
        principal === undefined
          ? // A call on a thread the gate never attached is not attributable
            // to any bot — refuse it rather than guess.
            { _tag: "denied", denial: { _tag: "unknown-tool", tool: call.tool } }
          : yield* dispatch(
              {
                ...principal,
                engine: "shuvcode",
                sessionId: KernelSessionId.make(call.threadId),
                tool: call.tool,
                callId: call.callId,
              },
              call.input,
            );
      yield* seam
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
        );
    });

  const runShuvcodeDispatchLoop: AdeToolGateShape["runShuvcodeDispatchLoop"] = <E>(
    seam: ProviderDynamicToolsShape<E>,
    options: AdeShuvcodeLoopOptions = {},
  ) => {
    const isBenignReplyConflict = options.isBenignReplyConflict ?? defaultIsBenignReplyConflict;
    return Effect.gen(function* () {
      const signal = yield* seam.takeSignal;
      if (signal.kind === "cancelled") {
        const key = inFlightKey(signal.threadId, signal.callId);
        const fiber = inFlight.get(key);
        if (fiber !== undefined) {
          inFlight.delete(key);
          yield* Fiber.interrupt(fiber);
        }
        return;
      }
      const call = signal.call;
      const key = inFlightKey(call.threadId, call.callId);
      let settled = false;
      const fiber = yield* dispatchShuvcodeCall(seam, call, isBenignReplyConflict).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            settled = true;
            inFlight.delete(key);
          }),
        ),
        Effect.forkChild,
      );
      if (!settled) {
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
    detachShuvcodeThread,
    runShuvcodeDispatchLoop,
  } satisfies AdeToolGateShape;
};
