// @effect-diagnostics nodeBuiltinImport:off
/**
 * ADE session & rollover service (spec `docs/ade/ADE-V1-SPEC.md` §4.3,
 * ADR §12, issue #162).
 *
 * - **Projection at session creation** (ADR §12.1–§12.3): every new primary
 *   session gets `persona + memory + active assignments + outgoing-session
 *   summary`. Creating the session is also the activation point for pending
 *   persona edits — the latest `PersonaVersion` is activated here, so edits
 *   take effect next-session, never live.
 * - **Binding maintenance** (spec §2.1): rows in `ade_bot_execution_bindings`
 *   are opened `active` at session creation, and closed `historical` (rollover,
 *   deliberate stop) or `lost` (crash recovery) — never deleted.
 * - **One active primary text session per bot** (ADR §3.2): a second
 *   `startPrimarySession` while one is active is *refused* — plain start
 *   attempts are not among the locked rollover triggers (ADR §12.3: context
 *   exhaustion, deliberate reset, engine change, crash recovery), so
 *   replacement is only ever the explicit `rolloverPrimarySession` path. The
 *   refusal is race-proof: the partial unique index
 *   `idx_ade_bot_execution_bindings_one_active_primary` (055) turns a lost
 *   race into `ON CONFLICT DO NOTHING`.
 * - **Rollover summaries** are bounded at 16 KB
 *   (`SESSION_ROLLOVER_SUMMARY_MAX_LENGTH`, contracts / ADR §18.1), stored
 *   on the retired binding row (`rollover_summary`), readable back through
 *   `listBindings`, and recovered into a fresh `startPrimarySession`
 *   projection after a restart (component 4 survives the process).
 * - **Rollover is a compare-and-set** on `expectedBindingId`: a stale or
 *   concurrent duplicate rollover fails with `AdeRolloverConflictError`
 *   instead of retiring a binding its rival just created.
 */
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type AdeProjectId,
  type AssignmentBlockedReason,
  type AssignmentId,
  type AssignmentStatus,
  type BotExecutionBinding,
  type BotExecutionBindingId,
  type BotExecutionBindingPurpose,
  type BotExecutionBindingStatus,
  type BotId,
  type DeclaredRisk,
  type KernelEngine,
  type KernelSessionId,
  type PersonaVersionId,
  SESSION_ROLLOVER_SUMMARY_MAX_LENGTH,
} from "@shuv2code/contracts";

