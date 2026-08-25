/**
 * ADE V1 domain schemas — spec `docs/ade/ADE-V1-SPEC.md` §2 (frozen outline
 * from #136). Schema-only: no runtime logic. Persistence for these entities
 * lives in `apps/server/src/persistence/Migrations/055_AdeCoreTables.ts`.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";

const entityId = <Brand extends string>(brand: Brand) =>
  TrimmedNonEmptyString.pipe(Schema.brand(brand));

// ---------------------------------------------------------------------------
// Branded ids (spec §2.1)
// ---------------------------------------------------------------------------

export const BotId = entityId("BotId");
export type BotId = typeof BotId.Type;

/**
 * ADE project id. Named `AdeProjectId` because the contracts barrel already
 * exports a `ProjectId` brand for the existing coding-tool projection
 * projects, which are a different entity (ADR §17.2: ADE is additive).
 */
export const AdeProjectId = entityId("AdeProjectId");
export type AdeProjectId = typeof AdeProjectId.Type;

export const AssignmentId = entityId("AssignmentId");
export type AssignmentId = typeof AssignmentId.Type;

export const PersonaVersionId = entityId("PersonaVersionId");
export type PersonaVersionId = typeof PersonaVersionId.Type;

export const PublicationStackId = entityId("PublicationStackId");
export type PublicationStackId = typeof PublicationStackId.Type;

export const PublicationLayerId = entityId("PublicationLayerId");
export type PublicationLayerId = typeof PublicationLayerId.Type;

export const IntegrationCandidateId = entityId("IntegrationCandidateId");
export type IntegrationCandidateId = typeof IntegrationCandidateId.Type;

export const NeedsYouItemId = entityId("NeedsYouItemId");
export type NeedsYouItemId = typeof NeedsYouItemId.Type;

export const BotExecutionBindingId = entityId("BotExecutionBindingId");
export type BotExecutionBindingId = typeof BotExecutionBindingId.Type;

/** Kernel-native session identifier (shuvcode session / Codex thread). */
export const KernelSessionId = entityId("KernelSessionId");
export type KernelSessionId = typeof KernelSessionId.Type;

/**
 * Durable Jujutsu change identity (ADR §6.2 — change ids, not branch names).
 *
 * Constrained to JJ's reverse-hex alphabet (`k`–`z`) because change ids arrive
 * from bot tool calls and end up as arguments to `jj`. Without this, an id like
 * `all()`, `root()`, or `--help` is a revset/flag injection into every
 * integration operation. Call sites still quote ids as revset literals — this
 * is the first of the two defenses, not the only one.
 */
export const JJ_CHANGE_ID_PATTERN = /^[k-z]{4,64}$/;

export const JjChangeId = entityId("JjChangeId").check(Schema.isPattern(JJ_CHANGE_ID_PATTERN));
export type JjChangeId = typeof JjChangeId.Type;

// ---------------------------------------------------------------------------
// Identity & bots (spec §2.1)
// ---------------------------------------------------------------------------

export const KernelEngine = Schema.Literals(["shuvcode", "codex"]);
export type KernelEngine = typeof KernelEngine.Type;

export const BotStructuralRole = Schema.Literals([
  "firstmate",
  "second-mate",
  "crew",
  "workspace-specialist",
]);
export type BotStructuralRole = typeof BotStructuralRole.Type;

export const BotName = TrimmedNonEmptyString.check(Schema.isMaxLength(160));
export type BotName = typeof BotName.Type;

/** Free-form role tag ("Coder", "Reviewer", "Researcher"). */
export const BotRoleTag = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
export type BotRoleTag = typeof BotRoleTag.Type;

/** Display metadata beyond the name; every facet optional. */
export const BotDisplayMeta = Schema.Struct({
  emoji: Schema.optional(TrimmedNonEmptyString),
  color: Schema.optional(TrimmedNonEmptyString),
  description: Schema.optional(TrimmedNonEmptyString),
});
export type BotDisplayMeta = typeof BotDisplayMeta.Type;

/**
 * Durable, engine-neutral bot identity (ADR §3.1). The Firstmate bot is
 * permanent — rename/persona edits allowed, archive/delete forbidden — which
 * is a service-level rule, not a schema constraint. The Screenbox
 * provisioning ref is the botId-keyed `ScreenboxProvisioning` record
 * (desktop id = botId, spec §4.6), so no separate foreign key is carried.
 */
export const Bot = Schema.Struct({
  id: BotId,
  name: BotName,
  displayMeta: Schema.NullOr(BotDisplayMeta),
  structuralRole: BotStructuralRole,
  roleTag: BotRoleTag,
  projectId: Schema.NullOr(AdeProjectId),
  activePersonaVersionId: Schema.NullOr(PersonaVersionId),
  computerUse: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  createdAt: IsoDateTime,
  archivedAt: Schema.NullOr(IsoDateTime),
});
export type Bot = typeof Bot.Type;

