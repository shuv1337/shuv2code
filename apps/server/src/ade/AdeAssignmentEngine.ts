// @effect-diagnostics nodeBuiltinImport:off
/**
 * ADE assignment engine (spec `docs/ade/ADE-V1-SPEC.md` §4.2 + §2.2,
 * ADR §13/§16.1; issue #161).
 *
 * Owns `ade_assignments` end-to-end:
 *
 * - **Idempotent creation** (ADR §13.6): `(requester, idempotencyKey)` is
 *   unique in the database (`idx_ade_assignments_idempotency`), so a repeated
 *   `create_assignment` — including one replayed after a process restart,
 *   where the tool gate's in-memory dedupe is gone — returns the original
 *   assignment with `created: false` instead of a second row.
 * - **Per-bot FIFO with explicit reorder** (§13.2): `queue_position` orders a
 *   bot's open work; there is no priority scheduler. `reorderQueue` permutes
 *   the *positions currently held by the queued rows*, so running/blocked rows
 *   keep their place in the interleaving.
 * - **Lineage**: `parent_assignment_id` (055 `ON DELETE SET NULL`) plus
 *   depth enforcement against `LimitsConfig.maxDelegationDepth`.
 * - **Blocked states with typed reasons**: `approval | children |
 *   needs-resume | kernel-down`. Admission checks kernel health, closing the
 *   gap the (edge-triggered) S17 health checker leaves for assignments that
 *   enter `running` *during* an outage.
 * - **Steer ≠ cancel, explicit cascade** (§13.4): `cancelAssignment` never
 *   touches ancestors or siblings; `cascade: true` cancels **descendants
 *   only**. Steering lives on the tool side and never changes status.
 * - **Batched child notifications + parental waits** (§13.5):
 *   `waitForChildren` blocks a parent with `children`; the parent's children
 *   are held back from delivery until every one of them is terminal and then
 *   land as **one** batch, releasing the wait.
 * - **Exactly-once delivery** (§13.6) of structured completions as synthetic
 *   input (shuvcode `synthetic`, Codex `inject_items`): a durable three-state
 *   delivery record (`pending → delivering → delivered`) with a persisted
 *   `delivery_attempt_id`. The claim commits *before* the kernel call, so a
 *   crash mid-flight leaves the batch in `delivering` and
 *   `recoverInterruptedDeliveries` re-drives it **with the same
 *   `deliveryKey`** and `redelivery: true` — the kernel port dedupes on that
 *   durable key, which is what makes delivery exactly-once at product level.
 *   A batch is never claimed twice, and a `delivered` batch is never re-sent.
 * - **Recovery** (§4.2, ADR §16): `recoverRunningAssignments` re-adopts
 *   running work whose kernel session is still live and otherwise marks it
 *   `blocked: needs-resume` — never a silent restart. The S8 typed conflicts
 *   (`AdeSessionBindingConflictError` / `AdeRolloverConflictError`) are the
 *   caller-side signal for the same decision; `markNeedsResume` is the seam.
 * - **Stall surfacing** (§13.3 — no auto-retry, no auto-timeout):
 *   `surfaceStalls` opens one Needs You `stall` item per silent running
 *   assignment; leaving `running` resolves it.
 */
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type AdeProjectId,
  type ArtifactRef,
  type Assignment,
  type AssignmentBlockedReason,
  type AssignmentId,
  type AssignmentResult,
  type AssignmentRequester,
  type AssignmentStatus,
  type AssignmentTerminalStatus,
  type BotId,
  type DeclaredRisk,
  type KernelEngine,
  type KernelSessionId,
  LimitsConfig,
} from "@shuv2code/contracts";

import { type PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";
import { forkParked } from "../serverActivation.ts";
import { AdeBotNotFoundError } from "./AdeBootstrap.ts";
import { AdeHealthChecker } from "./AdeHealthChecker.ts";
import { UNTRUSTED_CONTENT_CLOSE, UNTRUSTED_CONTENT_OPEN } from "./AdeSessionRollover.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class AdeAssignmentNotFoundError extends Schema.TaggedErrorClass<AdeAssignmentNotFoundError>()(
  "AdeAssignmentNotFoundError",
  {
    assignmentId: Schema.String,
  },
) {
  override get message(): string {
    return `ADE assignment '${this.assignmentId}' does not exist.`;
  }
}

/** The operation requires an open assignment; this one already settled. */
export class AdeAssignmentTerminalError extends Schema.TaggedErrorClass<AdeAssignmentTerminalError>()(
  "AdeAssignmentTerminalError",
  {
    assignmentId: Schema.String,
    status: Schema.String,
  },
) {
  override get message(): string {
    return `ADE assignment '${this.assignmentId}' is already '${this.status}'.`;
  }
}

/** Archived bots keep their history but accept no new work (spec §2.1). */
export class AdeBotArchivedError extends Schema.TaggedErrorClass<AdeBotArchivedError>()(
  "AdeBotArchivedError",
  {
    botId: Schema.String,
  },
) {
  override get message(): string {
    return `ADE bot '${this.botId}' is archived and cannot receive assignments.`;
  }
}

/**
 * An explicit reorder must name exactly the bot's currently queued
 * assignments — no adds, drops, or duplicates. Reporting `expected` lets the
 * caller re-read and retry against the queue it actually has.
 */
export class AdeQueueReorderMismatchError extends Schema.TaggedErrorClass<AdeQueueReorderMismatchError>()(
  "AdeQueueReorderMismatchError",
  {
    botId: Schema.String,
    expected: Schema.Array(Schema.String),
    provided: Schema.Array(Schema.String),
  },
) {
  override get message(): string {
    return (
      `Reorder for bot '${this.botId}' must be a permutation of its queued assignments ` +
      `[${this.expected.join(", ")}]; got [${this.provided.join(", ")}].`
    );
  }
}

export const ADE_ASSIGNMENT_LIMIT_KINDS = ["queued-per-bot", "delegation-depth"] as const;
export type AdeAssignmentLimitKind = (typeof ADE_ASSIGNMENT_LIMIT_KINDS)[number];

/** ADR §18.1 limits refuse creation instead of silently degrading. */
export class AdeAssignmentLimitExceededError extends Schema.TaggedErrorClass<AdeAssignmentLimitExceededError>()(
  "AdeAssignmentLimitExceededError",
  {
    kind: Schema.String,
    subject: Schema.String,
    limit: Schema.Number,
    observed: Schema.Number,
  },
) {
  override get message(): string {
    return `ADE limit '${this.kind}' exceeded for '${this.subject}': ${this.observed} > ${this.limit}.`;
  }
}

/** A kernel-port call failed; never a defect — callers decide what to do. */
export class AdeAssignmentKernelPortError extends Schema.TaggedErrorClass<AdeAssignmentKernelPortError>()(
  "AdeAssignmentKernelPortError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `ADE kernel port operation '${this.operation}' failed: ${this.detail}`;
  }
}

// ---------------------------------------------------------------------------
// Kernel port seam (S9/S10 wire the live implementation)
// ---------------------------------------------------------------------------

/** Spec §1: shuvcode is the primary kernel for all text work. */
export const ADE_DEFAULT_TEXT_ENGINE: KernelEngine = "shuvcode";

export interface AdeKernelAvailability {
  readonly available: boolean;
  readonly detail?: string;
}

/** One completed assignment inside a delivery batch. */
export interface AdeAssignmentDeliveryItem {
  readonly assignmentId: AssignmentId;
  readonly recipientBotId: BotId;
  readonly instruction: string;
  readonly result: AssignmentResult;
}

/**
 * One exactly-once delivery of structured completions into a bot's active
 * primary session. `deliveryKey` is the durable claim id: it is persisted
 * before the kernel call and reused verbatim on every redelivery, so the port
 * (and the kernel-side payload metadata) can dedupe a crash-window replay.
 */
export interface AdeAssignmentDeliveryBatch {
  readonly deliveryKey: string;
  readonly redelivery: boolean;
  readonly targetBotId: BotId;
  readonly engine: KernelEngine;
  readonly sessionId: KernelSessionId;
  readonly items: ReadonlyArray<AdeAssignmentDeliveryItem>;
  /** Set when this batch settles a parental wait (§13.5). */
  readonly parentAssignmentId: AssignmentId | null;
  /** Rendered synthetic-input text; bot-authored content is fenced. */
  readonly text: string;
}

