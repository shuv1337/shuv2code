/**
 * ADE V1 domain schemas — spec `docs/ade/ADE-V1-SPEC.md` §2 (frozen outline
 * from #136). Schema-only: no runtime logic. Persistence for these entities
 * lives in `apps/server/src/persistence/Migrations/055_AdeCoreTables.ts`.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

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

/**
 * Captain-defined contact group (`docs/ade/MESSENGER-PIVOT.md` §4). Pure
 * organization: a group names a bucket in the contact rail and owns nothing.
 */
export const AdeBotGroupId = entityId("AdeBotGroupId");
export type AdeBotGroupId = typeof AdeBotGroupId.Type;

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

/**
 * The palette a bot's avatar blob may use.
 *
 * A closed set of **theme token names**, not free-form CSS. Every surface that
 * paints a bot — the rail, the conversation header, attribution lines —
 * resolves the token through one shared resolver, so a bot keeps usable
 * contrast in light and dark. A free string could not promise that: `"amber"`
 * applied raw as a CSS color is not a color at all in most browsers, and
 * `"blue"` would resolve to the untuned named color rather than the theme's.
 */
export const BotAvatarColorToken = Schema.Literals([
  "blue",
  "teal",
  "emerald",
  "lime",
  "amber",
  "orange",
  "rose",
  "fuchsia",
  "violet",
  "indigo",
]);
export type BotAvatarColorToken = typeof BotAvatarColorToken.Type;

/** How much emoji a display blob may carry (UTF-16 code units). */
export const BOT_EMOJI_MAX_LENGTH = 32;

/** How much prose a display blob may carry. */
export const BOT_DESCRIPTION_MAX_LENGTH = 280;

/**
 * Control characters are refused rather than trimmed.
 *
 * The emoji is rendered inline in a rail row, a header and an avatar blob;
 * a smuggled newline, zero-width joiner run, or bidi override is a layout
 * exploit against every one of them at once. This is the first captain-authored
 * string that reaches an avatar, so it gets the bound at the schema rather than
 * at whichever surface happens to render it.
 */
const NO_CONTROL_CHARACTERS = /^[^\p{Cc}\p{Cf}]+$/u;

export const BotEmoji = TrimmedNonEmptyString.check(
  Schema.isMaxLength(BOT_EMOJI_MAX_LENGTH),
  Schema.isPattern(NO_CONTROL_CHARACTERS),
);
export type BotEmoji = typeof BotEmoji.Type;

/**
 * Display metadata beyond the name; every facet optional.
 *
 * Bounded because this is a first-writer surface: the captain types straight
 * into it and the result is stored, re-served, and painted on several screens.
 * An unbounded string here is an unbounded string in every one of them.
 */
export const BotDisplayMeta = Schema.Struct({
  emoji: Schema.optional(BotEmoji),
  color: Schema.optional(BotAvatarColorToken),
  description: Schema.optional(
    TrimmedNonEmptyString.check(Schema.isMaxLength(BOT_DESCRIPTION_MAX_LENGTH)),
  ),
});
export type BotDisplayMeta = typeof BotDisplayMeta.Type;

/** Rail header text for a captain-defined group. */
export const AdeBotGroupName = TrimmedNonEmptyString.check(Schema.isMaxLength(80));
export type AdeBotGroupName = typeof AdeBotGroupName.Type;

/**
 * One captain-defined contact group.
 *
 * `orderIndex` is the captain's chosen rail position; the server breaks ties
 * on `createdAt` so two groups added in the same tick cannot swap places
 * between reloads. There is no "Ungrouped" row — ungrouped is the absence of a
 * `groupId`, which is what keeps deleting a group a pure ungrouping.
 */
export const AdeBotGroup = Schema.Struct({
  id: AdeBotGroupId,
  name: AdeBotGroupName,
  orderIndex: NonNegativeInt,
  createdAt: IsoDateTime,
});
export type AdeBotGroup = typeof AdeBotGroup.Type;

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
  /**
   * Captain-defined rail group; null is Ungrouped. Defaulted on decode so a
   * payload minted before migration 057 still reads as a valid bot.
   */
  groupId: Schema.NullOr(AdeBotGroupId).pipe(Schema.withDecodingDefault(Effect.succeed(null))),
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

/**
 * Screen tab state for one bot (spec §4.6). `"none"` means no provisioning
 * record exists at all, which is the "not started" empty state.
 */