export const PERSONA_CONTENT_MAX_LENGTH = 120_000;

export const PersonaContent = TrimmedNonEmptyString.check(
  Schema.isMaxLength(PERSONA_CONTENT_MAX_LENGTH),
);
export type PersonaContent = typeof PersonaContent.Type;

/** Versioned captain-authored persona (ADR §12.1). Edits apply next session. */
export const PersonaVersion = Schema.Struct({
  id: PersonaVersionId,
  botId: BotId,
  content: PersonaContent,
  createdAt: IsoDateTime,
  activatedAt: Schema.NullOr(IsoDateTime),
});
export type PersonaVersion = typeof PersonaVersion.Type;

/**
 * Bounds note: JS-side `isMaxLength` counts UTF-16 code units, while the
 * SQLite `CHECK (length(...))` mirrors in migration 055 count code points —
 * the DB is deliberately the looser of the two (astral characters count once
 * there, twice here). Services enforce the strict JS bound before SQL.
 */
export const MEMORY_DOCUMENT_MAX_LENGTH = 65_536;

export const MemoryDocumentContent = Schema.String.check(
  Schema.isMaxLength(MEMORY_DOCUMENT_MAX_LENGTH),
);
export type MemoryDocumentContent = typeof MemoryDocumentContent.Type;

/** `system` marks seed/maintenance writes (e.g. the bootstrap's empty doc). */
export const MemoryDocumentAuthor = Schema.Literals(["bot", "captain", "system"]);
export type MemoryDocumentAuthor = typeof MemoryDocumentAuthor.Type;

/** One bounded memory document per bot, keyed by botId (ADR §12.2). */
export const MemoryDocument = Schema.Struct({
  botId: BotId,
  content: MemoryDocumentContent,
  updatedAt: IsoDateTime,
  updatedBy: MemoryDocumentAuthor,
});
export type MemoryDocument = typeof MemoryDocument.Type;

/**
 * ADR §12.3 / §12.4 — bounded outgoing-session summary carried into a
 * replacement session at rollover (and out of voice calls). Shares the
 * 16 KB (UTF-16 code units; see the bounds note on
 * `MEMORY_DOCUMENT_MAX_LENGTH`) ceiling ADR §18.1 fixes for result summaries.
 */
export const SESSION_ROLLOVER_SUMMARY_MAX_LENGTH = 16_384;

export const SessionRolloverSummary = Schema.String.check(
  Schema.isMaxLength(SESSION_ROLLOVER_SUMMARY_MAX_LENGTH),
);
export type SessionRolloverSummary = typeof SessionRolloverSummary.Type;

export const BotExecutionBindingPurpose = Schema.Literals([
  "primary-text",
  "parallel-work",
  "voice",
  "specialized-work",
]);
export type BotExecutionBindingPurpose = typeof BotExecutionBindingPurpose.Type;

export const BotExecutionBindingStatus = Schema.Literals(["active", "historical", "lost"]);
export type BotExecutionBindingStatus = typeof BotExecutionBindingStatus.Type;

/**
 * Replaceable kernel-session binding for a durable bot (ADR §3.1–§3.2).
 * `rolloverSummary` is the durable outgoing-session summary recorded when the
 * binding is retired (ADR §12.3 component 4) — readable so a restart can
 * recover it into the replacement session's projection.
 */