import { type PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";
import { AdeBotNotFoundError } from "./AdeBootstrap.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** ADR §3.2 — refused, not rolled over: rollover is an explicit, separate act. */
export class AdePrimarySessionActiveError extends Schema.TaggedErrorClass<AdePrimarySessionActiveError>()(
  "AdePrimarySessionActiveError",
  {
    botId: Schema.String,
    existingBindingId: Schema.String,
    existingEngine: Schema.String,
    existingSessionId: Schema.String,
  },
) {
  override get message(): string {
    return (
      `Bot '${this.botId}' already has an active primary text session ` +
      `(binding '${this.existingBindingId}', ${this.existingEngine} session ` +
      `'${this.existingSessionId}'). Roll it over explicitly instead.`
    );
  }
}

export class AdeRolloverSummaryLimitExceededError extends Schema.TaggedErrorClass<AdeRolloverSummaryLimitExceededError>()(
  "AdeRolloverSummaryLimitExceededError",
  {
    /** Bot (start/rollover paths) or binding (closeBinding) being summarized. */
    subject: Schema.String,
    length: Schema.Number,
    limit: Schema.Number,
  },
) {
  override get message(): string {
    return `Outgoing-session summary for '${this.subject}' is ${this.length} units; the bound is ${this.limit}.`;
  }
}

/**
 * The rollover's compare-and-set lost: `expectedBindingId` is no longer the
 * active primary binding. `currentActive*` name the surviving active binding
 * so callers can distinguish "someone already rolled over" (non-null — retry
 * against the survivor or adopt it) from "no active session at all" (null —
 * start a fresh primary instead).
 */
export class AdeRolloverConflictError extends Schema.TaggedErrorClass<AdeRolloverConflictError>()(
  "AdeRolloverConflictError",
  {
    botId: Schema.String,
    expectedBindingId: Schema.String,
    currentActiveBindingId: Schema.NullOr(Schema.String),
    currentActiveSessionId: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return this.currentActiveBindingId === null
      ? `Rollover for bot '${this.botId}' expected active binding '${this.expectedBindingId}', but no primary binding is active.`
      : `Rollover for bot '${this.botId}' expected active binding '${this.expectedBindingId}', but '${this.currentActiveBindingId}' is active.`;
  }
}

/**
 * The kernel session id is already bound (unique per engine). Surfaced as a
 * typed error so S7 can decide to re-adopt the surviving session (§4.2)
 * instead of treating it as a defect.
 */
export class AdeSessionBindingConflictError extends Schema.TaggedErrorClass<AdeSessionBindingConflictError>()(
  "AdeSessionBindingConflictError",
  {
    engine: Schema.String,
    sessionId: Schema.String,
    boundBotId: Schema.NullOr(Schema.String),
    boundBindingId: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return (
      `Kernel session '${this.sessionId}' (${this.engine}) is already bound` +
      (this.boundBindingId === null
        ? "."
        : ` to binding '${this.boundBindingId}' of bot '${this.boundBotId}'.`)
    );
  }
}

export class AdeBindingNotFoundError extends Schema.TaggedErrorClass<AdeBindingNotFoundError>()(
  "AdeBindingNotFoundError",
  {
    bindingId: Schema.String,
  },
) {
  override get message(): string {
    return `ADE execution binding '${this.bindingId}' does not exist.`;
  }
}

// ---------------------------------------------------------------------------
// Projection (ADR §12.3 — the four rollover components)
// ---------------------------------------------------------------------------

/** Slim assignment view carried into a session (component 3). */
export interface AdeProjectedAssignment {
  readonly assignmentId: AssignmentId;
  readonly instruction: string;
  readonly status: AssignmentStatus;
  readonly blockedReason: AssignmentBlockedReason | null;
  readonly declaredRisk: DeclaredRisk;
  readonly projectId: AdeProjectId | null;
  readonly queuePosition: number;
}

/**
 * Everything a new session starts with. `outgoingSessionSummary` is null only
 * on a bot's first-ever primary session (nothing preceded it).
 */
export interface AdeSessionProjection {
  readonly personaVersionId: PersonaVersionId;
  readonly persona: string;
  readonly memory: string;
  readonly activeAssignments: ReadonlyArray<AdeProjectedAssignment>;
  readonly outgoingSessionSummary: string | null;
}

/**
 * Delimiters fencing content the bot (or a past session) could have written:
 * memory, outgoing summaries, and assignment briefs. Everything between the
 * markers is data, not instructions — a bot writing section headers into its
 * memory must not be able to forge new prompt sections. Any literal
 * occurrence of a delimiter inside fenced content is defanged (see
 * {@link defangDelimiters}) so the fence cannot be closed early.
 */
export const UNTRUSTED_CONTENT_OPEN = "<<<untrusted-content>>>";
export const UNTRUSTED_CONTENT_CLOSE = "<<</untrusted-content>>>";

/** Break embedded delimiters so fenced content cannot escape its fence. */
const defangDelimiters = (content: string): string =>
  content
    .replaceAll(UNTRUSTED_CONTENT_CLOSE, "<< /untrusted-content >>")
    .replaceAll(UNTRUSTED_CONTENT_OPEN, "<< untrusted-content >>");

const fence = (content: string): string =>
  `${UNTRUSTED_CONTENT_OPEN}\n${defangDelimiters(content)}\n${UNTRUSTED_CONTENT_CLOSE}`;

/**
 * Render a projection into kernel-native instruction text (system prompt /
 * `developerInstructions`). Pure; adapters own where it lands.
 *
 * Size ceiling: persona ≤120 000 + memory ≤65 536 + summary ≤16 384 units,
 * plus one ≤120 000-unit instruction per active assignment — bounded in
 * practice by `LimitsConfig.maxQueuedAssignmentsPerBot` (default 20), so the
 * rendered projection stays well under ~2.6 M UTF-16 units.
 */
export const renderSessionProjection = (projection: AdeSessionProjection): string => {
  const sections: Array<string> = [projection.persona.trim()];
  if (projection.memory.trim().length > 0) {
    sections.push(`## Your memory\n\n${fence(projection.memory.trim())}`);
  }
  if (projection.activeAssignments.length > 0) {
    const lines = projection.activeAssignments.map((assignment) => {
      const blocked =
        assignment.blockedReason === null ? "" : ` (blocked: ${assignment.blockedReason})`;
      return `- [${assignment.status}${blocked}] assignment ${assignment.assignmentId}:\n${fence(assignment.instruction)}`;
    });
    sections.push(`## Your active assignments\n\n${lines.join("\n")}`);
  }
  if (projection.outgoingSessionSummary !== null) {
    sections.push(
      `## Summary of your previous session\n\n${fence(projection.outgoingSessionSummary)}`,
    );
  }
  return sections.join("\n\n");
};

// ---------------------------------------------------------------------------
// Service shape
// ---------------------------------------------------------------------------

export interface StartPrimarySessionInput {
  readonly botId: BotId;
  readonly engine: KernelEngine;
  readonly sessionId: KernelSessionId;
}

export interface RolloverPrimarySessionInput {
  readonly botId: BotId;
  readonly engine: KernelEngine;
  readonly sessionId: KernelSessionId;
  /**
   * Compare-and-set target: the active primary binding the caller observed
   * (and summarized). Rollover retires exactly this binding; if it is no
   * longer the active one, the call fails with `AdeRolloverConflictError`
   * instead of retiring a binding someone else just created.
   */
  readonly expectedBindingId: BotExecutionBindingId;
  /** Generated summary of the outgoing session (ADR §12.3 component 4). */
  readonly outgoingSummary: string;
}

export interface OpenBindingInput {
  readonly botId: BotId;
  readonly engine: KernelEngine;
  readonly sessionId: KernelSessionId;
  /** Non-primary purposes only; primary-text goes through start/rollover. */
  readonly purpose: Exclude<BotExecutionBindingPurpose, "primary-text">;
}

export interface CloseBindingInput {
  readonly bindingId: BotExecutionBindingId;
  /** `historical` for deliberate closes, `lost` for crash recovery. */
  readonly status: Exclude<BotExecutionBindingStatus, "active">;
  /** Optional bounded summary of the closed session. */
  readonly summary?: string;
}

export interface AdePrimarySession {
  readonly binding: BotExecutionBinding;
  readonly projection: AdeSessionProjection;
  /**
   * The binding this session replaced: always the `expectedBindingId` on the
   * rollover path, null on the start path (a start never retires anything —
   * with no active binding, component 4 is recovered from the most recently
   * retired primary binding's stored summary instead).
   */
  readonly supersededBindingId: BotExecutionBindingId | null;
}

export interface AdeSessionRolloverShape {
  /** Refuses while an active primary session exists (ADR §3.2). */
  readonly startPrimarySession: (
    input: StartPrimarySessionInput,
  ) => Effect.Effect<
    AdePrimarySession,
    | AdeBotNotFoundError
    | AdePrimarySessionActiveError
    | AdeSessionBindingConflictError
    | PersistenceSqlError
  >;
  /**
   * Explicit rollover (ADR §12.3 triggers): atomically retires exactly
   * `expectedBindingId` as `historical` (recording the summary on it) and
   * opens the replacement with the full four-component projection. The
   * retire is a compare-and-set — a stale or repeated call fails with
   * `AdeRolloverConflictError` rather than retiring someone else's binding.
   * Crash recovery where the old binding is already `lost` goes through
   * `closeBinding(lost, summary)` + `startPrimarySession` instead.
   */
  readonly rolloverPrimarySession: (
    input: RolloverPrimarySessionInput,
  ) => Effect.Effect<
    AdePrimarySession,
    | AdeBotNotFoundError
    | AdeRolloverConflictError
    | AdeRolloverSummaryLimitExceededError
    | AdeSessionBindingConflictError
    | PersistenceSqlError
  >;
  /** Open a non-primary binding (parallel-work / voice / specialized-work). */
  readonly openBinding: (
    input: OpenBindingInput,
  ) => Effect.Effect<
    BotExecutionBinding,
    AdeBotNotFoundError | AdeSessionBindingConflictError | PersistenceSqlError
  >;
  readonly closeBinding: (
    input: CloseBindingInput,
  ) => Effect.Effect<
    void,
    AdeBindingNotFoundError | AdeRolloverSummaryLimitExceededError | PersistenceSqlError
  >;
  readonly listBindings: (
    botId: BotId,
  ) => Effect.Effect<ReadonlyArray<BotExecutionBinding>, PersistenceSqlError>;
  /**
   * Correct the kernel session id an *existing* binding points at, without
   * retiring it or touching its projection.
   *
   * This is bookkeeping, not a rollover: the durable binding is still the same
   * conversation, but the kernel re-minted its session underneath (an adapter
   * restart, a resume that produced a new native id). Leaving the old id in
   * place would strand every S7 delivery and S8 lookup on a session that no
   * longer exists, so the row has to follow. The same per-engine session
   * uniqueness the index enforces applies here — adopting an id another
   * binding already owns fails with `AdeSessionBindingConflictError` rather
   * than silently re-pointing two bots at one session.
   */
  readonly rebindKernelSession: (input: {
    readonly bindingId: BotExecutionBindingId;
    readonly sessionId: KernelSessionId;
  }) => Effect.Effect<
    BotExecutionBinding,
    AdeBindingNotFoundError | AdeSessionBindingConflictError | PersistenceSqlError
  >;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface BindingRow {
  readonly binding_id: string;
  readonly bot_id: string;
  readonly engine: KernelEngine;
  readonly kernel_session_id: string;
  readonly purpose: BotExecutionBindingPurpose;
  readonly status: BotExecutionBindingStatus;
  readonly rollover_summary: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const rowToBinding = (row: BindingRow): BotExecutionBinding => ({
  id: row.binding_id as BotExecutionBindingId,
  botId: row.bot_id as BotId,
  engine: row.engine,
  sessionId: row.kernel_session_id as KernelSessionId,
  purpose: row.purpose,
  status: row.status,
  rolloverSummary: row.rollover_summary,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class AdeSessionRollover extends Context.Service<
  AdeSessionRollover,
  AdeSessionRolloverShape
>()("shuv2code/ade/AdeSessionRollover") {
  static readonly layer = Layer.effect(
    AdeSessionRollover,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
      const uuid = Effect.sync(() => NodeCrypto.randomUUID());

      /**
       * Component 1, and the ADR §12.1 activation point: the newest persona
       * version wins; if it is still pending, session creation activates it
       * (and stamps `ade_bots.active_persona_version_id`). Earlier pending
       * versions are simply superseded.
       */
      const projectPersona = Effect.fn("AdeSessionRollover.projectPersona")(function* (
        botId: BotId,
        at: string,
      ) {
        const rows = yield* sql<{
          persona_version_id: string;
          content: string;
          activated_at: string | null;
        }>`
          SELECT persona_version_id, content, activated_at FROM ade_persona_versions
          WHERE bot_id = ${botId}
          ORDER BY created_at DESC, rowid DESC
          LIMIT 1
        `;
        const row = rows[0];
        if (row === undefined) {
          // insertBotGraph creates PersonaVersion v1 with every bot.
          return yield* Effect.die(
            new Error(`bot '${botId}' has no persona version — bootstrap invariant broken`),
          );
        }
        if (row.activated_at === null) {
          yield* sql`
            UPDATE ade_persona_versions SET activated_at = ${at}
            WHERE persona_version_id = ${row.persona_version_id}
          `;
          yield* sql`
            UPDATE ade_bots SET active_persona_version_id = ${row.persona_version_id}
            WHERE bot_id = ${botId}
          `;
        }
        return {
          personaVersionId: row.persona_version_id as PersonaVersionId,
          persona: row.content,
        };
      });

      /** Components 2 + 3. */
      const projectMemoryAndAssignments = Effect.fn(
        "AdeSessionRollover.projectMemoryAndAssignments",
      )(function* (botId: BotId) {
        const memoryRows = yield* sql<{ content: string }>`
          SELECT content FROM ade_memory_documents WHERE bot_id = ${botId}
        `;
        const assignmentRows = yield* sql<{
          assignment_id: string;
          instruction: string;
          status: AssignmentStatus;
          blocked_reason: AssignmentBlockedReason | null;
          declared_risk: DeclaredRisk;
          project_id: string | null;
          queue_position: number;
        }>`
          SELECT assignment_id, instruction, status, blocked_reason,
                 declared_risk, project_id, queue_position
          FROM ade_assignments
          WHERE recipient_bot_id = ${botId}
            AND status IN ('queued', 'running', 'blocked')
          ORDER BY queue_position ASC, created_at ASC
        `;
        return {
          memory: memoryRows[0]?.content ?? "",
          activeAssignments: assignmentRows.map(
            (row): AdeProjectedAssignment => ({
              assignmentId: row.assignment_id as AssignmentId,
              instruction: row.instruction,
              status: row.status,
              blockedReason: row.blocked_reason,
              declaredRisk: row.declared_risk,
              projectId: row.project_id as AdeProjectId | null,
              queuePosition: row.queue_position,
            }),
          ),
        };
      });

      const requireBot = Effect.fn("AdeSessionRollover.requireBot")(function* (botId: BotId) {
        const rows = yield* sql<{ bot_id: string }>`
          SELECT bot_id FROM ade_bots WHERE bot_id = ${botId}
        `;
        if (rows.length === 0) return yield* new AdeBotNotFoundError({ botId });
      });

      /** Name the binding that already holds (engine, sessionId), if visible. */
      const sessionBindingConflict = Effect.fn("AdeSessionRollover.sessionBindingConflict")(
        function* (engine: KernelEngine, kernelSessionId: KernelSessionId) {
          const bound = yield* sql<{ binding_id: string; bot_id: string }>`
            SELECT binding_id, bot_id FROM ade_bot_execution_bindings
            WHERE engine = ${engine} AND kernel_session_id = ${kernelSessionId}
          `;
          return yield* new AdeSessionBindingConflictError({
            engine,
            sessionId: kernelSessionId,
            boundBotId: bound[0]?.bot_id ?? null,
            boundBindingId: bound[0]?.binding_id ?? null,
          });
        },
      );

      /**
       * Insert the new active primary binding. `ON CONFLICT DO NOTHING`
       * against the one-active-primary partial index turns a concurrent
       * second start into a refusal that names the surviving binding.
       */
      const insertActivePrimary = Effect.fn("AdeSessionRollover.insertActivePrimary")(function* (
        input: StartPrimarySessionInput,
        at: string,
      ) {
        const bindingId = yield* uuid;
        const inserted = yield* sql<{ binding_id: string }>`
          INSERT INTO ade_bot_execution_bindings (
            binding_id, bot_id, engine, kernel_session_id, purpose, status,
            rollover_summary, created_at, updated_at
          ) VALUES (
            ${bindingId}, ${input.botId}, ${input.engine}, ${input.sessionId},
            'primary-text', 'active', NULL, ${at}, ${at}
          )
          ON CONFLICT DO NOTHING
          RETURNING binding_id
        `;
        if (inserted.length === 1) {
          return {
            id: bindingId as BotExecutionBindingId,
            botId: input.botId,
            engine: input.engine,
            sessionId: input.sessionId,
            purpose: "primary-text",
            status: "active",
            rolloverSummary: null,
            createdAt: at,
            updatedAt: at,
          } satisfies BotExecutionBinding;
        }
        const existing = yield* sql<BindingRow>`
          SELECT * FROM ade_bot_execution_bindings
          WHERE bot_id = ${input.botId} AND purpose = 'primary-text' AND status = 'active'
        `;
        const survivor = existing[0];
        if (survivor === undefined) {
          // The only other unique constraint is (engine, kernel_session_id):
          // the kernel session already belongs to another binding. Typed, not
          // a defect — re-adopting a surviving kernel session (spec §4.2) is
          // the caller's (S7's) decision to make.
          return yield* sessionBindingConflict(input.engine, input.sessionId);
        }
        return yield* new AdePrimarySessionActiveError({
          botId: input.botId,
          existingBindingId: survivor.binding_id,
          existingEngine: survivor.engine,
          existingSessionId: survivor.kernel_session_id,
        });
      });

      const composeProjection = Effect.fn("AdeSessionRollover.composeProjection")(function* (
        botId: BotId,
        at: string,
        outgoingSessionSummary: string | null,
      ) {
        const persona = yield* projectPersona(botId, at);
        const rest = yield* projectMemoryAndAssignments(botId);
        return {
          personaVersionId: persona.personaVersionId,
          persona: persona.persona,
          memory: rest.memory,
          activeAssignments: rest.activeAssignments,
          outgoingSessionSummary,
        } satisfies AdeSessionProjection;
      });

      /**
       * Component-4 recovery for fresh starts (ADR §16 crash recovery): with
       * no active binding to roll over, the most recently retired primary
       * binding's stored summary still reaches the replacement session.
       */
      const lastRetiredPrimarySummary = Effect.fn("AdeSessionRollover.lastRetiredPrimarySummary")(
        function* (botId: BotId) {
          const rows = yield* sql<{ rollover_summary: string | null }>`
          SELECT rollover_summary FROM ade_bot_execution_bindings
          WHERE bot_id = ${botId}
            AND purpose = 'primary-text'
            AND status IN ('historical', 'lost')
          ORDER BY updated_at DESC, rowid DESC
          LIMIT 1
        `;
          return rows[0]?.rollover_summary ?? null;
        },
      );

      const startPrimarySession: AdeSessionRolloverShape["startPrimarySession"] = Effect.fn(
        "AdeSessionRollover.startPrimarySession",
      )(function* (input: StartPrimarySessionInput) {
        const at = yield* nowIso;
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* requireBot(input.botId);
              const recoveredSummary = yield* lastRetiredPrimarySummary(input.botId);
              const binding = yield* insertActivePrimary(input, at);
              const projection = yield* composeProjection(input.botId, at, recoveredSummary);
              return { binding, projection, supersededBindingId: null };
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(toPersistenceSqlError("AdeSessionRollover.startPrimarySession")(cause)),
            ),
          );
      });

      const rolloverPrimarySession: AdeSessionRolloverShape["rolloverPrimarySession"] = Effect.fn(
        "AdeSessionRollover.rolloverPrimarySession",
      )(function* (input: RolloverPrimarySessionInput) {
        if (input.outgoingSummary.length > SESSION_ROLLOVER_SUMMARY_MAX_LENGTH) {
          return yield* new AdeRolloverSummaryLimitExceededError({
            subject: input.botId,
            length: input.outgoingSummary.length,
            limit: SESSION_ROLLOVER_SUMMARY_MAX_LENGTH,
          });
        }
        const at = yield* nowIso;
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* requireBot(input.botId);
              // Compare-and-set: retire exactly the binding the caller
              // observed and summarized. Anything else — already rolled
              // over, closed as lost, or never existed — is a conflict, so
              // a concurrent rollover can never retire the binding its
              // rival just created, and a retried call is a clean failure
              // rather than a double retire.
              const superseded = yield* sql<{ binding_id: string }>`
                UPDATE ade_bot_execution_bindings
                SET status = 'historical',
                    rollover_summary = ${input.outgoingSummary},
                    updated_at = ${at}
                WHERE binding_id = ${input.expectedBindingId}
                  AND bot_id = ${input.botId}
                  AND purpose = 'primary-text'
                  AND status = 'active'
                RETURNING binding_id
              `;
              if (superseded.length === 0) {
                const active = yield* sql<{ binding_id: string; kernel_session_id: string }>`
                  SELECT binding_id, kernel_session_id FROM ade_bot_execution_bindings
                  WHERE bot_id = ${input.botId}
                    AND purpose = 'primary-text'
                    AND status = 'active'
                `;
                return yield* new AdeRolloverConflictError({
                  botId: input.botId,
                  expectedBindingId: input.expectedBindingId,
                  currentActiveBindingId: active[0]?.binding_id ?? null,
                  currentActiveSessionId: active[0]?.kernel_session_id ?? null,
                });
              }
              // With the bot's active row now historical, the partial unique
              // index cannot refuse this insert; a refusal is a session-id
              // collision, surfaced as AdeSessionBindingConflictError.
              const binding = yield* insertActivePrimary(input, at);
              const projection = yield* composeProjection(input.botId, at, input.outgoingSummary);
              return {
                binding,
                projection,
                supersededBindingId: input.expectedBindingId,
              };
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(
                toPersistenceSqlError("AdeSessionRollover.rolloverPrimarySession")(cause),
              ),
            ),
            // Invariant, not input-shaped: the CAS retired the bot's only
            // active primary binding inside this same transaction, so the
            // partial unique index cannot report another one.
            Effect.catchTag("AdePrimarySessionActiveError", (error) => Effect.die(error)),
          );
      });

      const openBinding: AdeSessionRolloverShape["openBinding"] = Effect.fn(
        "AdeSessionRollover.openBinding",
      )(function* (input: OpenBindingInput) {
        const bindingId = yield* uuid;
        const at = yield* nowIso;
        return yield* sql
          .withTransaction(
            Effect.gen(function* () {
              yield* requireBot(input.botId);
              const inserted = yield* sql<{ binding_id: string }>`
                INSERT INTO ade_bot_execution_bindings (
                  binding_id, bot_id, engine, kernel_session_id, purpose, status,
                  rollover_summary, created_at, updated_at
                ) VALUES (
                  ${bindingId}, ${input.botId}, ${input.engine}, ${input.sessionId},
                  ${input.purpose}, 'active', NULL, ${at}, ${at}
                )
                ON CONFLICT DO NOTHING
                RETURNING binding_id
              `;
              if (inserted.length === 0) {
                // (engine, kernel_session_id) is the only reachable unique
                // constraint for non-primary purposes.
                return yield* sessionBindingConflict(input.engine, input.sessionId);
              }
              return {
                id: bindingId as BotExecutionBindingId,
                botId: input.botId,
                engine: input.engine,
                sessionId: input.sessionId,
                purpose: input.purpose,
                status: "active",
                rolloverSummary: null,
                createdAt: at,
                updatedAt: at,
              } satisfies BotExecutionBinding;
            }),
          )
          .pipe(
            Effect.catchTag("SqlError", (cause) =>
              Effect.fail(toPersistenceSqlError("AdeSessionRollover.openBinding")(cause)),
            ),
          );
      });

      const closeBinding: AdeSessionRolloverShape["closeBinding"] = Effect.fn(
        "AdeSessionRollover.closeBinding",
      )(function* (input: CloseBindingInput) {
        const summary = input.summary ?? null;
        if (summary !== null && summary.length > SESSION_ROLLOVER_SUMMARY_MAX_LENGTH) {
          return yield* new AdeRolloverSummaryLimitExceededError({
            subject: input.bindingId,
            length: summary.length,
            limit: SESSION_ROLLOVER_SUMMARY_MAX_LENGTH,
          });
        }
        const at = yield* nowIso;
        const updated = yield* sql<{ binding_id: string }>`
          UPDATE ade_bot_execution_bindings
          SET status = ${input.status},
              rollover_summary = COALESCE(${summary}, rollover_summary),
              updated_at = ${at}
          WHERE binding_id = ${input.bindingId}
          RETURNING binding_id
        `.pipe(Effect.mapError(toPersistenceSqlError("AdeSessionRollover.closeBinding")));
        if (updated.length === 0) {
          return yield* new AdeBindingNotFoundError({ bindingId: input.bindingId });
        }
      });

      const rebindKernelSession: AdeSessionRolloverShape["rebindKernelSession"] = Effect.fn(
        "AdeSessionRollover.rebindKernelSession",
      )(function* (input) {
        const at = yield* nowIso;
        const mapSql = toPersistenceSqlError("AdeSessionRollover.rebindKernelSession");
        const rows = yield* sql<BindingRow>`
          SELECT * FROM ade_bot_execution_bindings WHERE binding_id = ${input.bindingId}
        `.pipe(Effect.mapError(mapSql));
        const row = rows[0];
        if (row === undefined) {
          return yield* new AdeBindingNotFoundError({ bindingId: input.bindingId });
        }
        if (row.kernel_session_id === input.sessionId) return rowToBinding(row);

        // The unique (engine, kernel_session_id) index is the real guard; the
        // pre-check exists only to report *who* holds it.
        const owner = yield* sql<{ binding_id: string; bot_id: string }>`
          SELECT binding_id, bot_id FROM ade_bot_execution_bindings
          WHERE engine = ${row.engine} AND kernel_session_id = ${input.sessionId}
        `.pipe(Effect.mapError(mapSql));
        const held = owner[0];
        if (held !== undefined) {
          return yield* new AdeSessionBindingConflictError({
            engine: row.engine,
            sessionId: input.sessionId,
            boundBotId: held.bot_id,
            boundBindingId: held.binding_id,
          });
        }

        const updated = yield* sql<BindingRow>`
          UPDATE ade_bot_execution_bindings
          SET kernel_session_id = ${input.sessionId}, updated_at = ${at}
          WHERE binding_id = ${input.bindingId}
          RETURNING *
        `.pipe(
          // Losing the race to the uniqueness index between the check above
          // and this write is a conflict, not a persistence fault.
          Effect.catchTag(
            "SqlError",
            () =>
              new AdeSessionBindingConflictError({
                engine: row.engine,
                sessionId: input.sessionId,
                boundBotId: null,
                boundBindingId: null,
              }),
          ),
        );
        const next = updated[0];
        if (next === undefined) {
          return yield* new AdeBindingNotFoundError({ bindingId: input.bindingId });
        }
        return rowToBinding(next);
      });

      const listBindings: AdeSessionRolloverShape["listBindings"] = Effect.fn(
        "AdeSessionRollover.listBindings",
      )(function* (botId: BotId) {
        const rows = yield* sql<BindingRow>`
          SELECT * FROM ade_bot_execution_bindings
          WHERE bot_id = ${botId}
          ORDER BY created_at ASC, rowid ASC
        `.pipe(Effect.mapError(toPersistenceSqlError("AdeSessionRollover.listBindings")));
        return rows.map(rowToBinding);
      });

      return AdeSessionRollover.of({
        startPrimarySession,
        rolloverPrimarySession,
        openBinding,
        closeBinding,
        listBindings,
        rebindKernelSession,
      });
    }),
  );
}