export const ScreenboxDesktopStatus = Schema.Literals([
  "provisioning",
  "running",
  "stopped",
  "failed",
  "none",
]);
export type ScreenboxDesktopStatus = typeof ScreenboxDesktopStatus.Type;

/**
 * Everything the Screen tab renders from. Deliberately carries **no** host,
 * port, or upstream token: the viewer reaches the desktop only through the
 * ADE-terminated proxy at `viewerPath`, so the upstream dashboard and the raw
 * VNC port stay unreachable from a browser (§4.6).
 */
export const AdeBotScreen = Schema.Struct({
  botId: BotId,
  status: ScreenboxDesktopStatus,
  /** Per-bot computer-use toggle; off means Start is refused. */
  computerUse: Schema.Boolean,
  /** Attached proxy viewers, which hold the desktop against the idle stop. */
  viewers: NonNegativeInt,
  lastNeededAt: Schema.NullOr(IsoDateTime),
  /**
   * Same-origin WS path to connect noVNC to, or null when there is nothing to
   * view. Null is the client's whole eligibility check — it must never
   * synthesize this path, because a desktop that is not running has no port.
   */
  viewerPath: Schema.NullOr(TrimmedNonEmptyString),
  /** False on a host with no Screenbox configured; Start is unavailable. */
  screenboxConfigured: Schema.Boolean,
});
export type AdeBotScreen = typeof AdeBotScreen.Type;

/**
 * Result of a confirm-gated bot delete (§4.6). `desktopPurged` is false when
 * the bot never had a desktop, so the UI can stay quiet about a purge that
 * never needed to happen.
 */
export const AdeDeletedBot = Schema.Struct({
  botId: BotId,
  desktopPurged: Schema.Boolean,
});
export type AdeDeletedBot = typeof AdeDeletedBot.Type;

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
  /**
   * Captain-defined rail groups in render order. Ungrouped bots are the ones
   * whose `groupId` matches no entry here — the rail synthesizes that trailing
   * bucket, the server never stores it.
   */
  groups: Schema.Array(AdeBotGroup).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
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
 * What the provider-authoritative tool probe learned about a session.
 *
 * The third state is the load-bearing one. "The kernel says this session has
 * no fleet tools" and "this process could not ask the kernel at all" are
 * different facts, and collapsing them into one boolean is what made a
 * restarted server tell every captain their fleet tools were gone: the probe
 * failed locally (no in-process session yet), reported `false`, and the banner
 * stuck. Only `missing` is evidence of a degraded bot; `unknown` means ask
 * again later.
 */
export const AdeToolProbe = Schema.Literals(["attached", "missing", "unknown"]);
export type AdeToolProbe = typeof AdeToolProbe.Type;

const AdeBotChatSessionFields = {
  botId: BotId,
  threadId: ThreadId,
  engine: KernelEngine,
  bindingId: BotExecutionBindingId,
  sessionId: KernelSessionId,
  /** False when an existing active primary binding was reused. */
  startedNow: Schema.Boolean,
};

/**
 * The decoded shape. `toolsProbe` says whether the fleet tool catalog is
 * registered on this session (spec §3.1): `missing` means the conversation
 * works but delegation does not, so the captain is told rather than left
 * watching a bot fail to delegate for no visible reason.
 */
const AdeBotChatSessionWire = Schema.Struct({
  ...AdeBotChatSessionFields,
  toolsProbe: AdeToolProbe,
  /**
   * @deprecated Use `toolsProbe`. Kept so an older peer keeps decoding; it is
   * `false` only for `missing`, never for `unknown`, because a client that
   * cannot distinguish them must not be pushed into the false negative that
   * issue #199 was.
   */
  toolsAttached: Schema.Boolean,
});

/**
 * Both tool fields are optional on the wire so payloads minted before the
 * tri-state — and before the boolean — still decode.
 */
const AdeBotChatSessionSource = Schema.Struct({
  ...AdeBotChatSessionFields,
  toolsProbe: Schema.optional(AdeToolProbe),
  toolsAttached: Schema.optional(Schema.Boolean),
});

/**
 * Chat bootstrap result (UI slice 1). An ADE bot chat is an ordinary
 * shuv2code thread: `threadId` is what the existing conversation stack
 * renders, while `bindingId`/`sessionId` name the `BotExecutionBinding` the
 * tool gate and the assignment engine key on.
 *
 * The missing `toolsProbe` is derived from the legacy boolean rather than
 * defaulted to `attached`: an older server that only knows `toolsAttached`
 * still reports a *genuine* missing catalog that way, and swallowing it would
 * trade issue #199's false positive for a false negative.
 */