export const BotExecutionBinding = Schema.Struct({
  id: BotExecutionBindingId,
  botId: BotId,
  engine: KernelEngine,
  sessionId: KernelSessionId,
  purpose: BotExecutionBindingPurpose,
  status: BotExecutionBindingStatus,
  rolloverSummary: Schema.NullOr(SessionRolloverSummary),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type BotExecutionBinding = typeof BotExecutionBinding.Type;

// ---------------------------------------------------------------------------
// Assignments (spec §2.2, ADR §13)
// ---------------------------------------------------------------------------

export const AssignmentRequester = Schema.Union([
  Schema.TaggedStruct("bot", { botId: BotId }),
  Schema.TaggedStruct("captain", {}),
]);
export type AssignmentRequester = typeof AssignmentRequester.Type;

/** Declared risk drives the integration gate; escalate-only (ADR §7.1–§7.2). */
export const DeclaredRisk = Schema.Literals(["mechanical", "normal", "protected"]);
export type DeclaredRisk = typeof DeclaredRisk.Type;

export const AssignmentStatus = Schema.Literals([
  "queued",
  "running",
  "blocked",
  "completed",
  "failed",
  "cancelled",
]);
export type AssignmentStatus = typeof AssignmentStatus.Type;

export const AssignmentBlockedReason = Schema.Literals([
  "approval",
  "children",
  "needs-resume",
  "kernel-down",
]);
export type AssignmentBlockedReason = typeof AssignmentBlockedReason.Type;

export const ASSIGNMENT_INSTRUCTION_MAX_LENGTH = 120_000;

export const AssignmentInstruction = TrimmedNonEmptyString.check(
  Schema.isMaxLength(ASSIGNMENT_INSTRUCTION_MAX_LENGTH),
);
export type AssignmentInstruction = typeof AssignmentInstruction.Type;

/** ADR §18.1: 16 KB result summary, enforced as UTF-16 code units. */
export const ASSIGNMENT_RESULT_SUMMARY_MAX_LENGTH = 16_384;

export const AssignmentResultSummary = Schema.String.check(
  Schema.isMaxLength(ASSIGNMENT_RESULT_SUMMARY_MAX_LENGTH),
);
export type AssignmentResultSummary = typeof AssignmentResultSummary.Type;

/** Typed artifact references carried by structured completions (closed union). */
export const ArtifactRef = Schema.Union([
  Schema.TaggedStruct("jjChange", { changeId: JjChangeId, projectId: AdeProjectId }),
  Schema.TaggedStruct("publicationLayer", {
    stackId: PublicationStackId,
    layerId: PublicationLayerId,
  }),
  Schema.TaggedStruct("file", { path: TrimmedNonEmptyString }),
  Schema.TaggedStruct("url", { href: TrimmedNonEmptyString }),
]);
export type ArtifactRef = typeof ArtifactRef.Type;

export const AssignmentTerminalStatus = Schema.Literals(["completed", "failed", "cancelled"]);
export type AssignmentTerminalStatus = typeof AssignmentTerminalStatus.Type;

/** Structured completion (ADR §13.1). */
export const AssignmentResult = Schema.Struct({
  status: AssignmentTerminalStatus,
  summary: AssignmentResultSummary,
  artifacts: Schema.Array(ArtifactRef),
});
export type AssignmentResult = typeof AssignmentResult.Type;

/** Result-delivery record — exactly-once at product level (ADR §13.6). */
export const AssignmentDelivery = Schema.Struct({
  delivered: Schema.Boolean,
  deliveredAt: Schema.NullOr(IsoDateTime),
});
export type AssignmentDelivery = typeof AssignmentDelivery.Type;

export const Assignment = Schema.Struct({
  id: AssignmentId,
  idempotencyKey: TrimmedNonEmptyString,
  requester: AssignmentRequester,
  recipientBotId: BotId,
  projectId: Schema.NullOr(AdeProjectId),
  instruction: AssignmentInstruction,
  declaredRisk: DeclaredRisk,
  parentAssignmentId: Schema.NullOr(AssignmentId),
  status: AssignmentStatus,
  blockedReason: Schema.NullOr(AssignmentBlockedReason),
  queuePosition: NonNegativeInt,
  result: Schema.NullOr(AssignmentResult),
  delivery: AssignmentDelivery,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type Assignment = typeof Assignment.Type;

// ---------------------------------------------------------------------------
// Projects & integration (spec §2.3, ADR §6, §7, §14)
// ---------------------------------------------------------------------------

export const IntegrationPolicy = Schema.Literals(["automatic", "agent-review", "human-approval"]);
export type IntegrationPolicy = typeof IntegrationPolicy.Type;

/**
 * Product default for `AdeProject.integrationPolicyDefault` when project
 * creation does not specify one. A product default pending spec ratification —
 * neither the spec nor the ADR fixes an initial value.
 */
export const DEFAULT_INTEGRATION_POLICY: IntegrationPolicy = "agent-review";

/** Per-project limit overrides — every limit optional (spec §2.3). */
export const LimitsOverrides = Schema.Struct({
  maxConcurrentAssignments: Schema.optional(PositiveInt),
  maxParallelSessionsPerBot: Schema.optional(PositiveInt),
  maxDelegationDepth: Schema.optional(PositiveInt),
  maxQueuedAssignmentsPerBot: Schema.optional(PositiveInt),
  maxResultSummaryLength: Schema.optional(PositiveInt),
  maxConcurrentScreenboxDesktops: Schema.optional(PositiveInt),
  screenboxIdleStopMinutes: Schema.optional(PositiveInt),
});
export type LimitsOverrides = typeof LimitsOverrides.Type;

/** Optional primary-repository binding; JJ is required iff bound (ADR §14). */
export const RepoBinding = Schema.Struct({
  path: TrimmedNonEmptyString,
  remote: Schema.NullOr(TrimmedNonEmptyString),
});
export type RepoBinding = typeof RepoBinding.Type;

export const SharedSpecialistAllowList = Schema.Union([Schema.Literal("all"), Schema.Array(BotId)]);
export type SharedSpecialistAllowList = typeof SharedSpecialistAllowList.Type;

export const AdeProject = Schema.Struct({
  id: AdeProjectId,
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  secondMateBotId: BotId,
  repoBinding: Schema.NullOr(RepoBinding),
  integrationPolicyDefault: IntegrationPolicy,
  checkCommands: Schema.Array(TrimmedNonEmptyString),
  sharedSpecialistAllowList: SharedSpecialistAllowList,
  limitsOverrides: Schema.NullOr(LimitsOverrides),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type AdeProject = typeof AdeProject.Type;

export const IntegrationCandidateStatus = Schema.Literals([
  "queued",
  "running",
  "awaiting-review",
  "awaiting-approval",
  "integrated",
  "bounced",
]);
export type IntegrationCandidateStatus = typeof IntegrationCandidateStatus.Type;

/** Why a candidate left the pipeline without advancing canonical (ADR §7.2). */
export const IntegrationBounceReason = Schema.Literals([
  "rebase-conflict",
  "checks-failed",
  "review-rejected",
  "approval-denied",
]);
export type IntegrationBounceReason = typeof IntegrationBounceReason.Type;

/** Bounce feedback rides into the repair assignment, so it shares the §18.1 bound. */
export const INTEGRATION_BOUNCE_DETAIL_MAX_LENGTH = ASSIGNMENT_RESULT_SUMMARY_MAX_LENGTH;

export const IntegrationBounce = Schema.Struct({
  reason: IntegrationBounceReason,
  detail: Schema.String.check(Schema.isMaxLength(INTEGRATION_BOUNCE_DETAIL_MAX_LENGTH)),
  at: IsoDateTime,
});
export type IntegrationBounce = typeof IntegrationBounce.Type;

/**
 * A gate verdict, recorded on the candidate *before* it is acted on. This is
 * what makes the approval path crash-safe: the verdict is durable, the row goes
 * back to `running` under it, and a restart re-runs the pass and applies the
 * recorded verdict instead of stranding the candidate on a gate forever.
 */
export const IntegrationVerdict = Schema.Literals(["approved", "rejected"]);
export type IntegrationVerdict = typeof IntegrationVerdict.Type;

/**
 * Serialized per-project integration unit (ADR §7.2, §16.2). One running
 * candidate per project; restart re-runs the queue head — no per-step journal.
 *
 * `gate`, `reviewerBotId`, and `workspacePath` are derived-and-recorded, not
 * journal entries: every one of them is recomputed from scratch when the queue
 * head re-runs. They exist so the captain surfaces (S12/S13) can render *why* a
 * candidate is parked without re-deriving policy.
 */
export const IntegrationCandidate = Schema.Struct({
  id: IntegrationCandidateId,
  projectId: AdeProjectId,
  /** Per-project creation idempotency, mirroring `Assignment.idempotencyKey`. */
  idempotencyKey: TrimmedNonEmptyString,
  sourceAssignmentIds: Schema.Array(AssignmentId),
  changeIds: Schema.Array(JjChangeId),
  /** Repair assignments route back here (ADR §6.3, §7.2). */
  originatingBotId: BotId,
  /** Escalate-only input to the gate calculation (ADR §7.1–§7.2). */
  declaredRisk: DeclaredRisk,
  status: IntegrationCandidateStatus,
  /** Effective gate, computed once the candidate reaches its gate step. */
  gate: Schema.NullOr(IntegrationPolicy),
  /** Set only under `agent-review`; never the authoring bot (ADR §7.2). */
  reviewerBotId: Schema.NullOr(BotId),
  /** Retained on a bounce for forensics; cleared on cleanup (ADR §14.4). */
  workspacePath: Schema.NullOr(TrimmedNonEmptyString),
  /** Durable gate verdict, applied by the pass rather than by the caller. */
  verdict: Schema.NullOr(IntegrationVerdict),
  verdictAt: Schema.NullOr(IsoDateTime),
  verdictByBotId: Schema.NullOr(BotId),
  verdictDetail: Schema.NullOr(Schema.String),
  bounceCount: NonNegativeInt,
  bounce: Schema.NullOr(IntegrationBounce),
  repairAssignmentId: Schema.NullOr(AssignmentId),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type IntegrationCandidate = typeof IntegrationCandidate.Type;

// ---------------------------------------------------------------------------
// Publication (spec §2.4, ADR §8 + spike #134)
// ---------------------------------------------------------------------------

export const PublicationStackMode = Schema.Literals(["native-stack", "chained"]);
export type PublicationStackMode = typeof PublicationStackMode.Type;

export const PublicationStackStatus = Schema.Literals([
  "building",
  "review-frozen",
  "merging",
  "merged",
  "reconciled",
]);
export type PublicationStackStatus = typeof PublicationStackStatus.Type;

export const PublicationStack = Schema.Struct({
  id: PublicationStackId,
  projectId: AdeProjectId,
  mode: PublicationStackMode,
  status: PublicationStackStatus,
  stackUrl: Schema.NullOr(TrimmedNonEmptyString),
  /** Native GitHub Stack number/node_id — presentation only (ADR §8.3). */
  nativeStackNumber: Schema.NullOr(NonNegativeInt),
  nativeStackNodeId: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PublicationStack = typeof PublicationStack.Type;

export const PublicationLayerStatus = Schema.Literals(["pending", "submitted", "merged"]);
export type PublicationLayerStatus = typeof PublicationLayerStatus.Type;

/** Re-read GitHub PR state; merged is detected, never assumed. */
export const PublicationPrState = Schema.Literals(["open", "closed", "merged"]);
export type PublicationPrState = typeof PublicationPrState.Type;

/**
 * One review-oriented layer of a publication stack. `prNumber` is mutable
 * (adopt-by-head-branch fallback); `changeId`s are invalid once merged —
 * post-merge logic keys on the recorded SHAs. Base is computed each pass and
 * therefore not persisted.
 */
export const PublicationLayer = Schema.Struct({
  id: PublicationLayerId,
  stackId: PublicationStackId,
  order: NonNegativeInt,
  changeIds: Schema.Array(JjChangeId),
  bookmarkName: TrimmedNonEmptyString,
  prNumber: Schema.NullOr(PositiveInt),
  headSha: Schema.NullOr(TrimmedNonEmptyString),
  submittedSha: Schema.NullOr(TrimmedNonEmptyString),
  mergeSha: Schema.NullOr(TrimmedNonEmptyString),
  prState: Schema.NullOr(PublicationPrState),
  status: PublicationLayerStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type PublicationLayer = typeof PublicationLayer.Type;

// ---------------------------------------------------------------------------
// Screenbox, Needs You, limits (spec §2.5)
// ---------------------------------------------------------------------------

export const ScreenboxProvisioningStatus = Schema.Literals([
  "provisioning",
  "running",
  "stopped",
  "failed",
]);
export type ScreenboxProvisioningStatus = typeof ScreenboxProvisioningStatus.Type;

/** Durable provisioning record; botId is the idempotency key (ADR §3.5). */
export const ScreenboxProvisioning = Schema.Struct({
  botId: BotId,
  status: ScreenboxProvisioningStatus,
  containerRef: Schema.NullOr(TrimmedNonEmptyString),
  volumeRef: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  lastNeededAt: Schema.NullOr(IsoDateTime),
});
export type ScreenboxProvisioning = typeof ScreenboxProvisioning.Type;

export const NeedsYouKind = Schema.Literals([
  "approval",
  "kernel-down",
  "stall",
  "provision-failure",
  "form",
]);
export type NeedsYouKind = typeof NeedsYouKind.Type;

/** What a Needs You item is about; an item may reference several subjects. */
export const NeedsYouSubjectRef = Schema.Union([
  Schema.TaggedStruct("bot", { botId: BotId }),
  Schema.TaggedStruct("assignment", { assignmentId: AssignmentId }),
  Schema.TaggedStruct("project", { projectId: AdeProjectId }),
  Schema.TaggedStruct("integrationCandidate", { integrationCandidateId: IntegrationCandidateId }),
  Schema.TaggedStruct("kernel", { engine: KernelEngine }),
]);
export type NeedsYouSubjectRef = typeof NeedsYouSubjectRef.Type;

export const NeedsYouItemStatus = Schema.Literals(["open", "resolved", "dismissed"]);
export type NeedsYouItemStatus = typeof NeedsYouItemStatus.Type;

/** One durable item; multiple renderings (spec §7). */
export const NeedsYouItem = Schema.Struct({
  id: NeedsYouItemId,
  kind: NeedsYouKind,
  subjectRefs: Schema.Array(NeedsYouSubjectRef),
  status: NeedsYouItemStatus,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type NeedsYouItem = typeof NeedsYouItem.Type;

// ---------------------------------------------------------------------------
// Fleet health (spec §4.8, ADR §11.3)
// ---------------------------------------------------------------------------

/**
 * Monitored runtimes: the two execution kernels plus the Screenbox desktop
 * runtime. Kernel-down semantics (Needs You + `blocked: kernel-down`) apply
 * only to the `KernelEngine` subset; Screenbox health is pill-only.
 */
export const HealthTargetId = Schema.Literals(["shuvcode", "codex", "screenbox"]);
export type HealthTargetId = typeof HealthTargetId.Type;

/**
 * `unknown` is the pre-first-probe state after boot; `not-provisioned` is a
 * dormant target (Screenbox before S14 provisioning) — neither is an outage.
 */
export const HealthState = Schema.Literals(["unknown", "healthy", "down", "not-provisioned"]);
export type HealthState = typeof HealthState.Type;

/** One monitored target's pill state, as pushed to clients. */
export const TargetHealthSnapshot = Schema.Struct({
  target: HealthTargetId,
  state: HealthState,
  /** Bounded human-readable probe detail (error text, dormancy note). */
  detail: Schema.NullOr(Schema.String),
  /** When the current `state` was entered. */
  since: IsoDateTime,
  /** When the target was last probed. */
  checkedAt: IsoDateTime,
});
export type TargetHealthSnapshot = typeof TargetHealthSnapshot.Type;

/** The whole sidebar pill row; one entry per monitored target. */
export const FleetHealthSnapshot = Schema.Struct({
  targets: Schema.Array(TargetHealthSnapshot),
});
export type FleetHealthSnapshot = typeof FleetHealthSnapshot.Type;

/**
 * ADR §18.1 locked initial defaults. Decoding `{}` yields the seed values, so
 * first-boot seeding (S3) is `LimitsConfig` decoded from an empty object.
 * `screenboxIdleStopMinutes` is the §4.6 idle window; the ADR fixes its home
 * (LimitsConfig) but not its value.
 */
export const LimitsConfig = Schema.Struct({
  maxBots: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(24))),
  maxConcurrentAssignments: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(16))),
  maxParallelSessionsPerBot: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(3))),
  maxDelegationDepth: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(5))),
  maxQueuedAssignmentsPerBot: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(20))),
  maxResultSummaryLength: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(ASSIGNMENT_RESULT_SUMMARY_MAX_LENGTH)),
  ),
  maxConcurrentScreenboxDesktops: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(4))),
  screenboxIdleStopMinutes: PositiveInt.pipe(Schema.withDecodingDefault(Effect.succeed(30))),
  /**
   * How long a bounced candidate's workspace is kept for forensics before the
   * age-based sweep reclaims it (ADR §14.4 "a generous age-based sweep").
   */
  integrationWorkspaceRetentionDays: PositiveInt.pipe(
    Schema.withDecodingDefault(Effect.succeed(7)),
  ),
});
export type LimitsConfig = typeof LimitsConfig.Type;