export interface AdeAssignmentKernelPortShape {
  /** Admission-time kernel availability (S17 health, or a direct probe). */
  readonly kernelHealth: (engine: KernelEngine) => Effect.Effect<AdeKernelAvailability>;
  /** Deliver one batch as synthetic input (shuvcode `synthetic` / Codex `inject_items`). */
  readonly deliverResults: (
    batch: AdeAssignmentDeliveryBatch,
  ) => Effect.Effect<void, AdeAssignmentKernelPortError>;
  /** Steer a live primary session (never interrupts — steer ≠ cancel). */
  readonly steerPrimary: (input: {
    readonly botId: BotId;
    readonly engine: KernelEngine;
    readonly sessionId: KernelSessionId;
    readonly text: string;
  }) => Effect.Effect<void, AdeAssignmentKernelPortError>;
  /** Is this kernel session still live and adoptable after a restart? */
  readonly isSessionLive: (input: {
    readonly engine: KernelEngine;
    readonly sessionId: KernelSessionId;
  }) => Effect.Effect<boolean>;
}

/**
 * Default until S9/S10 wire the kernels: health is *not* asserted down (an
 * unwired port must not block every admission), but nothing can be delivered
 * or steered, and no session is adoptable — so recovery takes the
 * conservative `needs-resume` path rather than a silent restart.
 */
export const adeAssignmentKernelPortUnwired: AdeAssignmentKernelPortShape = {
  kernelHealth: () => Effect.succeed({ available: true } as const),
  deliverResults: () =>
    Effect.fail(
      new AdeAssignmentKernelPortError({
        operation: "deliverResults",
        detail: "no kernel port is wired in this build",
      }),
    ),
  steerPrimary: () =>
    Effect.fail(
      new AdeAssignmentKernelPortError({
        operation: "steerPrimary",
        detail: "no kernel port is wired in this build",
      }),
    ),
  isSessionLive: () => Effect.succeed(false),
};

export class AdeAssignmentKernelPort extends Context.Service<
  AdeAssignmentKernelPort,
  AdeAssignmentKernelPortShape
>()("shuv2code/ade/AdeAssignmentKernelPort") {
  static readonly layerUnwired = Layer.succeed(
    AdeAssignmentKernelPort,
    adeAssignmentKernelPortUnwired,
  );

  /**
   * Admission-grade health backed by the S17 checker's latest snapshot, with
   * delivery/steer/adoption still unwired. This is what makes admission
   * during an outage correct before S9 supplies the real kernels: `unknown`
   * (pre-first-probe) and `not-provisioned` are not outages, only `down` is.
   */
  static readonly layerHealthFromChecker: Layer.Layer<
    AdeAssignmentKernelPort,
    never,
    AdeHealthChecker
  > = Layer.effect(
    AdeAssignmentKernelPort,
    Effect.gen(function* () {
      const checker = yield* AdeHealthChecker;
      return {
        ...adeAssignmentKernelPortUnwired,
        kernelHealth: (engine: KernelEngine) =>
          Effect.map(checker.latest, (snapshot) => {
            const target = snapshot.targets.find((entry) => entry.target === engine);
            return target?.state === "down"
              ? ({ available: false, detail: target.detail ?? `${engine} is down` } as const)
              : ({ available: true } as const);
          }),
      };
    }),
  );
}

// ---------------------------------------------------------------------------
// Service shape
// ---------------------------------------------------------------------------

export interface CreateAssignmentEngineInput {
  readonly requester: AssignmentRequester;
  readonly recipientBotId: BotId;
  readonly instruction: string;
  readonly idempotencyKey: string;
  readonly declaredRisk?: DeclaredRisk;
  readonly projectId?: AdeProjectId | null;
  readonly parentAssignmentId?: AssignmentId | null;
}

export interface CreateAssignmentOutcome {
  readonly assignment: Assignment;
  /** False when `(requester, idempotencyKey)` already existed (ADR §13.6). */
  readonly created: boolean;
}

export interface ReportAssignmentResultEngineInput {
  readonly assignmentId: AssignmentId;
  readonly status: AssignmentTerminalStatus;
  readonly summary: string;
  readonly artifacts?: ReadonlyArray<ArtifactRef>;
}

export interface ReportAssignmentResultOutcome {
  readonly assignment: Assignment;
  /** False when the assignment had already settled (replayed tool call). */
  readonly recorded: boolean;
}

export interface CancelAssignmentInput {
  readonly assignmentId: AssignmentId;
  /** Descendants only, never ancestors or siblings (§13.4). */
  readonly cascade: boolean;
  readonly summary?: string;
}

export interface CancelAssignmentOutcome {
  readonly cancelled: ReadonlyArray<AssignmentId>;
}

export interface StartAssignmentOptions {
  /**
   * The kernel that will serve this assignment when the recipient has no
   * active primary binding yet. Defaults to
   * {@link ADE_DEFAULT_TEXT_ENGINE} (spec §1: shuvcode is the primary kernel
   * for all text work).
   */
  readonly engine?: KernelEngine;
}

export interface StartAssignmentOutcome {
  readonly assignment: Assignment;
  /**
   * True when admission found the serving kernel down. Work that had not
   * started stays `queued` (queue-and-alert, ADR §11.3); only work already
   * `running` is flipped to `blocked: kernel-down`.
   */
  readonly blockedByKernel: boolean;
}

export interface WaitForChildrenOutcome {
  readonly parent: Assignment;
  /** False when every child was already terminal — nothing to wait for. */
  readonly waiting: boolean;
  readonly outstandingChildren: ReadonlyArray<AssignmentId>;
}

export interface DeliverPendingOutcome {
  readonly delivered: ReadonlyArray<AdeAssignmentDeliveryBatch>;
  /** Batches whose kernel call failed; their rows returned to `pending`. */
  readonly failed: ReadonlyArray<AdeAssignmentDeliveryBatch>;
  /** Bots with deliverable results but no active primary session yet. */
  readonly deferredBotIds: ReadonlyArray<BotId>;
}

export interface RecoverRunningOutcome {
  readonly adopted: ReadonlyArray<AssignmentId>;
  readonly needsResume: ReadonlyArray<AssignmentId>;
}

export interface SurfaceStallsInput {
  /** How long a `running` assignment may go without progress (§13.3). */
  readonly stallAfter: Duration.Duration;
}