export const AdeBotChatSession = AdeBotChatSessionSource.pipe(
  Schema.decodeTo(
    AdeBotChatSessionWire,
    SchemaTransformation.transformOrFail<
      typeof AdeBotChatSessionWire.Encoded,
      typeof AdeBotChatSessionSource.Type
    >({
      decode: (raw) =>
        Effect.succeed({
          ...raw,
          toolsProbe: raw.toolsProbe ?? (raw.toolsAttached === false ? "missing" : "attached"),
          toolsAttached: raw.toolsAttached ?? raw.toolsProbe !== "missing",
        } satisfies typeof AdeBotChatSessionWire.Encoded),
      // Both tool fields are always written back, so an older peer that only
      // reads the boolean still sees the same verdict. The cast only restores
      // the brands the encoded side erases; the values are unchanged.
      encode: (value) => Effect.succeed(value as typeof AdeBotChatSessionSource.Type),
    }),
  ),
);
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
    // Needs You inbox (spec §7 slice 5, S13).
    "needs_you_not_found",
    /**
     * Benign conflict: the item was already resolved — normally by the other
     * rendering of the same durable item, or by the underlying service
     * recovering. The captain is told what happened, not that they broke
     * something.
     */
    "needs_you_already_resolved",
    /** The item carries no captain decision (kernel-down, stall, …). */
    "needs_you_not_actionable",
    /** The decision reached the integration service and it refused it. */
    "needs_you_decision_rejected",
    // Screenbox viewer + delete (spec §4.6, S15).
    /** The Firstmate cannot be archived or deleted (spec §2.2). */
    "firstmate_permanent",
    /** The named contact group does not exist (messenger pivot §4). */
    "bot_group_not_found",
    /** Another group already carries that name; rail headers must be distinct. */
    "bot_group_name_conflict",
    /** Screenbox refused or is unreachable; the desktop state is unchanged. */
    "screenbox_unavailable",
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
// Loose bot identity (`docs/ade/MESSENGER-PIVOT.md` §4, #197)
// ---------------------------------------------------------------------------

/**
 * The captain's editable label for a bot: name, avatar decoration, role tag,
 * and rail group. One RPC covers all four because they are one act — "make
 * this contact look like what it is" — and splitting them would invite three
 * round trips for one sheet save.
 *
 * Partial patch semantics: a field left `undefined` is untouched, and an
 * explicitly `null` field is cleared. That distinction is why `displayMeta`
 * and `groupId` are `optional(NullOr(...))` rather than merely nullable — the
 * sheet must be able to say "drop the emoji" without also saying "drop the
 * group".
 *
 * What is deliberately **absent** is the whole point of the ticket:
 * `structuralRole` and the template lineage a bot was instantiated from are
 * server-owned facts, not labels. They are not in this payload, so there is no
 * request a client can spell that changes them — strictness that is invisible
 * rather than merely styled as a disabled input. Renaming, by contrast, is
 * allowed on **every** bot including the Firstmate: permanence protects the
 * Firstmate's existence (spec §2.2), not the string on its contact row.
 */
export const AdeUpdateBotIdentityInput = Schema.Struct({
  botId: BotId,
  /** Rename. Absent leaves the name alone; a bot always has one. */
  name: Schema.optional(BotName),
  /** Free-form role chip. Absent leaves it alone; a bot always has one. */
  roleTag: Schema.optional(BotRoleTag),
  /** Emoji/color/description blob. `null` clears the decoration entirely. */
  displayMeta: Schema.optional(Schema.NullOr(BotDisplayMeta)),
  /** Rail group membership. `null` moves the bot to Ungrouped. */
  groupId: Schema.optional(Schema.NullOr(AdeBotGroupId)),
});
export type AdeUpdateBotIdentityInput = typeof AdeUpdateBotIdentityInput.Type;

/**
 * Create or rename/reorder a group. Omitting `groupId` creates; supplying one
 * updates that group, and a missing id is an error rather than a silent
 * create — a stale rail must not resurrect a group the captain deleted.
 */
export const AdeUpsertBotGroupInput = Schema.Struct({
  groupId: Schema.optional(AdeBotGroupId),
  name: AdeBotGroupName,
  orderIndex: Schema.optional(NonNegativeInt),
});
export type AdeUpsertBotGroupInput = typeof AdeUpsertBotGroupInput.Type;

