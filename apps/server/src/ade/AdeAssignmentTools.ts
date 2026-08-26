// @effect-diagnostics nodeBuiltinImport:off
/**
 * The assignment engine's slice of the ADE tool plane (spec
 * `docs/ade/ADE-V1-SPEC.md` §3.2 + §4.2, issue #161).
 *
 * Two layers plug into the S6 gate without touching it:
 *
 * - `AdeAssignmentToolHandlers.layer` — `AdeToolHandlers.layerPartial` with
 *   the real `fleet_read`, `create_assignment`, `steer_primary` and
 *   `report_assignment_result` behavior (S8 still owns `update_memory`).
 * - `AdeAssignmentInlineChecks.layer` — the data-backed replacement for the
 *   gate's fail-closed `AdeToolInlineChecks`: routing-target grants and
 *   assignment ownership read the ADE tables directly (plain code, no policy
 *   engine, spec §3.2).
 *
 * **Durable idempotency** (the gate's re-request dedupe is in-memory only):
 * `create_assignment` always resolves an idempotency key — the model-supplied
 * one, or a deterministic digest of the call's own content — and the unique
 * index in migration 055 makes a replayed call return the original
 * assignment. `report_assignment_result` is idempotent because the engine
 * refuses to re-settle an already-terminal assignment. Both therefore survive
 * a process restart, which is exactly what the in-memory dedupe cannot.
 *
 * **Grants are structural** (spec §2.3): role rules plus the project's
 * `sharedSpecialistAllowList`. There is no capability matrix and no scope in
 * anything bot-facing.
 */
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  AdeProjectId,
  AssignmentId,
  AssignmentResultSummary,
  BotId,
  BotStructuralRole,
} from "@shuv2code/contracts";

import {
  AdeAssignmentEngine,
  AdeAssignmentKernelPort,
  type AdeAssignmentEngineShape,
} from "./AdeAssignmentEngine.ts";
import {
  adeToolInlineChecksFailClosed,
  AdeToolExecutionError,
  AdeToolHandlers,
  AdeToolInlineChecks,
  type AdeInlineCheckDecision,
  type AdeToolCallContext,
  type AdeToolHandlersShape,
  type AdeToolInlineChecksShape,
  type CreateAssignmentInput,
  type FleetReadInput,
  type ReportAssignmentResultInput,
  type SteerPrimaryInput,
} from "./AdeToolGate.ts";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

interface BotRow {
  readonly bot_id: string;
  readonly name: string;
  readonly structural_role: BotStructuralRole;
  readonly role_tag: string;
  readonly project_id: string | null;
  readonly archived_at: string | null;
  /** Null for captain-created and boot-created bots (migration 061). */
  readonly created_by_bot_id: string | null;
}

/**
 * Deterministic fallback idempotency key: the same tool call replayed after a
 * restart digests to the same key and therefore resolves to the original
 * assignment. The trade-off is deliberate — a bot that genuinely wants a
 * second, byte-identical assignment must pass its own `idempotencyKey`.
 */
export const deriveAssignmentIdempotencyKey = (input: {
  readonly callerBotId: BotId;
  readonly recipientBotId: BotId;
  readonly instruction: string;
  readonly projectId: AdeProjectId | null;
  readonly parentAssignmentId: AssignmentId | null;
}): string => {
  const digest = NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        input.callerBotId,
        input.recipientBotId,
        input.projectId,
        input.parentAssignmentId,
        input.instruction,
      ]),
    )
    .digest("hex");
  return `derived:${digest}`;
};

const executionError = (tool: string, detail: string) =>
  Effect.fail(new AdeToolExecutionError({ tool, detail }));

const allowed: AdeInlineCheckDecision = { allowed: true };
const denied = (reason: string): AdeInlineCheckDecision => ({ allowed: false, reason });

// ---------------------------------------------------------------------------
// Inline checks (spec §3.2)
// ---------------------------------------------------------------------------

/**
 * Structural routing grants (spec §2.3, resolved for V1):
 *
 * - the **Firstmate** routes anywhere (fleet-wide authority);
 * - a **Second Mate** routes inside its own project, and to fleet-shared
 *   workspace specialists its project allows;
 * - **crew** route inside their own project, plus the same allowed shared
 *   specialists;
 * - a **workspace specialist** routes nowhere — specialists do work, they do
 *   not run a crew;
 * - nobody routes at themselves, at an archived bot, or at a bot that does
 *   not exist.
 */
export interface AdeRoutingGrants extends Pick<
  AdeToolInlineChecksShape,
  "isRoutingTargetAllowed" | "isAssignmentOwnedBy"
> {
  /**
   * The bots this caller may see — the same grant table as routing, plus the
   * caller itself. `fleet_read` uses it so visibility and authority cannot
   * drift apart.
   */
  readonly visibleBots: (callerBotId: BotId) => Effect.Effect<ReadonlyArray<BotRow>>;
}