// ---------------------------------------------------------------------------
// Captain surface views (spec §7 slices 1, 2, 8 — S9)
// ---------------------------------------------------------------------------

/**
 * The one-click crew templates the roster offers (spec §4.1). Mirrors
 * `ADE_BOT_TEMPLATES` on the server; coordinator templates stay out by
 * construction — the Firstmate comes from the boot check and a Second Mate
 * only from project creation.
 */
export const AdeBotTemplateId = Schema.Literals(["researcher", "coder", "reviewer"]);
export type AdeBotTemplateId = typeof AdeBotTemplateId.Type;

/** One shipped template as offered by the roster's "add from template" control. */
export const AdeBotTemplateSummary = Schema.Struct({
  templateId: AdeBotTemplateId,
  defaultName: BotName,
  roleTag: BotRoleTag,
});
export type AdeBotTemplateSummary = typeof AdeBotTemplateSummary.Type;

/** One roster row: the durable bot plus the counts the list renders. */
export const AdeRosterEntry = Schema.Struct({
  bot: Bot,
  projectName: Schema.NullOr(Schema.String),
  /** True while a `primary-text` binding is `active` — chat is already warm. */
  hasActivePrimarySession: Schema.Boolean,
  /** `queued | running | blocked` assignments addressed to this bot. */
  openAssignmentCount: NonNegativeInt,
});
export type AdeRosterEntry = typeof AdeRosterEntry.Type;