/** Delete a group. Its members fall to Ungrouped; no bot is ever deleted. */
export const AdeDeleteBotGroupInput = Schema.Struct({
  groupId: AdeBotGroupId,
});
export type AdeDeleteBotGroupInput = typeof AdeDeleteBotGroupInput.Type;

/**
 * What deleting a group did. `ungroupedBotIds` is returned rather than implied
 * so the surface can say "3 bots moved to Ungrouped" instead of leaving the
 * captain to notice — and so a test can assert those bots still exist.
 */
export const AdeDeletedBotGroup = Schema.Struct({
  groupId: AdeBotGroupId,
  ungroupedBotIds: Schema.Array(BotId),
});
export type AdeDeletedBotGroup = typeof AdeDeletedBotGroup.Type;

// ---------------------------------------------------------------------------
// Needs You inbox (spec §7 slice 5 — S13)
// ---------------------------------------------------------------------------

/**
 * The captain's verdict on an `approval` item. Deliberately not a general
 * "resolve": the only Needs You item a captain *decides* is one that parked
 * something waiting for that decision (spec §4.4). Every other kind is
 * resolved by the service that raised it, when the condition clears.
 */
export const NeedsYouDecision = Schema.Literals(["approve", "deny", "acknowledge"]);
export type NeedsYouDecision = typeof NeedsYouDecision.Type;

/**
 * What the captain can do with an item, when they can do anything.
 *
 * - `approve-deny`: a decision something is waiting on — the verdict travels to
 *   the service that parked it (spec §4.4).
 * - `acknowledge`: nothing is waiting on an answer, but nothing will clear the
 *   item either. An unroutable repair is the case: the change bounced, its
 *   author is gone, and no automatic path exists — so the captain retires it by
 *   hand rather than watching the badge count something permanently.
 *
 * Null means the item resolves on its own (spec §4.6, §4.8) or already has.
 */
export const NeedsYouAction = Schema.Literals(["approve-deny", "acknowledge"]);
export type NeedsYouAction = typeof NeedsYouAction.Type;

/**
 * One rendering-ready Needs You row. The durable item is `item`; everything
 * beside it is projection the server owns so the inbox and the inline
 * rendering cannot drift into two different descriptions of one item
 * (spec §7 slice 5: "one durable item, two renderings").
 *
 * The subject ids are flattened out of `item.subjectRefs` so both renderings
 * can filter — "items about this bot", "items about this project" — without
 * re-implementing the union walk.
 */
export const AdeNeedsYouEntry = Schema.Struct({
  item: NeedsYouItem,
  /** One line naming what is waiting. */
  title: Schema.String,
  /** One sentence saying what happens next. */
  detail: Schema.String,
  /** True only while `action` is non-null — kept as the surfaces' quick test. */
  actionable: Schema.Boolean,
  /** Which control the renderings offer; null when there is nothing to press. */
  action: Schema.NullOr(NeedsYouAction),
  botId: Schema.NullOr(BotId),
  projectId: Schema.NullOr(AdeProjectId),
  assignmentId: Schema.NullOr(AssignmentId),
  integrationCandidateId: Schema.NullOr(IntegrationCandidateId),
  kernelEngine: Schema.NullOr(KernelEngine),
});
export type AdeNeedsYouEntry = typeof AdeNeedsYouEntry.Type;

/**
 * Inbox payload. `open` is the same number the sidebar badge polls, returned
 * alongside the list so opening the inbox and reading the badge cannot
 * disagree by a poll interval.
 */
export const AdeNeedsYouList = Schema.Struct({
  entries: Schema.Array(AdeNeedsYouEntry),
  open: NonNegativeInt,
});
export type AdeNeedsYouList = typeof AdeNeedsYouList.Type;