/** Build the grant table over one SQL client (used by checks *and* fleet_read). */
export const makeAdeRoutingGrants = (sql: SqlClient.SqlClient): AdeRoutingGrants => {
  const readBot = Effect.fn("AdeRoutingGrants.readBot")(function* (botId: string) {
    const rows = yield* sql<BotRow>`
      SELECT bot_id, name, structural_role, role_tag, project_id, archived_at,
             created_by_bot_id
      FROM ade_bots WHERE bot_id = ${botId}
    `;
    return rows[0] ?? null;
  });

  const sharedSpecialistAllowed = Effect.fn("AdeRoutingGrants.sharedSpecialistAllowed")(function* (
    projectId: string,
    specialistBotId: string,
  ) {
    const rows = yield* sql<{ shared_specialist_allow_list_json: string }>`
      SELECT shared_specialist_allow_list_json FROM ade_projects
      WHERE project_id = ${projectId}
    `;
    const raw = rows[0]?.shared_specialist_allow_list_json;
    if (raw === undefined) return false;
    const parsed: unknown = JSON.parse(raw);
    if (parsed === "all") return true;
    return Array.isArray(parsed) && parsed.includes(specialistBotId);
  });

  const decide = Effect.fn("AdeRoutingGrants.decide")(function* (
    callerBotId: BotId,
    target: BotRow,
  ) {
    const caller = yield* readBot(callerBotId);
    if (caller === null) return denied("the calling bot no longer exists");
    if (caller.archived_at !== null) return denied("the calling bot is archived");
    if (callerBotId === target.bot_id) return denied("a bot cannot route work at itself");
    if (target.archived_at !== null) return denied("that bot is archived");
    if (caller.structural_role === "firstmate") return allowed;
    if (caller.structural_role === "workspace-specialist") {
      return denied("workspace specialists do not route work to other bots");
    }
    if (caller.project_id === null) {
      return denied("the calling bot has no project to route within");
    }
    if (target.project_id === caller.project_id) return allowed;
    if (target.structural_role === "workspace-specialist" && target.project_id === null) {
      return (yield* sharedSpecialistAllowed(caller.project_id, target.bot_id))
        ? allowed
        : denied("that shared specialist is not on the project's allow list");
    }
    return denied("that bot belongs to another project");
  });

  const isRoutingTargetAllowed: AdeToolInlineChecksShape["isRoutingTargetAllowed"] = Effect.fn(
    "AdeRoutingGrants.isRoutingTargetAllowed",
  )(function* (input: { caller: AdeToolCallContext; targetBotId: BotId }) {
    const target = yield* readBot(input.targetBotId);
    if (target === null) return denied("no such bot");
    return yield* decide(input.caller.botId, target);
  }, Effect.orDie);

  /**
   * Ownership only. A settled assignment is deliberately still "owned": the
   * engine answers a replayed `report_assignment_result` with
   * `recorded: false` instead of the gate denying it, which is what keeps the
   * tool idempotent across a restart.
   */
  const isAssignmentOwnedBy: AdeToolInlineChecksShape["isAssignmentOwnedBy"] = Effect.fn(
    "AdeRoutingGrants.isAssignmentOwnedBy",
  )(function* (input: { caller: AdeToolCallContext; assignmentId: AssignmentId }) {
    const rows = yield* sql<{ recipient_bot_id: string }>`
      SELECT recipient_bot_id FROM ade_assignments
      WHERE assignment_id = ${input.assignmentId}
    `;
    const row = rows[0];
    if (row === undefined) return denied("no such assignment");
    if (row.recipient_bot_id !== input.caller.botId) {
      return denied("that assignment belongs to another bot");
    }
    return allowed;
  }, Effect.orDie);

  const visibleBots: AdeRoutingGrants["visibleBots"] = Effect.fn("AdeRoutingGrants.visibleBots")(
    function* (callerBotId: BotId) {
      const bots = yield* sql<BotRow>`
        SELECT bot_id, name, structural_role, role_tag, project_id, archived_at,
               created_by_bot_id
        FROM ade_bots WHERE archived_at IS NULL
        ORDER BY created_at ASC, rowid ASC
      `;
      const visible: Array<BotRow> = [];
      for (const bot of bots) {
        if (bot.bot_id === callerBotId) {
          visible.push(bot);
          continue;
        }
        const decision = yield* decide(callerBotId, bot);
        if (decision.allowed) visible.push(bot);
      }
      return visible;
    },
    Effect.orDie,
  );

  return { isRoutingTargetAllowed, isAssignmentOwnedBy, visibleBots };
};

export class AdeAssignmentInlineChecks extends Context.Service<
  AdeAssignmentInlineChecks,
  AdeToolInlineChecksShape