export const AdeProjectSummary = Schema.Struct({
  id: AdeProjectId,
  name: Schema.String,
});
export type AdeProjectSummary = typeof AdeProjectSummary.Type;

/**
 * Roster payload (UI slice 2). `entries` is Firstmate-first, then the other
 * coordinators, then crew — the server owns that order so every surface
 * agrees on the pin.
 */
export const AdeRoster = Schema.Struct({
  entries: Schema.Array(AdeRosterEntry),
  projects: Schema.Array(AdeProjectSummary),
  templates: Schema.Array(AdeBotTemplateSummary),
});
export type AdeRoster = typeof AdeRoster.Type;

/** Bot detail payload (UI slice 2): bindings, memory, persona versions. */
export const AdeBotDetail = Schema.Struct({
  bot: Bot,
  projectName: Schema.NullOr(Schema.String),
  memory: MemoryDocument,
  /** Newest first. The head may be pending (`activatedAt === null`). */
  personaVersions: Schema.Array(PersonaVersion),
  bindings: Schema.Array(BotExecutionBinding),
  /** Open work addressed to this bot, in queue order. */
  assignments: Schema.Array(Assignment),
});
export type AdeBotDetail = typeof AdeBotDetail.Type;

/**
 * Chat bootstrap result (UI slice 1). An ADE bot chat is an ordinary
 * shuv2code thread: `threadId` is what the existing conversation stack
 * renders, while `bindingId`/`sessionId` name the `BotExecutionBinding` the
 * tool gate and the assignment engine key on.
 */