export const AdeListNeedsYouInput = Schema.Struct({
  /** Recently-resolved items, for the inbox's "done" view. */
  includeResolved: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type AdeListNeedsYouInput = typeof AdeListNeedsYouInput.Type;

export const AdeNeedsYouItemIdInput = Schema.Struct({ needsYouItemId: NeedsYouItemId });
export type AdeNeedsYouItemIdInput = typeof AdeNeedsYouItemIdInput.Type;

/**
 * Approve or deny one item. Requires the `ade:approve` scope (spec §5,
 * ADR §10.4) — this is the only captain-authority action on the ADE surface,
 * and it is structurally unreachable from the bot-facing tool plane (§3.2).
 */
export const AdeSubmitNeedsYouDecisionInput = Schema.Struct({
  needsYouItemId: NeedsYouItemId,
  decision: NeedsYouDecision,
  note: Schema.optional(Schema.String.check(Schema.isMaxLength(4_000))),
});
export type AdeSubmitNeedsYouDecisionInput = typeof AdeSubmitNeedsYouDecisionInput.Type;

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

/**
 * Integration queue panel (slice 3, panel 2), oldest first — queue order.
 *
 * There is no status filter on the wire: the panel's chips have to report how
 * many candidates each status holds, so the client needs the whole queue
 * regardless and narrows it itself.
 */
export const AdeProjectCandidates = Schema.Struct({
  candidates: Schema.Array(IntegrationCandidate),
  /**
   * Rows the projection could not decode and skipped. One corrupt blob must
   * degrade to a missing row and a warning, never a failed panel that retries
   * forever — the queue polls every few seconds.
   */
  unreadableRows: NonNegativeInt,
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

/** Default and hard ceiling for the work graph's most-recent-N window. */
export const ASSIGNMENT_GRAPH_DEFAULT_LIMIT = 500;
export const ASSIGNMENT_GRAPH_MAX_LIMIT = 1000;

/** Bound on the one-line instruction/result excerpts the graph carries. */
export const ASSIGNMENT_GRAPH_LINE_MAX_LENGTH = 200;

/**
 * Work graph scope (slice 4). `projectId: null` is the fleet-wide graph;
 * bot and status filtering is client-side so that narrowing the list cannot
 * silently sever the lineage the tree is drawing.
 *
 * `limit` bounds the window to the most recent N assignments. The graph is
 * polled on a timer and `ade_assignments` grows without bound, so an unbounded
 * read would turn this into a multi-megabyte payload within weeks.
 */
export const AdeAssignmentGraphInput = Schema.Struct({
  projectId: Schema.NullOr(AdeProjectId),
  /** Defaults to {@link ASSIGNMENT_GRAPH_DEFAULT_LIMIT}; capped server-side. */
  limit: Schema.optional(PositiveInt),
});
export type AdeAssignmentGraphInput = typeof AdeAssignmentGraphInput.Type;

/**
 * One node of the work graph. Deliberately **not** the whole `Assignment`:
 * instruction and result bodies run to 120KB and 16KB respectively (spec
 * §2.2), and several hundred of them on a polling timer is a payload nobody
 * asked for. The graph carries one bounded line of each; the full text lives
 * on the assignment itself.
 */
export const AdeAssignmentGraphNode = Schema.Struct({
  id: AssignmentId,
  parentAssignmentId: Schema.NullOr(AssignmentId),
  recipientBotId: BotId,
  /** Recipient's name, so the graph renders without a roster round-trip. */
  botName: Schema.String,
  projectId: Schema.NullOr(AdeProjectId),
  projectName: Schema.NullOr(Schema.String),
  status: AssignmentStatus,
  blockedReason: Schema.NullOr(AssignmentBlockedReason),
  declaredRisk: DeclaredRisk,
  /** First line of the instruction, bounded. */
  title: Schema.String,
  /** First line of the result summary once terminal; null while open. */
  resultLine: Schema.NullOr(Schema.String),
  resultStatus: Schema.NullOr(AssignmentTerminalStatus),
  /**
   * Children **within this response**. Scoped rather than counted across the
   * table so the read stays bounded; a child outside the window or the project
   * scope is simply not counted here.
   */
  childCount: NonNegativeInt,
  createdAt: IsoDateTime,
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
 * `parentAssignmentId`. A node whose parent is absent from `nodes` is a root
 * *of this window* — the tree builder must not drop it, and the most-recent-N
 * window makes those common rather than exceptional.
 */
export const AdeAssignmentGraph = Schema.Struct({
  nodes: Schema.Array(AdeAssignmentGraphNode),
  /** Distinct recipients present in `nodes`, name-ordered. */
  bots: Schema.Array(AdeAssignmentGraphBot),
  /** True when older assignments exist beyond the window. */
  truncated: Schema.Boolean,
  /** Rows the projection could not decode and skipped (see §2.3 above). */
  unreadableRows: NonNegativeInt,
});
export type AdeAssignmentGraph = typeof AdeAssignmentGraph.Type;