>()("shuv2code/ade/AdeAssignmentInlineChecks") {
  static readonly layer: Layer.Layer<AdeToolInlineChecks, never, SqlClient.SqlClient> =
    Layer.effect(
      AdeToolInlineChecks,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const grants = makeAdeRoutingGrants(sql);
        return AdeToolInlineChecks.of({
          // The provisioning check is not this slice's (M9 owns it): keep the
          // gate's fail-closed default so a graph that forgets to stack
          // `AdeFleetProvisioningInlineChecks` refuses rather than allows.
          ...adeToolInlineChecksFailClosed,
          isRoutingTargetAllowed: grants.isRoutingTargetAllowed,
          isAssignmentOwnedBy: grants.isAssignmentOwnedBy,
        });
      }),
    );
}

// ---------------------------------------------------------------------------
// Handlers (spec §4.2 tool behavior)
// ---------------------------------------------------------------------------

interface FleetBotView {
  readonly botId: string;
  readonly name: string;
  readonly structuralRole: BotStructuralRole;
  readonly roleTag: string;
  readonly projectId: string | null;
  /**
   * The project's display name. Ids are the only project handle the tool
   * plane otherwise prints, and a model cannot turn one into the name the
   * captain used — which is what made `create_bot`'s "for Harbor" unusable.
   */
  readonly projectName: string | null;
  /** Which bot provisioned this one; null for captain/boot-created bots. */
  readonly createdByBotId: string | null;
  readonly assignments: ReadonlyArray<{
    readonly assignmentId: string;
    readonly status: string;
    readonly blockedReason: string | null;
    readonly queuePosition: number;
    readonly instruction: string;
  }>;
}

export class AdeAssignmentToolHandlers extends Context.Service<
  AdeAssignmentToolHandlers,
  Pick<
    AdeToolHandlersShape,
    "fleetRead" | "createAssignment" | "steerPrimary" | "reportAssignmentResult"
  >