export const AdeBotChatSession = Schema.Struct({
  botId: BotId,
  threadId: ThreadId,
  engine: KernelEngine,
  bindingId: BotExecutionBindingId,
  sessionId: KernelSessionId,
  /** False when an existing active primary binding was reused. */
  startedNow: Schema.Boolean,
  /**
   * Whether the fleet tool catalog is registered on this session. False means
   * the conversation works but delegation does not — the kernel build has no
   * session-scoped dynamic-tool support (spec §3.1). Surfaced so the captain
   * is told, rather than watching a bot fail to delegate for no visible
   * reason.
   */
  toolsAttached: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(true))),
});
export type AdeBotChatSession = typeof AdeBotChatSession.Type;

/** Sidebar "Needs You" badge (UI slice 8): count of open `NeedsYouItem`s. */
export const AdeNeedsYouCount = Schema.Struct({
  open: NonNegativeInt,
});
export type AdeNeedsYouCount = typeof AdeNeedsYouCount.Type;

/**
 * One wire error for the captain RPCs. The services behind them fail with
 * rich tagged errors (`AdeBotNotFoundError`, `AdeTemplateNotInstantiableError`,
 * `AdeMemoryConflictError`, …); the RPC layer narrows those to a closed reason
 * union so clients branch without importing server internals.
 */