export interface AdeAssignmentEngineShape {
  readonly createAssignment: (
    input: CreateAssignmentEngineInput,
  ) => Effect.Effect<
    CreateAssignmentOutcome,
    | AdeAssignmentLimitExceededError
    | AdeAssignmentNotFoundError
    | AdeBotArchivedError
    | AdeBotNotFoundError
    | PersistenceSqlError
  >;
  readonly getAssignment: (
    assignmentId: AssignmentId,
  ) => Effect.Effect<Assignment | null, PersistenceSqlError>;
  readonly listForBot: (
    botId: BotId,
    options?: { readonly statuses?: ReadonlyArray<AssignmentStatus> },
  ) => Effect.Effect<ReadonlyArray<Assignment>, PersistenceSqlError>;
  readonly listChildren: (
    parentAssignmentId: AssignmentId,
  ) => Effect.Effect<ReadonlyArray<Assignment>, PersistenceSqlError>;
  /** Explicit reorder: `orderedQueuedIds` must permute the bot's queued rows. */
  readonly reorderQueue: (
    botId: BotId,
    orderedQueuedIds: ReadonlyArray<AssignmentId>,
  ) => Effect.Effect<ReadonlyArray<Assignment>, AdeQueueReorderMismatchError | PersistenceSqlError>;
  readonly nextQueued: (botId: BotId) => Effect.Effect<Assignment | null, PersistenceSqlError>;
  /** Admit queued/blocked work into `running`, refusing on a down kernel. */
  readonly startAssignment: (
    assignmentId: AssignmentId,
    options?: StartAssignmentOptions,
  ) => Effect.Effect<
    StartAssignmentOutcome,
    AdeAssignmentNotFoundError | AdeAssignmentTerminalError | PersistenceSqlError
  >;
  /** Record forward progress (resets the stall clock). */
  readonly noteProgress: (
    assignmentId: AssignmentId,
  ) => Effect.Effect<void, AdeAssignmentNotFoundError | PersistenceSqlError>;
  readonly blockAssignment: (
    assignmentId: AssignmentId,
    reason: AssignmentBlockedReason,
  ) => Effect.Effect<
    Assignment,
    AdeAssignmentNotFoundError | AdeAssignmentTerminalError | PersistenceSqlError
  >;
  /** Shorthand for the ADR §16 recovery decision on one assignment. */
  readonly markNeedsResume: (
    assignmentId: AssignmentId,
  ) => Effect.Effect<
    Assignment,
    AdeAssignmentNotFoundError | AdeAssignmentTerminalError | PersistenceSqlError
  >;
  readonly releaseAssignment: (
    assignmentId: AssignmentId,
    toStatus?: Extract<AssignmentStatus, "queued" | "running">,
  ) => Effect.Effect<
    Assignment,
    AdeAssignmentNotFoundError | AdeAssignmentTerminalError | PersistenceSqlError
  >;
  /** Park a parent on its outstanding children (§13.5 parental wait). */
  readonly waitForChildren: (
    parentAssignmentId: AssignmentId,
  ) => Effect.Effect<
    WaitForChildrenOutcome,
    AdeAssignmentNotFoundError | AdeAssignmentTerminalError | PersistenceSqlError
  >;
  readonly cancelAssignment: (
    input: CancelAssignmentInput,
  ) => Effect.Effect<
    CancelAssignmentOutcome,
    AdeAssignmentNotFoundError | AdeAssignmentTerminalError | PersistenceSqlError
  >;
  readonly reportResult: (
    input: ReportAssignmentResultEngineInput,
  ) => Effect.Effect<
    ReportAssignmentResultOutcome,
    AdeAssignmentNotFoundError | PersistenceSqlError
  >;
  /** Claim, send, and record every deliverable batch. Safe to call repeatedly. */
  readonly deliverPending: () => Effect.Effect<DeliverPendingOutcome, PersistenceSqlError>;
  /** Re-drive batches left `delivering` by a crash, with the same delivery key. */
  readonly recoverInterruptedDeliveries: () => Effect.Effect<
    DeliverPendingOutcome,
    PersistenceSqlError
  >;
  /** Re-adopt live running work; everything else becomes `needs-resume`. */
  readonly recoverRunningAssignments: () => Effect.Effect<
    RecoverRunningOutcome,
    PersistenceSqlError
  >;
  /** Open one Needs You `stall` item per silent running assignment (§13.3). */
  readonly surfaceStalls: (
    input: SurfaceStallsInput,
  ) => Effect.Effect<ReadonlyArray<AssignmentId>, PersistenceSqlError>;
}

// ---------------------------------------------------------------------------
// Rows & rendering
// ---------------------------------------------------------------------------