>()("shuv2code/ade/AdeAssignmentToolHandlers") {
  /**
   * Patch-style override over whatever `AdeToolHandlers` is underneath, so
   * this layer and S8's memory layer stack without reverting each other.
   */
  static readonly layer: Layer.Layer<
    AdeToolHandlers,
    never,
    AdeToolHandlers | AdeAssignmentEngine | AdeAssignmentKernelPort | SqlClient.SqlClient
  > = Layer.effect(
    AdeToolHandlers,
    Effect.gen(function* () {
      const base = yield* AdeToolHandlers;
      const engine = yield* AdeAssignmentEngine;
      const port = yield* AdeAssignmentKernelPort;
      const sql = yield* SqlClient.SqlClient;
      const grants = makeAdeRoutingGrants(sql);

      /**
       * Scoped by the same grant table as routing: a bot reads the fleet it
       * may act on (plus itself), never the whole roster.
       */
      const fleetRead: AdeToolHandlersShape["fleetRead"] = Effect.fn(
        "AdeAssignmentToolHandlers.fleetRead",
      )(
        function* (ctx: AdeToolCallContext, input: FleetReadInput) {
          const bots = yield* grants.visibleBots(ctx.botId);
          const narrowed =
            input.projectId === undefined
              ? bots
              : bots.filter((bot) => bot.project_id === input.projectId);
          const projectRows = yield* sql<{ project_id: string; name: string }>`
            SELECT project_id, name FROM ade_projects
          `;
          const projectNames = new Map(projectRows.map((row) => [row.project_id, row.name]));
          const views: Array<FleetBotView> = [];
          for (const bot of narrowed) {
            const assignments = yield* engine.listForBot(bot.bot_id as BotId, {
              statuses: ["queued", "running", "blocked"],
            });
            views.push({
              botId: bot.bot_id,
              name: bot.name,
              structuralRole: bot.structural_role,
              roleTag: bot.role_tag,
              projectId: bot.project_id,
              projectName:
                bot.project_id === null ? null : (projectNames.get(bot.project_id) ?? null),
              createdByBotId: bot.created_by_bot_id,
              assignments: assignments.map((assignment) => ({
                assignmentId: assignment.id,
                status: assignment.status,
                blockedReason: assignment.blockedReason,
                queuePosition: assignment.queuePosition,
                instruction: assignment.instruction,
              })),
            });
          }
          return JSON.stringify({ callerBotId: ctx.botId, bots: views });
        },
        Effect.catchTags({
          PersistenceSqlError: (error) => executionError("fleet_read", error.message),
          SqlError: (error) => executionError("fleet_read", error.message),
        }),
      );

      const createAssignment: AdeToolHandlersShape["createAssignment"] = Effect.fn(
        "AdeAssignmentToolHandlers.createAssignment",
      )(
        function* (ctx: AdeToolCallContext, input: CreateAssignmentInput) {
          const projectId = input.projectId ?? null;
          const parentAssignmentId = input.parentAssignmentId ?? null;
          const idempotencyKey =
            input.idempotencyKey ??
            deriveAssignmentIdempotencyKey({
              callerBotId: ctx.botId,
              recipientBotId: input.recipientBotId,
              instruction: input.instruction,
              projectId,
              parentAssignmentId,
            });
          const outcome = yield* engine.createAssignment({
            requester: { _tag: "bot", botId: ctx.botId },
            recipientBotId: input.recipientBotId,
            instruction: input.instruction,
            idempotencyKey,
            ...(input.declaredRisk === undefined ? {} : { declaredRisk: input.declaredRisk }),
            projectId,
            parentAssignmentId,
          });
          return JSON.stringify({
            assignmentId: outcome.assignment.id,
            created: outcome.created,
            status: outcome.assignment.status,
            queuePosition: outcome.assignment.queuePosition,
            recipientBotId: outcome.assignment.recipientBotId,
            idempotencyKey,
          });
        },
        Effect.catchTags({
          AdeAssignmentLimitExceededError: (error) =>
            executionError("create_assignment", error.message),
          AdeAssignmentNotFoundError: (error) => executionError("create_assignment", error.message),
          AdeBotArchivedError: (error) => executionError("create_assignment", error.message),
          AdeBotNotFoundError: (error) => executionError("create_assignment", error.message),
          PersistenceSqlError: (error) => executionError("create_assignment", error.message),
        }),
      );

      /**
       * Steering never interrupts and never changes assignment status.
       *
       * **At-least-once, deliberately**: steering carries no durable record to
       * dedupe against, so a call replayed after a restart (the gate's
       * re-request dedupe is in-memory only) can steer the session twice. That
       * is accepted for V1 — a repeated nudge is low-harm, and inventing a
       * durable steer log would buy nothing under trusted-host. Assignment
       * *state* changes stay exactly-once; only this nudge is not.
       */
      const steerPrimary: AdeToolHandlersShape["steerPrimary"] = Effect.fn(
        "AdeAssignmentToolHandlers.steerPrimary",
      )(
        function* (_ctx: AdeToolCallContext, input: SteerPrimaryInput) {
          const bindings = yield* sql<{ engine: "shuvcode" | "codex"; kernel_session_id: string }>`
            SELECT engine, kernel_session_id FROM ade_bot_execution_bindings
            WHERE bot_id = ${input.targetBotId}
              AND purpose = 'primary-text'
              AND status = 'active'
            ORDER BY updated_at DESC, rowid DESC
            LIMIT 1
          `;
          const binding = bindings[0];
          if (binding === undefined) {
            return yield* executionError(
              "steer_primary",
              `bot '${input.targetBotId}' has no active primary session to steer`,
            );
          }
          yield* port.steerPrimary({
            botId: input.targetBotId,
            engine: binding.engine,
            sessionId: binding.kernel_session_id as Parameters<
              typeof port.steerPrimary
            >[0]["sessionId"],
            text: input.text,
          });
          return JSON.stringify({ steered: true, targetBotId: input.targetBotId });
        },
        Effect.catchTags({
          AdeAssignmentKernelPortError: (error) => executionError("steer_primary", error.message),
          SqlError: (error) => executionError("steer_primary", error.message),
        }),
      );

      const reportAssignmentResult: AdeToolHandlersShape["reportAssignmentResult"] = Effect.fn(
        "AdeAssignmentToolHandlers.reportAssignmentResult",
      )(
        function* (_ctx: AdeToolCallContext, input: ReportAssignmentResultInput) {
          const outcome = yield* engine.reportResult({
            assignmentId: input.assignmentId,
            status: input.status,
            summary: input.summary,
            ...(input.artifacts === undefined ? {} : { artifacts: input.artifacts }),
          });
          // Best-effort push: an undeliverable batch stays durably pending, so
          // a failure here never loses (or duplicates) the completion.
          const delivery = yield* engine.deliverPending();
          return JSON.stringify({
            assignmentId: outcome.assignment.id,
            recorded: outcome.recorded,
            status: outcome.assignment.status,
            deliveredBatches: delivery.delivered.length,
          });
        },
        Effect.catchTags({
          AdeAssignmentNotFoundError: (error) =>
            executionError("report_assignment_result", error.message),
          PersistenceSqlError: (error) => executionError("report_assignment_result", error.message),
        }),
      );

      return AdeToolHandlers.of({
        ...base,
        fleetRead,
        createAssignment,
        steerPrimary,
        reportAssignmentResult,
      });
    }),
  );
}

/** Convenience type for callers wiring the engine into their own services. */
export type AdeAssignmentEngineApi = AdeAssignmentEngineShape;

/** Re-exported for callers that build a result summary before reporting. */
export type AdeAssignmentSummary = AssignmentResultSummary;