export class AdeCaptainError extends Schema.TaggedErrorClass<AdeCaptainError>()("AdeCaptainError", {
  reason: Schema.Literals([
    "bot_not_found",
    "template_not_instantiable",
    "memory_conflict",
    "memory_too_large",
    "persona_invalid",
    "session_unavailable",
    "project_invalid",
    "project_not_found",
    "persistence_failed",
  ]),
  message: Schema.String,
}) {}

export const AdeBotIdInput = Schema.Struct({ botId: BotId });
export type AdeBotIdInput = typeof AdeBotIdInput.Type;

export const AdeCreateBotFromTemplateInput = Schema.Struct({
  templateId: AdeBotTemplateId,
  /** Crew home project; null makes a fleet-shared specialist. */
  projectId: Schema.NullOr(AdeProjectId),
  name: Schema.optional(BotName),
});
export type AdeCreateBotFromTemplateInput = typeof AdeCreateBotFromTemplateInput.Type;

/**
 * Create an ADE project (spec §2.3, §4.1). Distinct from a shuv2code
 * workspace project: this is the organizational unit that owns a crew and
 * auto-creates its Second Mate. `repoPath` optionally binds it to a
 * repository on disk — normally an existing workspace project's root.
 */
export const AdeCreateProjectInput = Schema.Struct({
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(160)),
  repoPath: Schema.NullOr(TrimmedNonEmptyString),
  repoRemote: Schema.optional(TrimmedNonEmptyString),
});
export type AdeCreateProjectInput = typeof AdeCreateProjectInput.Type;

/** What project creation produced: the project plus its auto-created Second Mate. */
export const AdeCreatedProject = Schema.Struct({
  project: AdeProjectSummary,
  secondMateBotId: BotId,
});
export type AdeCreatedProject = typeof AdeCreatedProject.Type;

export const AdeWriteMemoryInput = Schema.Struct({
  botId: BotId,
  content: MemoryDocumentContent,
  /** Optimistic-concurrency precondition; omit for last-writer-wins. */
  expectedUpdatedAt: Schema.optional(IsoDateTime),
});
export type AdeWriteMemoryInput = typeof AdeWriteMemoryInput.Type;

export const AdeEditPersonaInput = Schema.Struct({
  botId: BotId,
  content: PersonaContent,
});
export type AdeEditPersonaInput = typeof AdeEditPersonaInput.Type;

export const AdeSetComputerUseInput = Schema.Struct({
  botId: BotId,
  computerUse: Schema.Boolean,
});
export type AdeSetComputerUseInput = typeof AdeSetComputerUseInput.Type;