interface AssignmentRow {
  readonly assignment_id: string;
  readonly idempotency_key: string;
  readonly requester_kind: "bot" | "captain";
  readonly requester_bot_id: string | null;
  readonly recipient_bot_id: string;
  readonly project_id: string | null;
  readonly instruction: string;
  readonly declared_risk: DeclaredRisk;
  readonly parent_assignment_id: string | null;
  readonly status: AssignmentStatus;
  readonly blocked_reason: AssignmentBlockedReason | null;
  readonly queue_position: number;
  readonly result_json: string | null;
  readonly delivered: number;
  readonly delivered_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

const TERMINAL_STATUSES: ReadonlySet<AssignmentStatus> = new Set<AssignmentStatus>([
  "completed",
  "failed",
  "cancelled",
]);

const isTerminal = (status: AssignmentStatus): boolean => TERMINAL_STATUSES.has(status);

const parseResult = (json: string | null): AssignmentResult | null =>
  json === null ? null : (JSON.parse(json) as AssignmentResult);

const rowToAssignment = (row: AssignmentRow): Assignment => ({
  id: row.assignment_id as AssignmentId,
  idempotencyKey: row.idempotency_key as Assignment["idempotencyKey"],
  requester:
    row.requester_kind === "bot"
      ? { _tag: "bot", botId: row.requester_bot_id as BotId }
      : { _tag: "captain" },
  recipientBotId: row.recipient_bot_id as BotId,
  projectId: row.project_id as AdeProjectId | null,
  instruction: row.instruction as Assignment["instruction"],
  declaredRisk: row.declared_risk,
  parentAssignmentId: row.parent_assignment_id as AssignmentId | null,
  status: row.status,
  blockedReason: row.blocked_reason,
  queuePosition: row.queue_position as Assignment["queuePosition"],
  result: parseResult(row.result_json),
  delivery: { delivered: row.delivered === 1, deliveredAt: row.delivered_at },
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Fence bot-authored content (summaries, instructions) inside the synthetic
 * message: everything between the markers is data, not instructions. Mirrors
 * the S8 projection fence, including defanging embedded delimiters.
 */
const fence = (content: string): string =>
  `${UNTRUSTED_CONTENT_OPEN}\n${content
    .replaceAll(UNTRUSTED_CONTENT_CLOSE, "<< /untrusted-content >>")
    .replaceAll(UNTRUSTED_CONTENT_OPEN, "<< untrusted-content >>")}\n${UNTRUSTED_CONTENT_CLOSE}`;

const renderArtifact = (artifact: ArtifactRef): string => {
  switch (artifact._tag) {
    case "jjChange":
      return `jj change ${artifact.changeId} (project ${artifact.projectId})`;
    case "publicationLayer":
      return `publication layer ${artifact.layerId} (stack ${artifact.stackId})`;
    case "file":
      return `file ${artifact.path}`;
    case "url":
      return `url ${artifact.href}`;
  }
};

/**
 * The synthetic-input body for one batch (§13.5 batched child
 * notifications): one message per drain, not one per completion.
 */
export const renderAssignmentDeliveryText = (input: {
  readonly items: ReadonlyArray<AdeAssignmentDeliveryItem>;
  readonly parentAssignmentId: AssignmentId | null;
}): string => {
  const header =
    input.items.length === 1
      ? "An assignment you delegated has finished."
      : `${input.items.length} assignments you delegated have finished.`;
  const waitNote =
    input.parentAssignmentId === null
      ? ""
      : `\nThese complete the children you were waiting on for assignment ${input.parentAssignmentId}.`;
  const blocks = input.items.map((item) => {
    const artifacts =
      item.result.artifacts.length === 0
        ? ""
        : `\nArtifacts:\n${item.result.artifacts.map((artifact) => `- ${renderArtifact(artifact)}`).join("\n")}`;
    return (
      `### Assignment ${item.assignmentId} — ${item.result.status} (bot ${item.recipientBotId})\n` +
      `Instruction:\n${fence(item.instruction)}\n` +
      `Summary:\n${fence(item.result.summary)}${artifacts}`
    );
  });
  return `${header}${waitNote}\n\n${blocks.join("\n\n")}`;
};

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface DeliverableRow extends AssignmentRow {
  readonly delivery_state: string;
  readonly delivery_attempt_id: string | null;
  readonly delivery_claimed_at: string | null;
  readonly delivery_attempts: number;
  readonly delivery_parent_assignment_id: string | null;
}

/**
 * How long a delivery claim is treated as live before recovery may re-drive
 * it. Redelivery reuses the claim's key, so this only decides *when* a
 * suspected-dead attempt is retried, never whether it can duplicate.
 */
export const ADE_DELIVERY_LEASE_DEFAULT = Duration.minutes(2);

/** Ceiling on the exponential retry backoff, in lease multiples. */
export const ADE_DELIVERY_MAX_BACKOFF_FACTOR = 32;

/** How often the engine's own sweep drains and re-drives deliveries. */
export const ADE_DELIVERY_SWEEP_INTERVAL_DEFAULT = Duration.seconds(30);

export interface AdeAssignmentEngineOptions {
  /** Overrides {@link ADE_DELIVERY_LEASE_DEFAULT} (tests use a short lease). */
  readonly deliveryLease?: Duration.Duration;
}

export class AdeAssignmentEngine extends Context.Service<
  AdeAssignmentEngine,
  AdeAssignmentEngineShape
>()("shuv2code/ade/AdeAssignmentEngine") {
  static readonly layerWith = (
    options: AdeAssignmentEngineOptions = {},
  ): Layer.Layer<AdeAssignmentEngine, never, SqlClient.SqlClient | AdeAssignmentKernelPort> =>
    Layer.effect(
      AdeAssignmentEngine,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const port = yield* AdeAssignmentKernelPort;
        const deliveryLease = options.deliveryLease ?? ADE_DELIVERY_LEASE_DEFAULT;

        const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
        const uuid = Effect.sync(() => NodeCrypto.randomUUID());
        const decodeLimits = Schema.decodeUnknownEffect(LimitsConfig);
        const decodeLimitsJson = Schema.decodeEffect(Schema.fromJsonString(LimitsConfig));

        const mapSql = (op: string) => toPersistenceSqlError(`AdeAssignmentEngine.${op}`);

        /** Seeded by the S3 bootstrap; fall back to the ADR §18.1 defaults. */
        const readLimits = Effect.gen(function* () {
          const rows = yield* sql<{ config_json: string }>`
          SELECT config_json FROM ade_limits_config WHERE id = 1
        `;
          const json = rows[0]?.config_json;
          return json === undefined
            ? yield* Effect.orDie(decodeLimits({}))
            : yield* Effect.orDie(decodeLimitsJson(json));
        });

        const selectRow = Effect.fn("AdeAssignmentEngine.selectRow")(function* (
          assignmentId: AssignmentId,
        ) {
          const rows = yield* sql<AssignmentRow>`
          SELECT * FROM ade_assignments WHERE assignment_id = ${assignmentId}
        `;
          return rows[0] ?? null;
        });

        const requireRow = Effect.fn("AdeAssignmentEngine.requireRow")(function* (
          assignmentId: AssignmentId,
        ) {
          const row = yield* selectRow(assignmentId);
          if (row === null) return yield* new AdeAssignmentNotFoundError({ assignmentId });
          return row;
        });

        const requireOpenRow = Effect.fn("AdeAssignmentEngine.requireOpenRow")(function* (
          assignmentId: AssignmentId,
        ) {
          const row = yield* requireRow(assignmentId);
          if (isTerminal(row.status)) {
            return yield* new AdeAssignmentTerminalError({ assignmentId, status: row.status });
          }
          return row;
        });

        /** Any open Needs You stall item for this assignment is resolved on exit. */
        const resolveStallItems = Effect.fn("AdeAssignmentEngine.resolveStallItems")(function* (
          assignmentId: AssignmentId,
          at: string,
        ) {
          yield* sql`
          UPDATE ade_needs_you_items
          SET status = 'resolved', updated_at = ${at}, resolved_at = ${at}
          WHERE kind = 'stall'
            AND status = 'open'
            AND subject_refs_json LIKE ${`%"assignmentId":"${assignmentId}"%`}
        `;
        });

        // -- creation -----------------------------------------------------------

        const lineageDepth = Effect.fn("AdeAssignmentEngine.lineageDepth")(function* (
          parentAssignmentId: AssignmentId,
        ) {
          // Depth 1 = a root assignment. Walk up the (short, ADR §18.1-bounded)
          // lineage; a missing parent is reported to the caller, and the loop
          // guard makes a corrupted cycle a bounded failure rather than a hang.
          let depth = 1;
          let cursor: string | null = parentAssignmentId;
          while (cursor !== null) {
            const row: AssignmentRow | null = yield* selectRow(cursor as AssignmentId);
            if (row === null) {
              return yield* new AdeAssignmentNotFoundError({ assignmentId: cursor });
            }
            depth += 1;
            cursor = row.parent_assignment_id;
            if (depth > 1_000) {
              return yield* Effect.die(
                new Error(`assignment lineage above '${parentAssignmentId}' is cyclic`),
              );
            }
          }
          return depth;
        });

        /** The row already holding this requester's idempotency key, if any. */
        const existingForKey = Effect.fn("AdeAssignmentEngine.existingForKey")(function* (
          input: CreateAssignmentEngineInput,
          requesterBotId: BotId | null,
        ) {
          const rows = yield* sql<AssignmentRow>`
          SELECT * FROM ade_assignments
          WHERE requester_kind = ${input.requester._tag}
            AND COALESCE(requester_bot_id, '') = ${requesterBotId ?? ""}
            AND idempotency_key = ${input.idempotencyKey}
        `;
          return rows[0] ?? null;
        });

        const createAssignment: AdeAssignmentEngineShape["createAssignment"] = Effect.fn(
          "AdeAssignmentEngine.createAssignment",
        )(function* (input: CreateAssignmentEngineInput) {
          const assignmentId = yield* uuid;
          const at = yield* nowIso;
          const requesterBotId = input.requester._tag === "bot" ? input.requester.botId : null;
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                // Idempotent replay wins before every guard (ADR §13.6): a call
                // replayed after a restart — when the gate's in-memory dedupe is
                // gone — must return the assignment it already created, even if
                // the recipient has since been archived or the bot has since
                // filled its queue. Guards apply to *new* work only.
                const replay = yield* existingForKey(input, requesterBotId);
                if (replay !== null) {
                  return { assignment: rowToAssignment(replay), created: false };
                }

                const recipient = yield* sql<{ bot_id: string; archived_at: string | null }>`
                SELECT bot_id, archived_at FROM ade_bots WHERE bot_id = ${input.recipientBotId}
              `;
                const recipientRow = recipient[0];
                if (recipientRow === undefined) {
                  return yield* new AdeBotNotFoundError({ botId: input.recipientBotId });
                }
                if (recipientRow.archived_at !== null) {
                  return yield* new AdeBotArchivedError({ botId: input.recipientBotId });
                }

                const limits = yield* readLimits;
                const parentAssignmentId = input.parentAssignmentId ?? null;
                if (parentAssignmentId !== null) {
                  const depth = yield* lineageDepth(parentAssignmentId);
                  if (depth > limits.maxDelegationDepth) {
                    return yield* new AdeAssignmentLimitExceededError({
                      kind: "delegation-depth",
                      subject: parentAssignmentId,
                      limit: limits.maxDelegationDepth,
                      observed: depth,
                    });
                  }
                }
                const queued = yield* sql<{ count: number }>`
                SELECT COUNT(*) AS count FROM ade_assignments
                WHERE recipient_bot_id = ${input.recipientBotId} AND status = 'queued'
              `;
                const queuedCount = queued[0]?.count ?? 0;
                if (queuedCount + 1 > limits.maxQueuedAssignmentsPerBot) {
                  return yield* new AdeAssignmentLimitExceededError({
                    kind: "queued-per-bot",
                    subject: input.recipientBotId,
                    limit: limits.maxQueuedAssignmentsPerBot,
                    observed: queuedCount + 1,
                  });
                }

                // FIFO tail: one past the last open position for this bot.
                const tail = yield* sql<{ next_position: number }>`
                SELECT COALESCE(MAX(queue_position) + 1, 0) AS next_position
                FROM ade_assignments
                WHERE recipient_bot_id = ${input.recipientBotId}
                  AND status IN ('queued', 'running', 'blocked')
              `;
                const queuePosition = tail[0]?.next_position ?? 0;

                const inserted = yield* sql<{ assignment_id: string }>`
                INSERT INTO ade_assignments (
                  assignment_id, idempotency_key, requester_kind, requester_bot_id,
                  recipient_bot_id, project_id, instruction, declared_risk,
                  parent_assignment_id, status, blocked_reason, queue_position,
                  result_json, delivered, delivered_at, delivery_state,
                  delivery_attempt_id, created_at, updated_at
                ) VALUES (
                  ${assignmentId}, ${input.idempotencyKey}, ${input.requester._tag},
                  ${requesterBotId}, ${input.recipientBotId}, ${input.projectId ?? null},
                  ${input.instruction}, ${input.declaredRisk ?? "normal"},
                  ${parentAssignmentId}, 'queued', NULL, ${queuePosition},
                  NULL, 0, NULL, 'pending', NULL, ${at}, ${at}
                )
                ON CONFLICT DO NOTHING
                RETURNING assignment_id
              `;
                if (inserted.length === 0) {
                  // Lost the race against a concurrent identical request; the
                  // unique index on (requester_kind, COALESCE(requester_bot_id,
                  // ''), key) already holds it.
                  const row = yield* existingForKey(input, requesterBotId);
                  if (row === null) {
                    return yield* Effect.die(
                      new Error(
                        `assignment insert for key '${input.idempotencyKey}' conflicted but no row exists`,
                      ),
                    );
                  }
                  return { assignment: rowToAssignment(row), created: false };
                }
                const row = yield* requireRow(assignmentId as AssignmentId);
                return { assignment: rowToAssignment(row), created: true };
              }),
            )
            .pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(mapSql("createAssignment")(cause)),
              ),
            );
        });

        // -- reads --------------------------------------------------------------

        const getAssignment: AdeAssignmentEngineShape["getAssignment"] = (assignmentId) =>
          selectRow(assignmentId).pipe(
            Effect.map((row) => (row === null ? null : rowToAssignment(row))),
            Effect.mapError(mapSql("getAssignment")),
          );

        const listForBot: AdeAssignmentEngineShape["listForBot"] = (botId, options) =>
          sql<AssignmentRow>`
          SELECT * FROM ade_assignments
          WHERE recipient_bot_id = ${botId}
          ORDER BY queue_position ASC, created_at ASC, rowid ASC
        `.pipe(
            Effect.map((rows) =>
              rows
                .filter(
                  (row) => options?.statuses === undefined || options.statuses.includes(row.status),
                )
                .map(rowToAssignment),
            ),
            Effect.mapError(mapSql("listForBot")),
          );

        const listChildren: AdeAssignmentEngineShape["listChildren"] = (parentAssignmentId) =>
          sql<AssignmentRow>`
          SELECT * FROM ade_assignments
          WHERE parent_assignment_id = ${parentAssignmentId}
          ORDER BY created_at ASC, rowid ASC
        `.pipe(
            Effect.map((rows) => rows.map(rowToAssignment)),
            Effect.mapError(mapSql("listChildren")),
          );

        const nextQueued: AdeAssignmentEngineShape["nextQueued"] = (botId) =>
          sql<AssignmentRow>`
          SELECT * FROM ade_assignments
          WHERE recipient_bot_id = ${botId} AND status = 'queued'
          ORDER BY queue_position ASC, created_at ASC, rowid ASC
          LIMIT 1
        `.pipe(
            Effect.map((rows) => (rows[0] === undefined ? null : rowToAssignment(rows[0]))),
            Effect.mapError(mapSql("nextQueued")),
          );

        // -- queue --------------------------------------------------------------

        const reorderQueue: AdeAssignmentEngineShape["reorderQueue"] = Effect.fn(
          "AdeAssignmentEngine.reorderQueue",
        )(function* (botId: BotId, orderedQueuedIds: ReadonlyArray<AssignmentId>) {
          const at = yield* nowIso;
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const rows = yield* sql<AssignmentRow>`
                SELECT * FROM ade_assignments
                WHERE recipient_bot_id = ${botId} AND status = 'queued'
                ORDER BY queue_position ASC, created_at ASC, rowid ASC
              `;
                const expected = rows.map((row) => row.assignment_id);
                const provided = [...orderedQueuedIds];
                const samePermutation =
                  expected.length === provided.length &&
                  new Set(provided).size === provided.length &&
                  provided.every((id) => expected.includes(id));
                if (!samePermutation) {
                  return yield* new AdeQueueReorderMismatchError({ botId, expected, provided });
                }
                // Permute the positions the queued rows already occupy, so any
                // interleaved running/blocked rows keep their place in the FIFO.
                const positions = rows.map((row) => row.queue_position).sort((a, b) => a - b);
                yield* Effect.forEach(
                  provided,
                  (assignmentId, index) => sql`
                  UPDATE ade_assignments
                  SET queue_position = ${positions[index] ?? index}, updated_at = ${at}
                  WHERE assignment_id = ${assignmentId}
                `,
                  { discard: true },
                );
                const updated = yield* sql<AssignmentRow>`
                SELECT * FROM ade_assignments
                WHERE recipient_bot_id = ${botId} AND status = 'queued'
                ORDER BY queue_position ASC, created_at ASC, rowid ASC
              `;
                return updated.map(rowToAssignment);
              }),
            )
            .pipe(
              Effect.catchTag("SqlError", (cause) => Effect.fail(mapSql("reorderQueue")(cause))),
            );
        });

        // -- status transitions -------------------------------------------------

        const setStatus = Effect.fn("AdeAssignmentEngine.setStatus")(function* (input: {
          readonly assignmentId: AssignmentId;
          readonly status: AssignmentStatus;
          readonly blockedReason: AssignmentBlockedReason | null;
          readonly at: string;
        }) {
          yield* sql`
          UPDATE ade_assignments
          SET status = ${input.status}, blocked_reason = ${input.blockedReason}, updated_at = ${input.at}
          WHERE assignment_id = ${input.assignmentId}
        `;
          if (input.status !== "running") {
            yield* resolveStallItems(input.assignmentId, input.at);
          }
          return rowToAssignment(yield* requireRow(input.assignmentId));
        });

        /** The engine the recipient bot is currently bound to, if any. */
        const activePrimaryBinding = Effect.fn("AdeAssignmentEngine.activePrimaryBinding")(
          function* (botId: BotId) {
            const rows = yield* sql<{ engine: KernelEngine; kernel_session_id: string }>`
          SELECT engine, kernel_session_id FROM ade_bot_execution_bindings
          WHERE bot_id = ${botId} AND purpose = 'primary-text' AND status = 'active'
          ORDER BY updated_at DESC, rowid DESC
          LIMIT 1
        `;
            const row = rows[0];
            return row === undefined
              ? null
              : { engine: row.engine, sessionId: row.kernel_session_id as KernelSessionId };
          },
        );

        const startAssignment: AdeAssignmentEngineShape["startAssignment"] = Effect.fn(
          "AdeAssignmentEngine.startAssignment",
        )(function* (assignmentId: AssignmentId, options: StartAssignmentOptions = {}) {
          const at = yield* nowIso;
          const row = yield* requireOpenRow(assignmentId).pipe(
            Effect.catchTag("SqlError", (cause) => Effect.fail(mapSql("startAssignment")(cause))),
          );
          const binding = yield* activePrimaryBinding(row.recipient_bot_id as BotId).pipe(
            Effect.catchTag("SqlError", (cause) => Effect.fail(mapSql("startAssignment")(cause))),
          );
          // Admission-time kernel check against the engine that will actually
          // serve this bot: its active binding, the caller's explicit choice,
          // or — for a bot with no session yet — the default text kernel. The
          // S17 checker is edge-triggered, so first-assignment admission during
          // an outage would otherwise sail straight into `running`.
          const servingEngine = options.engine ?? binding?.engine ?? ADE_DEFAULT_TEXT_ENGINE;
          const health = yield* port.kernelHealth(servingEngine);
          if (!health.available) {
            // Queue-and-alert (ADR §11.3): work that never started stays
            // exactly where it is. Only *running* work becomes
            // `blocked: kernel-down`, which keeps the S17 release honest — it
            // only promotes rows that were running when the kernel went away.
            if (row.status !== "running") {
              return { assignment: rowToAssignment(row), blockedByKernel: true };
            }
            const blocked = yield* setStatus({
              assignmentId,
              status: "blocked",
              blockedReason: "kernel-down",
              at,
            }).pipe(
              Effect.catchTag("SqlError", (cause) => Effect.fail(mapSql("startAssignment")(cause))),
            );
            return { assignment: blocked, blockedByKernel: true };
          }
          const running = yield* setStatus({
            assignmentId,
            status: "running",
            blockedReason: null,
            at,
          }).pipe(
            Effect.catchTag("SqlError", (cause) => Effect.fail(mapSql("startAssignment")(cause))),
          );
          return { assignment: running, blockedByKernel: false };
        });

        const noteProgress: AdeAssignmentEngineShape["noteProgress"] = Effect.fn(
          "AdeAssignmentEngine.noteProgress",
        )(function* (assignmentId: AssignmentId) {
          const at = yield* nowIso;
          const updated = yield* sql<{ assignment_id: string }>`
          UPDATE ade_assignments SET updated_at = ${at}
          WHERE assignment_id = ${assignmentId}
          RETURNING assignment_id
        `.pipe(Effect.mapError(mapSql("noteProgress")));
          if (updated.length === 0) return yield* new AdeAssignmentNotFoundError({ assignmentId });
        });

        const blockAssignment: AdeAssignmentEngineShape["blockAssignment"] = Effect.fn(
          "AdeAssignmentEngine.blockAssignment",
        )(
          function* (assignmentId: AssignmentId, reason: AssignmentBlockedReason) {
            const at = yield* nowIso;
            yield* requireOpenRow(assignmentId);
            return yield* setStatus({ assignmentId, status: "blocked", blockedReason: reason, at });
          },
          Effect.catchTag("SqlError", (cause) => Effect.fail(mapSql("blockAssignment")(cause))),
        );

        const markNeedsResume: AdeAssignmentEngineShape["markNeedsResume"] = (assignmentId) =>
          blockAssignment(assignmentId, "needs-resume");

        const releaseAssignment: AdeAssignmentEngineShape["releaseAssignment"] = Effect.fn(
          "AdeAssignmentEngine.releaseAssignment",
        )(
          function* (
            assignmentId: AssignmentId,
            toStatus: Extract<AssignmentStatus, "queued" | "running"> = "running",
          ) {
            const at = yield* nowIso;
            yield* requireOpenRow(assignmentId);
            return yield* setStatus({ assignmentId, status: toStatus, blockedReason: null, at });
          },
          Effect.catchTag("SqlError", (cause) => Effect.fail(mapSql("releaseAssignment")(cause))),
        );

        const waitForChildren: AdeAssignmentEngineShape["waitForChildren"] = Effect.fn(
          "AdeAssignmentEngine.waitForChildren",
        )(
          function* (parentAssignmentId: AssignmentId) {
            const at = yield* nowIso;
            yield* requireOpenRow(parentAssignmentId);
            const outstanding = yield* sql<{ assignment_id: string }>`
          SELECT assignment_id FROM ade_assignments
          WHERE parent_assignment_id = ${parentAssignmentId}
            AND status NOT IN ('completed', 'failed', 'cancelled')
          ORDER BY created_at ASC, rowid ASC
        `;
            if (outstanding.length === 0) {
              const parent = rowToAssignment(yield* requireRow(parentAssignmentId));
              return { parent, waiting: false, outstandingChildren: [] };
            }
            const parent = yield* setStatus({
              assignmentId: parentAssignmentId,
              status: "blocked",
              blockedReason: "children",
              at,
            });
            return {
              parent,
              waiting: true,
              outstandingChildren: outstanding.map((row) => row.assignment_id as AssignmentId),
            };
          },
          Effect.catchTag("SqlError", (cause) => Effect.fail(mapSql("waitForChildren")(cause))),
        );

        // -- cancel (steer ≠ cancel; cascade covers descendants only) -----------

        const cancelAssignment: AdeAssignmentEngineShape["cancelAssignment"] = Effect.fn(
          "AdeAssignmentEngine.cancelAssignment",
        )(function* (input: CancelAssignmentInput) {
          const at = yield* nowIso;
          const summary = input.summary ?? "Cancelled by the fleet.";
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* requireOpenRow(input.assignmentId);
                const targets: Array<AssignmentRow> = [];
                const rootRow = yield* requireRow(input.assignmentId);
                targets.push(rootRow);
                if (input.cascade) {
                  // Descendants only: lineage never cascades upward or sideways
                  // (§13.4). The traversal walks through *every* child —
                  // including settled ones — because a completed child can still
                  // have running grandchildren; only non-terminal rows are then
                  // cancelled.
                  const seen = new Set<string>([rootRow.assignment_id]);
                  let frontier: ReadonlyArray<string> = [rootRow.assignment_id];
                  while (frontier.length > 0) {
                    const next: Array<AssignmentRow> = [];
                    for (const parentId of frontier) {
                      const children = yield* sql<AssignmentRow>`
                      SELECT * FROM ade_assignments
                      WHERE parent_assignment_id = ${parentId}
                    `;
                      for (const child of children) {
                        if (seen.has(child.assignment_id)) continue;
                        seen.add(child.assignment_id);
                        next.push(child);
                      }
                    }
                    targets.push(...next.filter((row) => !isTerminal(row.status)));
                    frontier = next.map((row) => row.assignment_id);
                  }
                }
                const cancelled: Array<AssignmentId> = [];
                for (const target of targets) {
                  const assignmentId = target.assignment_id as AssignmentId;
                  const result: AssignmentResult = {
                    status: "cancelled",
                    summary: summary as AssignmentResult["summary"],
                    artifacts: [],
                  };
                  yield* sql`
                  UPDATE ade_assignments
                  SET status = 'cancelled',
                      blocked_reason = NULL,
                      result_json = ${JSON.stringify(result)},
                      delivery_state = ${target.requester_kind === "bot" ? "pending" : "not-applicable"},
                      updated_at = ${at}
                  WHERE assignment_id = ${assignmentId}
                `;
                  yield* resolveStallItems(assignmentId, at);
                  cancelled.push(assignmentId);
                }
                return { cancelled };
              }),
            )
            .pipe(
              Effect.catchTag("SqlError", (cause) =>
                Effect.fail(mapSql("cancelAssignment")(cause)),
              ),
            );
        });

        // -- result capture -----------------------------------------------------

        const reportResult: AdeAssignmentEngineShape["reportResult"] = Effect.fn(
          "AdeAssignmentEngine.reportResult",
        )(function* (input: ReportAssignmentResultEngineInput) {
          const at = yield* nowIso;
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const row = yield* requireRow(input.assignmentId);
                if (isTerminal(row.status)) {
                  // A replayed report (gate dedupe is in-memory only) must not
                  // rewrite a settled result or queue a second delivery.
                  return { assignment: rowToAssignment(row), recorded: false };
                }
                const result: AssignmentResult = {
                  status: input.status,
                  summary: input.summary as AssignmentResult["summary"],
                  artifacts: input.artifacts ?? [],
                };
                yield* sql`
                UPDATE ade_assignments
                SET status = ${input.status},
                    blocked_reason = NULL,
                    result_json = ${JSON.stringify(result)},
                    delivery_state = ${row.requester_kind === "bot" ? "pending" : "not-applicable"},
                    updated_at = ${at}
                WHERE assignment_id = ${input.assignmentId}
              `;
                yield* resolveStallItems(input.assignmentId, at);
                const updated = yield* requireRow(input.assignmentId);
                return { assignment: rowToAssignment(updated), recorded: true };
              }),
            )
            .pipe(
              Effect.catchTag("SqlError", (cause) => Effect.fail(mapSql("reportResult")(cause))),
            );
        });

        // -- delivery -----------------------------------------------------------

        const toDeliveryItem = (row: AssignmentRow): AdeAssignmentDeliveryItem => {
          const result = parseResult(row.result_json);
          return {
            assignmentId: row.assignment_id as AssignmentId,
            recipientBotId: row.recipient_bot_id as BotId,
            instruction: row.instruction,
            result: result ?? {
              status: row.status as AssignmentTerminalStatus,
              summary: "" as AssignmentResult["summary"],
              artifacts: [],
            },
          };
        };

        /**
         * Send one claimed batch and record the outcome.
         *
         * A failed send **keeps the claim** — state `delivering`, same
         * `delivery_attempt_id`. The kernel may well have accepted the call
         * before the error surfaced (a lost ack), so re-keying the batch would
         * defeat the port's dedupe and deliver twice. Recovery re-drives the
         * claim under the same key once its lease ages out.
         *
         * Both writes are state-guarded on `(delivering, this key)`, so a
         * late-returning failed attempt can never move rows another attempt has
         * already delivered.
         */
        const sendClaimedBatch = Effect.fn("AdeAssignmentEngine.sendClaimedBatch")(function* (
          batch: AdeAssignmentDeliveryBatch,
        ) {
          const sent = yield* Effect.result(port.deliverResults(batch));
          const at = yield* nowIso;
          if (sent._tag === "Failure") {
            yield* Effect.logWarning(
              "ADE assignment delivery failed; claim retained for redelivery",
              {
                deliveryKey: batch.deliveryKey,
                targetBotId: batch.targetBotId,
                error: sent.failure,
              },
            );
            return { delivered: false as const, batch };
          }
          yield* sql
            .withTransaction(
              Effect.gen(function* () {
                yield* sql`
                UPDATE ade_assignments
                SET delivery_state = 'delivered', delivered = 1, delivered_at = ${at}, updated_at = ${at}
                WHERE delivery_attempt_id = ${batch.deliveryKey}
                  AND delivery_state = 'delivering'
              `;
                if (batch.parentAssignmentId !== null) {
                  // Release the wait this batch was claimed under — and only if
                  // the parent really has no outstanding child left, so a
                  // re-driven older batch can never release a later wait.
                  yield* sql`
                  UPDATE ade_assignments
                  SET status = 'running', blocked_reason = NULL, updated_at = ${at}
                  WHERE assignment_id = ${batch.parentAssignmentId}
                    AND status = 'blocked'
                    AND blocked_reason = 'children'
                    AND NOT EXISTS (
                      SELECT 1 FROM ade_assignments child
                      WHERE child.parent_assignment_id = ${batch.parentAssignmentId}
                        AND child.status NOT IN ('completed', 'failed', 'cancelled')
                    )
                `;
                }
              }),
            )
            .pipe(Effect.mapError(mapSql("sendClaimedBatch")));
          return { delivered: true as const, batch };
        });

        /** Does this parent still have a non-terminal child? (parental wait) */
        const parentStillWaiting = Effect.fn("AdeAssignmentEngine.parentStillWaiting")(function* (
          parentAssignmentId: string,
        ) {
          const parents = yield* sql<{ status: string; blocked_reason: string | null }>`
          SELECT status, blocked_reason FROM ade_assignments
          WHERE assignment_id = ${parentAssignmentId}
        `;
          const parent = parents[0];
          if (parent === undefined) return { waiting: false, outstanding: false };
          const waiting = parent.status === "blocked" && parent.blocked_reason === "children";
          if (!waiting) return { waiting: false, outstanding: false };
          const open = yield* sql<{ count: number }>`
          SELECT COUNT(*) AS count FROM ade_assignments
          WHERE parent_assignment_id = ${parentAssignmentId}
            AND status NOT IN ('completed', 'failed', 'cancelled')
        `;
          return { waiting: true, outstanding: (open[0]?.count ?? 0) > 0 };
        });

        const claimBatches = Effect.fn("AdeAssignmentEngine.claimBatches")(function* () {
          const rows = yield* sql<AssignmentRow>`
          SELECT * FROM ade_assignments
          WHERE delivery_state = 'pending'
            AND requester_kind = 'bot'
            AND status IN ('completed', 'failed', 'cancelled')
          ORDER BY updated_at ASC, rowid ASC
        `;
          /** requesterBotId + parent → one batch (batched child notifications). */
          const groups = new Map<string, { parentId: string | null; rows: Array<AssignmentRow> }>();
          const deferredBotIds = new Set<BotId>();
          for (const row of rows) {
            const requesterBotId = row.requester_bot_id;
            if (requesterBotId === null) continue;
            if (row.parent_assignment_id !== null) {
              const parent = yield* parentStillWaiting(row.parent_assignment_id);
              // Hold every child of a parental wait until the last sibling is
              // terminal, then release them as one notification (§13.5).
              if (parent.waiting && parent.outstanding) continue;
              if (parent.waiting) {
                const key = `${requesterBotId}\n${row.parent_assignment_id}`;
                const group = groups.get(key) ?? { parentId: row.parent_assignment_id, rows: [] };
                group.rows.push(row);
                groups.set(key, group);
                continue;
              }
            }
            const key = `${requesterBotId}\n`;
            const group = groups.get(key) ?? { parentId: null, rows: [] };
            group.rows.push(row);
            groups.set(key, group);
          }

          const claimed: Array<AdeAssignmentDeliveryBatch> = [];
          for (const [key, group] of groups) {
            const targetBotId = key.slice(0, key.indexOf("\n")) as BotId;
            const binding = yield* activePrimaryBinding(targetBotId);
            if (binding === null) {
              // Nothing to inject into yet; the rows stay `pending` and the next
              // drain (or the caller, after starting a session) picks them up.
              deferredBotIds.add(targetBotId);
              continue;
            }
            const deliveryKey = yield* uuid;
            const at = yield* nowIso;
            const claimedRows: Array<AssignmentRow> = [];
            for (const row of group.rows) {
              // Conditional claim: only a row still `pending` is taken, so two
              // concurrent drains can never claim the same completion.
              const taken = yield* sql<{ assignment_id: string }>`
              UPDATE ade_assignments
              SET delivery_state = 'delivering',
                  delivery_attempt_id = ${deliveryKey},
                  delivery_claimed_at = ${at},
                  delivery_attempts = 1,
                  delivery_parent_assignment_id = ${group.parentId},
                  updated_at = ${at}
              WHERE assignment_id = ${row.assignment_id} AND delivery_state = 'pending'
              RETURNING assignment_id
            `;
              if (taken.length === 1) claimedRows.push(row);
            }
            if (claimedRows.length === 0) continue;
            const items = claimedRows.map(toDeliveryItem);
            claimed.push({
              deliveryKey,
              redelivery: false,
              targetBotId,
              engine: binding.engine,
              sessionId: binding.sessionId,
              items,
              parentAssignmentId: group.parentId as AssignmentId | null,
              text: renderAssignmentDeliveryText({
                items,
                parentAssignmentId: group.parentId as AssignmentId | null,
              }),
            });
          }
          return { claimed, deferredBotIds: Array.from(deferredBotIds) };
        });

        const runBatches = Effect.fn("AdeAssignmentEngine.runBatches")(function* (
          batches: ReadonlyArray<AdeAssignmentDeliveryBatch>,
          deferredBotIds: ReadonlyArray<BotId>,
        ) {
          const delivered: Array<AdeAssignmentDeliveryBatch> = [];
          const failed: Array<AdeAssignmentDeliveryBatch> = [];
          for (const batch of batches) {
            const outcome = yield* sendClaimedBatch(batch);
            if (outcome.delivered) delivered.push(batch);
            else failed.push(batch);
          }
          return { delivered, failed, deferredBotIds };
        });

        const deliverPending: AdeAssignmentEngineShape["deliverPending"] = Effect.fn(
          "AdeAssignmentEngine.deliverPending",
        )(function* () {
          // The claim commits before any kernel call: a crash in the send window
          // leaves the batch `delivering`, never silently re-deliverable.
          const { claimed, deferredBotIds } = yield* sql
            .withTransaction(claimBatches())
            .pipe(
              Effect.catchTag("SqlError", (cause) => Effect.fail(mapSql("deliverPending")(cause))),
            );
          return yield* runBatches(claimed, deferredBotIds);
        });

        /**
         * Backoff for a claim that keeps failing: attempt *n* waits
         * `lease × 2^(n-1)`, capped at {@link ADE_DELIVERY_MAX_BACKOFF_FACTOR}
         * leases. Bounded, so a permanently unhappy batch cannot spin.
         */
        const leaseExpiredAt = (claimedAt: string, attempts: number, now: DateTime.DateTime) => {
          const factor = Math.min(2 ** Math.max(attempts - 1, 0), ADE_DELIVERY_MAX_BACKOFF_FACTOR);
          const dueAtMillis =
            DateTime.toEpochMillis(DateTime.makeUnsafe(claimedAt)) +
            Duration.toMillis(deliveryLease) * factor;
          return dueAtMillis <= DateTime.toEpochMillis(now);
        };

        const recoverInterruptedDeliveries: AdeAssignmentEngineShape["recoverInterruptedDeliveries"] =
          Effect.fn("AdeAssignmentEngine.recoverInterruptedDeliveries")(function* () {
            const now = yield* DateTime.now;
            const at = DateTime.formatIso(now);
            const rows = yield* sql<DeliverableRow>`
            SELECT * FROM ade_assignments
            WHERE delivery_state = 'delivering' AND delivery_attempt_id IS NOT NULL
            ORDER BY delivery_claimed_at ASC, rowid ASC
          `.pipe(Effect.mapError(mapSql("recoverInterruptedDeliveries")));
            const byAttempt = new Map<string, Array<DeliverableRow>>();
            for (const row of rows) {
              const attemptId = row.delivery_attempt_id;
              if (attemptId === null) continue;
              const group = byAttempt.get(attemptId) ?? [];
              group.push(row);
              byAttempt.set(attemptId, group);
            }
            const batches: Array<AdeAssignmentDeliveryBatch> = [];
            const deferredBotIds: Array<BotId> = [];
            for (const [deliveryKey, group] of byAttempt) {
              const first = group[0];
              if (first === undefined || first.requester_bot_id === null) continue;
              // Lease: a claim younger than its (backed-off) lease may still be
              // in flight on another fiber — never race it.
              const expired = group.every((row) =>
                leaseExpiredAt(row.delivery_claimed_at ?? at, row.delivery_attempts, now),
              );
              if (!expired) continue;
              const targetBotId = first.requester_bot_id as BotId;
              const binding = yield* activePrimaryBinding(targetBotId).pipe(
                Effect.mapError(mapSql("recoverInterruptedDeliveries")),
              );
              if (binding === null) {
                deferredBotIds.push(targetBotId);
                continue;
              }
              // Re-claim under the SAME key, state-guarded: whoever wins the
              // update owns the redelivery; a concurrent winner leaves us with
              // zero rows and we skip the batch.
              const reclaimed = yield* sql<{ assignment_id: string }>`
              UPDATE ade_assignments
              SET delivery_claimed_at = ${at},
                  delivery_attempts = delivery_attempts + 1,
                  updated_at = ${at}
              WHERE delivery_attempt_id = ${deliveryKey}
                AND delivery_state = 'delivering'
                AND delivery_claimed_at = ${first.delivery_claimed_at}
              RETURNING assignment_id
            `.pipe(Effect.mapError(mapSql("recoverInterruptedDeliveries")));
              if (reclaimed.length === 0) continue;
              // The parental wait is replayed from the claim snapshot, never
              // re-derived: a batch claimed before a wait existed must not
              // release a later wait over different children.
              const parentAssignmentId =
                first.delivery_parent_assignment_id === null
                  ? null
                  : (first.delivery_parent_assignment_id as AssignmentId);
              const items = group.map(toDeliveryItem);
              batches.push({
                // Same durable key as the interrupted attempt: the port dedupes
                // on it, which is what makes redelivery exactly-once at product
                // level even when the crash happened *after* the kernel call.
                deliveryKey,
                redelivery: true,
                targetBotId,
                engine: binding.engine,
                sessionId: binding.sessionId,
                items,
                parentAssignmentId,
                text: renderAssignmentDeliveryText({ items, parentAssignmentId }),
              });
            }
            return yield* runBatches(batches, deferredBotIds);
          });

        // -- recovery & stalls --------------------------------------------------

        const recoverRunningAssignments: AdeAssignmentEngineShape["recoverRunningAssignments"] =
          Effect.fn("AdeAssignmentEngine.recoverRunningAssignments")(function* () {
            const rows = yield* sql<AssignmentRow>`
            SELECT * FROM ade_assignments WHERE status = 'running'
            ORDER BY updated_at ASC, rowid ASC
          `.pipe(Effect.mapError(mapSql("recoverRunningAssignments")));
            const adopted: Array<AssignmentId> = [];
            const needsResume: Array<AssignmentId> = [];
            for (const row of rows) {
              const assignmentId = row.assignment_id as AssignmentId;
              const binding = yield* activePrimaryBinding(row.recipient_bot_id as BotId).pipe(
                Effect.mapError(mapSql("recoverRunningAssignments")),
              );
              const live =
                binding === null
                  ? false
                  : yield* port.isSessionLive({
                      engine: binding.engine,
                      sessionId: binding.sessionId,
                    });
              if (live) {
                adopted.push(assignmentId);
                continue;
              }
              // Never a silent restart (spec §4.2): park it for the captain.
              const at = yield* nowIso;
              yield* setStatus({
                assignmentId,
                status: "blocked",
                blockedReason: "needs-resume",
                at,
              }).pipe(
                Effect.catchTag("SqlError", (cause) =>
                  Effect.fail(mapSql("recoverRunningAssignments")(cause)),
                ),
                // The row was read in this pass; a vanished assignment is a
                // broken invariant, not an input-shaped failure.
                Effect.catchTag("AdeAssignmentNotFoundError", (error) => Effect.die(error)),
              );
              needsResume.push(assignmentId);
            }
            return { adopted, needsResume };
          });

        const surfaceStalls: AdeAssignmentEngineShape["surfaceStalls"] = Effect.fn(
          "AdeAssignmentEngine.surfaceStalls",
        )(function* (input: SurfaceStallsInput) {
          const now = yield* DateTime.now;
          const at = DateTime.formatIso(now);
          const cutoff = DateTime.formatIso(DateTime.subtractDuration(now, input.stallAfter));
          return yield* sql
            .withTransaction(
              Effect.gen(function* () {
                const rows = yield* sql<AssignmentRow>`
                SELECT * FROM ade_assignments
                WHERE status = 'running' AND updated_at <= ${cutoff}
                ORDER BY updated_at ASC, rowid ASC
              `;
                const surfaced: Array<AssignmentId> = [];
                for (const row of rows) {
                  const assignmentId = row.assignment_id as AssignmentId;
                  // Database-backed dedupe: one open stall item per assignment,
                  // so a restart mid-stall never duplicates the alert.
                  const open = yield* sql<{ needs_you_item_id: string }>`
                  SELECT needs_you_item_id FROM ade_needs_you_items
                  WHERE kind = 'stall' AND status = 'open'
                    AND subject_refs_json LIKE ${`%"assignmentId":"${assignmentId}"%`}
                `;
                  if (open.length > 0) continue;
                  const itemId = yield* uuid;
                  const subjectRefs = JSON.stringify([
                    { _tag: "assignment", assignmentId },
                    { _tag: "bot", botId: row.recipient_bot_id },
                  ]);
                  yield* sql`
                  INSERT INTO ade_needs_you_items (
                    needs_you_item_id, kind, subject_refs_json, status,
                    created_at, updated_at, resolved_at
                  ) VALUES (${itemId}, 'stall', ${subjectRefs}, 'open', ${at}, ${at}, NULL)
                `;
                  surfaced.push(assignmentId);
                }
                return surfaced;
              }),
            )
            .pipe(
              Effect.catchTag("SqlError", (cause) => Effect.fail(mapSql("surfaceStalls")(cause))),
            );
        });

        return AdeAssignmentEngine.of({
          createAssignment,
          getAssignment,
          listForBot,
          listChildren,
          reorderQueue,
          nextQueued,
          startAssignment,
          noteProgress,
          blockAssignment,
          markNeedsResume,
          releaseAssignment,
          waitForChildren,
          cancelAssignment,
          reportResult,
          deliverPending,
          recoverInterruptedDeliveries,
          recoverRunningAssignments,
          surfaceStalls,
        });
      }),
    );

  static readonly layer = AdeAssignmentEngine.layerWith();

  /**
   * The engine's own delivery sweep, parked until server activation (same
   * shape as the S17 health ticker). Boot re-drives claims a crash left
   * behind, then each tick drains newly deliverable results and re-drives
   * anything still stuck — so a batch deferred for want of a session, or a
   * lost-ack claim, never waits on an unrelated `report_assignment_result`.
   *
   * S9 adds this to the server layer graph together with the live kernel
   * port; on the unwired default port a sweep is inert (every send fails and
   * the claim is simply retained).
   */
  static readonly sweeperLive = (
    interval: Duration.Duration = ADE_DELIVERY_SWEEP_INTERVAL_DEFAULT,
  ): Layer.Layer<never, never, AdeAssignmentEngine> =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const engine = yield* AdeAssignmentEngine;
        const guard = <A>(label: string, effect: Effect.Effect<A, PersistenceSqlError>) =>
          effect.pipe(
            Effect.catch((error) => Effect.logWarning(label, { error })),
            Effect.catchDefect((defect) => Effect.logWarning(`${label} (defect)`, { defect })),
            Effect.asVoid,
          );
        yield* forkParked(
          Effect.gen(function* () {
            yield* guard(
              "ADE delivery recovery failed at boot",
              engine.recoverInterruptedDeliveries(),
            );
            yield* Effect.repeat(
              Effect.gen(function* () {
                yield* guard("ADE delivery drain failed", engine.deliverPending());
                yield* guard("ADE delivery recovery failed", engine.recoverInterruptedDeliveries());
              }),
              Schedule.spaced(interval),
            );
          }),
        );
      }),
    );
}
