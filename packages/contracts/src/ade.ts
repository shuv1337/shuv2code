/**
 * ADE V1 domain schemas — spec `docs/ade/ADE-V1-SPEC.md` §2 (frozen outline
 * from #136). Schema-only: no runtime logic. Persistence for these entities
 * lives in `apps/server/src/persistence/Migrations/055_AdeCoreTables.ts`.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";

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

/** Durable Jujutsu change identity (ADR §6.2 — change ids, not branch names). */
export const JjChangeId = entityId("JjChangeId");
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

/**
 * Serialized per-project integration unit (ADR §7.2, §16.2). One running
 * candidate per project; restart re-runs the queue head — no per-step journal.
 */
export const IntegrationCandidate = Schema.Struct({
  id: IntegrationCandidateId,
  projectId: AdeProjectId,
  sourceAssignmentIds: Schema.Array(AssignmentId),
  changeIds: Schema.Array(JjChangeId),
  status: IntegrationCandidateStatus,
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
});
export type LimitsConfig = typeof LimitsConfig.Type;