// ---------------------------------------------------------------------------
// Project view + work graph (spec §7 slices 3, 4 — issue #166)
// ---------------------------------------------------------------------------

export const AdeProjectIdInput = Schema.Struct({ projectId: AdeProjectId });
export type AdeProjectIdInput = typeof AdeProjectIdInput.Type;

/**
 * One row of the project view's crew panel (slice 3, panel 1). Mirrors
 * `AdeRosterEntry` minus `projectName` — every member shares this project, so
 * repeating its name on each row says nothing.
 */
export const AdeProjectCrewMember = Schema.Struct({
  bot: Bot,
  /** The project's own Second Mate, pinned first and never archivable here. */
  isSecondMate: Schema.Boolean,
  hasActivePrimarySession: Schema.Boolean,
  /** `queued | running | blocked` assignments addressed to this bot. */
  openAssignmentCount: NonNegativeInt,
});
export type AdeProjectCrewMember = typeof AdeProjectCrewMember.Type;

/**
 * Project view header + crew panel (slice 3). The integration queue and the
 * publication stack are deliberately *not* inlined: they change on their own
 * cadence (a queue pass is seconds, a stack pass is minutes), so each panel
 * reads its own RPC rather than forcing the whole page to re-poll at the
 * fastest panel's rate.
 */
export const AdeProjectDetail = Schema.Struct({
  project: AdeProject,
  /** Second Mate first, then crew, then workspace specialists; ties on name. */
  crew: Schema.Array(AdeProjectCrewMember),
});
export type AdeProjectDetail = typeof AdeProjectDetail.Type;

export const AdeListProjectCandidatesInput = Schema.Struct({
  projectId: AdeProjectId,
  /** Omit for every status; the panel's filter chips narrow it. */
  statuses: Schema.optional(Schema.Array(IntegrationCandidateStatus)),
});
export type AdeListProjectCandidatesInput = typeof AdeListProjectCandidatesInput.Type;

/** Integration queue panel (slice 3, panel 2), oldest first — queue order. */
export const AdeProjectCandidates = Schema.Struct({
  candidates: Schema.Array(IntegrationCandidate),
});
export type AdeProjectCandidates = typeof AdeProjectCandidates.Type;

/**
 * Publication stack panel (slice 3, panel 3). Read straight off the §2.4
 * tables rather than through the publication service (S11): the panel only
 * ever renders recorded state, so a read-only projection keeps the UI landed
 * and correct before — and unchanged after — the service arrives.
 */
export const AdePublicationStackView = Schema.Struct({
  stack: PublicationStack,
  /** Bottom layer first (`PublicationLayer.order` ascending). */
  layers: Schema.Array(PublicationLayer),
});
export type AdePublicationStackView = typeof AdePublicationStackView.Type;

/**
 * Work graph scope (slice 4). `projectId: null` is the fleet-wide graph;
 * bot and status filtering is client-side so that narrowing the list cannot
 * silently sever the lineage the tree is drawing.
 */
export const AdeAssignmentGraphInput = Schema.Struct({
  projectId: Schema.NullOr(AdeProjectId),
});
export type AdeAssignmentGraphInput = typeof AdeAssignmentGraphInput.Type;

export const AdeAssignmentGraphNode = Schema.Struct({
  assignment: Assignment,
  /** Recipient's name, so the graph renders without a roster round-trip. */
  botName: Schema.String,
  projectName: Schema.NullOr(Schema.String),
  /**
   * Children recorded in the store, *including* any outside this scope — a
   * child may be addressed to a bot on another project (spec §2.2), so the
   * node has to admit to descendants the graph is not showing.
   */
  childCount: NonNegativeInt,
});
export type AdeAssignmentGraphNode = typeof AdeAssignmentGraphNode.Type;

/** One entry of the work graph's bot filter. */
export const AdeAssignmentGraphBot = Schema.Struct({
  id: BotId,
  name: Schema.String,
});
export type AdeAssignmentGraphBot = typeof AdeAssignmentGraphBot.Type;

/**
 * Assignment lineage payload (slice 4). Nodes arrive oldest-first; lineage is
 * `Assignment.parentAssignmentId`. A node whose parent is absent from `nodes`
 * is a root *of this scope* — the tree builder must not drop it.
 */
export const AdeAssignmentGraph = Schema.Struct({
  nodes: Schema.Array(AdeAssignmentGraphNode),
  /** Distinct recipients present in `nodes`, name-ordered. */
  bots: Schema.Array(AdeAssignmentGraphBot),
});
export type AdeAssignmentGraph = typeof AdeAssignmentGraph.Type;
