/**
 * ADE captain-surface read/write API (spec `docs/ade/ADE-V1-SPEC.md` §7 slices
 * 1, 2, 8 — issue #163).
 *
 * This is the thin service the WS RPC layer calls. It owns no domain rules of
 * its own: every mutation delegates to the service that already owns the
 * invariant (`AdeBootstrap` for copy-on-create instantiation, `AdePersonaMemory`
 * for the single memory write path and next-session persona edits,
 * `AdeSessionRollover` for bindings, `AdeAssignmentEngine` for queues). What it
 * adds is projection — joining those into the payloads the roster, bot detail,
 * and sidebar badge render — and one narrowing: rich tagged service errors
 * become the closed `AdeCaptainError` reason union so clients never import
 * server internals.
 *
 * Chat bootstrap rides {@link AdeChatSessionPort}. The port is separate because
 * the kernel side of it (create a shuv2code thread on the shuvcode provider,
 * attach the tool gate catalog, open the primary binding) belongs to the
 * provider runtime, while everything else here is pure persistence.
 */
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  ASSIGNMENT_GRAPH_DEFAULT_LIMIT,
  ASSIGNMENT_GRAPH_LINE_MAX_LENGTH,
  ASSIGNMENT_GRAPH_MAX_LIMIT,
  type AdeAssignmentGraph,
  type AdeAssignmentGraphInput,
  type AdeAssignmentGraphNode,
  type AdeBotChatSession,
  type AdeBotDetail,
  type AdeBotScreen,
  type AdeBotTemplateSummary,
  type AdeCreateBotFromTemplateInput,
  type AdeCreateProjectInput,
  type AdeCreatedProject,
  type AdeDeletedBot,
  type AdeEditPersonaInput,
  type AdeListNeedsYouInput,
  type AdeNeedsYouCount,
  type AdeNeedsYouEntry,
  type AdeNeedsYouList,
  type AdeProject,
  type AdeProjectCandidates,
  type AdeProjectCrewMember,
  type AdeProjectDetail,
  type AdeProjectId,
  type AdePublicationStackView,
  type AdeRoster,
  type AdeRosterEntry,
  type AdeSetComputerUseInput,
  type AdeWriteMemoryInput,
  AdeCaptainError,
  type Assignment,
  type Bot,
  type BotDisplayMeta,
  type BotId,
  type BotName,
  type BotRoleTag,
  type BotStructuralRole,
  type IntegrationPolicy,
  type LimitsOverrides,
  type MemoryDocument,
  type NeedsYouItemId,
  type PersonaVersion,
  type PersonaVersionId,
  type PublicationLayer,
  type PublicationLayerId,
  type PublicationStack,
  type PublicationStackId,
  type SharedSpecialistAllowList,
  type AdeSubmitNeedsYouDecisionInput,
} from "@shuv2code/contracts";

import { type PersistenceSqlError } from "../persistence/Errors.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import { AdeApprovalPort } from "./AdeApprovalPort.ts";
import { AdeAssignmentEngine, type AssignmentRow, rowToAssignment } from "./AdeAssignmentEngine.ts";
import { type CandidateRow, rowToCandidate } from "./AdeIntegrationService.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import { AdeChatSessionPort } from "./AdeChatSessionPort.ts";
import { AdePersonaMemory } from "./AdePersonaMemory.ts";
import { AdeScreenboxRuntime, type AdeScreenboxProvisionError } from "./AdeScreenbox.ts";
import { screenViewerPathFor } from "./AdeScreenViewerRoute.ts";
import { AdeSessionRollover } from "./AdeSessionRollover.ts";
import {
  compareNeedsYouEntries,
  projectNeedsYouRow,
  type NeedsYouNaming,
  type NeedsYouRow,
} from "./adeNeedsYou.ts";
import { ADE_BOT_TEMPLATES } from "./personaTemplates.ts";

// ---------------------------------------------------------------------------
// Error narrowing
// ---------------------------------------------------------------------------

const messageOf = (error: unknown): string =>
  typeof error === "object" && error !== null && "message" in error
    ? String((error as { message: unknown }).message)
    : String(error);

/**
 * The closed mapping from service errors to wire reasons. Anything unlisted is
 * a persistence failure — the only residual error every path shares.
 */
const REASONS: Readonly<Record<string, AdeCaptainError["reason"]>> = {
  AdeBotNotFoundError: "bot_not_found",
  AdeTemplateNotInstantiableError: "template_not_instantiable",
  AdeMemoryConflictError: "memory_conflict",
  AdeMemoryLimitExceededError: "memory_too_large",
  AdePersonaContentInvalidError: "persona_invalid",
};

export const toAdeCaptainError = (error: unknown): AdeCaptainError => {
  const tag =
    typeof error === "object" && error !== null && "_tag" in error
      ? String((error as { _tag: unknown })._tag)
      : "";
  // Already narrowed upstream (the chat port fails this way) — pass through.
  if (tag === "AdeCaptainError") return error as AdeCaptainError;
  return new AdeCaptainError({
    reason: REASONS[tag] ?? "persistence_failed",
    message: messageOf(error),
  });
};

const captainize = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<A, AdeCaptainError> =>
  Effect.mapError(effect, toAdeCaptainError);

/**
 * Escapes SQL `LIKE` metacharacters so an interpolated value matches literally.
 *
 * Bot ids are generated, but they are not a closed alphabet this code controls,
 * and a `%` in one would silently widen a `LIKE` from "this bot" to "any bot" —
 * which on the Needs You sweep below would resolve other bots' open items.
 * Must be paired with an explicit `ESCAPE '\'` clause.
 */
export const escapeLikePattern = (value: string): string =>
  value.replace(/[\\%_]/g, (match) => `\\${match}`);

// ---------------------------------------------------------------------------
// Row projection
// ---------------------------------------------------------------------------

interface BotRow {
  readonly bot_id: string;
  readonly name: string;
  readonly display_meta_json: string | null;
  readonly structural_role: BotStructuralRole;
  readonly role_tag: string;
  readonly project_id: string | null;
  readonly active_persona_version_id: string | null;
  readonly computer_use: number;
  readonly created_at: string;
  readonly archived_at: string | null;
}

/** Display meta is captain-authored decoration; a corrupt blob must not 500. */
const parseDisplayMeta = (raw: string | null): BotDisplayMeta | null => {
  if (raw === null || raw.length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as BotDisplayMeta) : null;
  } catch {
    return null;
  }
};

export const rowToBot = (row: BotRow): Bot => ({
  id: row.bot_id as BotId,
  name: row.name as BotName,
  displayMeta: parseDisplayMeta(row.display_meta_json),
  structuralRole: row.structural_role,
  roleTag: row.role_tag as BotRoleTag,
  projectId: row.project_id as AdeProjectId | null,
  activePersonaVersionId: row.active_persona_version_id as PersonaVersionId | null,
  computerUse: row.computer_use !== 0,
  createdAt: row.created_at,
  archivedAt: row.archived_at,
});

/**
 * Roster order (spec §7): the Firstmate is pinned, then the other
 * coordinators, then crew, then fleet-shared specialists. Ties break on name
 * so the list is stable across reloads.
 */
const ROLE_RANK: Readonly<Record<BotStructuralRole, number>> = {
  firstmate: 0,
  "second-mate": 1,
  crew: 2,
  "workspace-specialist": 3,
};

export const compareRosterEntries = (left: AdeRosterEntry, right: AdeRosterEntry): number => {
  const byRole = ROLE_RANK[left.bot.structuralRole] - ROLE_RANK[right.bot.structuralRole];
  if (byRole !== 0) return byRole;
  const byName = left.bot.name.localeCompare(right.bot.name);
  return byName !== 0 ? byName : left.bot.id.localeCompare(right.bot.id);
};

/**
 * How far back the inbox's "include resolved" view reaches. Needs You is an
 * inbox, not an audit log — resolved items are shown so a captain can confirm
 * what they just did, and the durable rows stay in the table regardless.
 */
const NEEDS_YOU_HISTORY_LIMIT = 200;

/** Statuses that count as "open work" on a roster row and in bot detail. */
const OPEN_STATUSES = ["queued", "running", "blocked"] as const;

// ---------------------------------------------------------------------------
// Project view + work graph projection (spec §7 slices 3, 4 — issue #166)
// ---------------------------------------------------------------------------

interface ProjectRow {
  readonly project_id: string;
  readonly name: string;
  readonly second_mate_bot_id: string;
  readonly repo_path: string | null;
  readonly repo_remote: string | null;
  readonly integration_policy_default: IntegrationPolicy;
  readonly check_commands_json: string;
  readonly shared_specialist_allow_list_json: string;
  readonly limits_overrides_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

/**
 * Tolerant JSON read for the project's decoration columns. These are settings
 * blobs, not invariants: a corrupt `check_commands_json` must degrade the
 * project *view* to "no check commands", never 500 the page that would let the
 * captain see what is wrong.
 */
const parseJsonOr = <A>(raw: string | null, fallback: A): A => {
  if (raw === null || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as A;
  } catch {
    return fallback;
  }
};

export const rowToProject = (row: ProjectRow): AdeProject => ({
  id: row.project_id as AdeProjectId,
  name: row.name as AdeProject["name"],
  secondMateBotId: row.second_mate_bot_id as BotId,
  repoBinding:
    row.repo_path === null
      ? null
      : {
          path: row.repo_path as AdeProject["name"],
          remote: row.repo_remote as AdeProject["name"] | null,
        },
  integrationPolicyDefault: row.integration_policy_default,
  checkCommands: parseJsonOr<AdeProject["checkCommands"]>(row.check_commands_json, []),
  sharedSpecialistAllowList: parseJsonOr<SharedSpecialistAllowList>(
    row.shared_specialist_allow_list_json,
    "all",
  ),
  limitsOverrides: parseJsonOr<LimitsOverrides | null>(row.limits_overrides_json, null),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Crew panel order: the project's own Second Mate is pinned, then crew, then
 * borrowed workspace specialists. Ties break on name, then id, so the panel is
 * stable across reloads exactly like the roster.
 */
export const compareCrewMembers = (
  left: AdeProjectCrewMember,
  right: AdeProjectCrewMember,
): number => {
  const byRole = ROLE_RANK[left.bot.structuralRole] - ROLE_RANK[right.bot.structuralRole];
  if (byRole !== 0) return byRole;
  const byName = left.bot.name.localeCompare(right.bot.name);
  return byName !== 0 ? byName : left.bot.id.localeCompare(right.bot.id);
};

/**
 * Stack statuses the §2.4 partial unique index treats as "the live one". The
 * panel prefers a live stack; a project whose last stack merged still shows it
 * rather than going blank, because "merged" is the answer the captain wants.
 */
const LIVE_STACK_STATUSES: ReadonlySet<PublicationStack["status"]> = new Set([
  "building",
  "review-frozen",
  "merging",
]);

interface StackRow {
  readonly publication_stack_id: string;
  readonly project_id: string;
  readonly mode: PublicationStack["mode"];
  readonly status: PublicationStack["status"];
  readonly stack_url: string | null;
  readonly native_stack_number: number | null;
  readonly native_stack_node_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

interface LayerRow {
  readonly publication_layer_id: string;
  readonly publication_stack_id: string;
  readonly layer_order: number;
  readonly change_ids_json: string;
  readonly bookmark_name: string;
  readonly pr_number: number | null;
  readonly head_sha: string | null;
  readonly submitted_sha: string | null;
  readonly merge_sha: string | null;
  readonly pr_state: PublicationLayer["prState"];
  readonly status: PublicationLayer["status"];
  readonly created_at: string;
  readonly updated_at: string;
}

export const rowToStack = (row: StackRow): PublicationStack => ({
  id: row.publication_stack_id as PublicationStackId,
  projectId: row.project_id as AdeProjectId,
  mode: row.mode,
  status: row.status,
  stackUrl: row.stack_url as PublicationStack["stackUrl"],
  nativeStackNumber: row.native_stack_number,
  nativeStackNodeId: row.native_stack_node_id as PublicationStack["nativeStackNodeId"],
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const rowToLayer = (row: LayerRow): PublicationLayer => ({
  id: row.publication_layer_id as PublicationLayerId,
  stackId: row.publication_stack_id as PublicationStackId,
  order: row.layer_order,
  changeIds: parseJsonOr<PublicationLayer["changeIds"]>(row.change_ids_json, []),
  bookmarkName: row.bookmark_name as PublicationLayer["bookmarkName"],
  prNumber: row.pr_number as PublicationLayer["prNumber"],
  headSha: row.head_sha as PublicationLayer["headSha"],
  submittedSha: row.submitted_sha as PublicationLayer["submittedSha"],
  mergeSha: row.merge_sha as PublicationLayer["mergeSha"],
  prState: row.pr_state,
  status: row.status,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/**
 * Picks the stack the panel renders: the live one if the project has it,
 * otherwise the most recently created. There is at most one live stack per
 * project (055's partial unique index), so this never has to break a tie
 * between two building stacks.
 */
export const selectStackRow = (rows: ReadonlyArray<StackRow>): StackRow | null =>
  rows.find((row) => LIVE_STACK_STATUSES.has(row.status)) ?? rows[0] ?? null;

/**
 * Read-path decode that tolerates a corrupt row. The write-path mapper throws
 * on bad JSON — correct there, wrong here: the work graph is polled, so one
 * unparseable blob would otherwise blank it on every refresh forever.
 */
export const safeRowToAssignment = (row: AssignmentRow): Assignment | null => {
  try {
    return rowToAssignment(row);
  } catch {
    return null;
  }
};

/**
 * One bounded line for the graph. Instructions run to 120KB (spec §2.2) and
 * the graph carries hundreds of nodes on a timer, so it ships a title, not a
 * body.
 */
export const firstLine = (text: string): string => {
  const line = text.split("\n", 1)[0]?.trim() ?? "";
  return line.length <= ASSIGNMENT_GRAPH_LINE_MAX_LENGTH
    ? line
    : `${line.slice(0, ASSIGNMENT_GRAPH_LINE_MAX_LENGTH - 1).trimEnd()}…`;
};

const nullIfBlank = (value: string): string | null => (value.length === 0 ? null : value);

const TEMPLATE_SUMMARIES: ReadonlyArray<AdeBotTemplateSummary> = Object.entries(
  ADE_BOT_TEMPLATES,
).map(([templateId, template]) => ({
  templateId: templateId as AdeBotTemplateSummary["templateId"],
  defaultName: template.defaultName as BotName,
  roleTag: template.roleTag as BotRoleTag,
}));

// ---------------------------------------------------------------------------
// Service shape
// ---------------------------------------------------------------------------

export interface AdeCaptainApiShape {
  readonly getRoster: () => Effect.Effect<AdeRoster, AdeCaptainError>;
  readonly getBot: (botId: BotId) => Effect.Effect<AdeBotDetail, AdeCaptainError>;
  readonly createBotFromTemplate: (
    input: AdeCreateBotFromTemplateInput,
  ) => Effect.Effect<AdeBotDetail, AdeCaptainError>;
  readonly createProject: (
    input: AdeCreateProjectInput,
  ) => Effect.Effect<AdeCreatedProject, AdeCaptainError>;
  readonly writeBotMemory: (
    input: AdeWriteMemoryInput,
  ) => Effect.Effect<MemoryDocument, AdeCaptainError>;
  readonly editBotPersona: (
    input: AdeEditPersonaInput,
  ) => Effect.Effect<PersonaVersion, AdeCaptainError>;
  readonly setBotComputerUse: (
    input: AdeSetComputerUseInput,
  ) => Effect.Effect<Bot, AdeCaptainError>;
  /** Screen tab state (spec §4.6). A pure read: never provisions or starts. */
  readonly getBotScreen: (botId: BotId) => Effect.Effect<AdeBotScreen, AdeCaptainError>;
  /** Explicit captain Start. Refused unless the bot's computer use is on. */
  readonly startBotDesktop: (botId: BotId) => Effect.Effect<AdeBotScreen, AdeCaptainError>;
  /** Explicit captain Stop. The home volume survives. */
  readonly stopBotDesktop: (botId: BotId) => Effect.Effect<AdeBotScreen, AdeCaptainError>;
  /** Confirm-gated delete: purge the desktop, then delete the bot row. */
  readonly deleteBot: (botId: BotId) => Effect.Effect<AdeDeletedBot, AdeCaptainError>;
  readonly getNeedsYouCount: () => Effect.Effect<AdeNeedsYouCount, AdeCaptainError>;
  readonly listNeedsYou: (
    input: AdeListNeedsYouInput,
  ) => Effect.Effect<AdeNeedsYouList, AdeCaptainError>;
  readonly getNeedsYouItem: (
    needsYouItemId: NeedsYouItemId,
  ) => Effect.Effect<AdeNeedsYouEntry, AdeCaptainError>;
  /**
   * Approve or deny one item. Gated on `ade:approve` at the wire (spec §5) and
   * idempotent underneath: the item is claimed with a conditional update, so a
   * second decision — from the other rendering, or from a double click — is a
   * benign `needs_you_already_resolved`, never a second verdict.
   */
  readonly submitNeedsYouDecision: (
    input: AdeSubmitNeedsYouDecisionInput,
  ) => Effect.Effect<AdeNeedsYouEntry, AdeCaptainError>;
  readonly startBotChat: (botId: BotId) => Effect.Effect<AdeBotChatSession, AdeCaptainError>;
  readonly getProject: (
    projectId: AdeProjectId,
  ) => Effect.Effect<AdeProjectDetail, AdeCaptainError>;
  readonly listProjectCandidates: (input: {
    readonly projectId: AdeProjectId;
  }) => Effect.Effect<AdeProjectCandidates, AdeCaptainError>;
  readonly getProjectPublicationStack: (
    projectId: AdeProjectId,
  ) => Effect.Effect<AdePublicationStackView | null, AdeCaptainError>;
  readonly getAssignmentGraph: (
    input: AdeAssignmentGraphInput,
  ) => Effect.Effect<AdeAssignmentGraph, AdeCaptainError>;
}

export class AdeCaptainApi extends Context.Service<AdeCaptainApi, AdeCaptainApiShape>()(
  "shuv2code/ade/AdeCaptainApi",
) {
  static readonly layer: Layer.Layer<
    AdeCaptainApi,
    never,
    | SqlClient.SqlClient
    | AdeBootstrap
    | AdePersonaMemory
    | AdeSessionRollover
    | AdeAssignmentEngine
    | AdeChatSessionPort
    | AdeApprovalPort
    | AdeScreenboxRuntime
    | WorkspacePaths
  > = Layer.effect(
    AdeCaptainApi,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const bootstrap = yield* AdeBootstrap;
      const personaMemory = yield* AdePersonaMemory;
      const rollover = yield* AdeSessionRollover;
      const assignments = yield* AdeAssignmentEngine;
      const chat = yield* AdeChatSessionPort;
      const approvals = yield* AdeApprovalPort;
      const screenbox = yield* AdeScreenboxRuntime;
      const workspacePaths = yield* WorkspacePaths;

      const readBotRow = (botId: BotId) =>
        sql<BotRow>`SELECT * FROM ade_bots WHERE bot_id = ${botId}`;

      const projectNames = Effect.map(
        sql<{ project_id: string; name: string }>`
          SELECT project_id, name FROM ade_projects ORDER BY name
        `,
        (rows) => new Map(rows.map((row) => [row.project_id, row.name] as const)),
      );

      const getRoster: AdeCaptainApiShape["getRoster"] = Effect.fn("AdeCaptainApi.getRoster")(
        function* () {
          const rows = yield* sql<BotRow>`
            SELECT * FROM ade_bots WHERE archived_at IS NULL
          `;
          const names = yield* projectNames;
          // One active primary binding per bot at most (055's partial unique
          // index), so a set membership test is the whole "chat is warm" query.
          const activeRows = yield* sql<{ bot_id: string }>`
            SELECT bot_id FROM ade_bot_execution_bindings
            WHERE purpose = 'primary-text' AND status = 'active'
          `;
          const active = new Set(activeRows.map((row) => row.bot_id));
          const openRows = yield* sql<{ recipient_bot_id: string; open_count: number }>`
            SELECT recipient_bot_id, COUNT(*) AS open_count FROM ade_assignments
            WHERE status IN ('queued', 'running', 'blocked')
            GROUP BY recipient_bot_id
          `;
          const openCounts = new Map(
            openRows.map((row) => [row.recipient_bot_id, row.open_count] as const),
          );

          const entries = rows
            .map((row) => {
              const bot = rowToBot(row);
              return {
                bot,
                projectName: bot.projectId === null ? null : (names.get(bot.projectId) ?? null),
                hasActivePrimarySession: active.has(bot.id),
                openAssignmentCount: openCounts.get(bot.id) ?? 0,
              } satisfies AdeRosterEntry;
            })
            .sort(compareRosterEntries);

          return {
            entries,
            projects: [...names].map(([id, name]) => ({ id: id as AdeProjectId, name })),
            templates: TEMPLATE_SUMMARIES,
          } satisfies AdeRoster;
        },
        captainize,
      );

      const getBot: AdeCaptainApiShape["getBot"] = Effect.fn("AdeCaptainApi.getBot")(function* (
        botId: BotId,
      ) {
        const rows = yield* readBotRow(botId);
        const row = rows[0];
        if (row === undefined) {
          return yield* new AdeCaptainError({
            reason: "bot_not_found",
            message: `ADE bot '${botId}' does not exist.`,
          });
        }
        const bot = rowToBot(row);
        const names = yield* projectNames;
        const memory = yield* personaMemory.readMemory(botId);
        const personaRows = yield* sql<{
          persona_version_id: string;
          content: string;
          created_at: string;
          activated_at: string | null;
        }>`
            SELECT persona_version_id, content, created_at, activated_at
            FROM ade_persona_versions WHERE bot_id = ${botId}
            -- rowid breaks ties on insertion order: two versions written in
            -- the same clock tick must still read newest-first.
            ORDER BY created_at DESC, rowid DESC
          `;
        const bindings = yield* rollover.listBindings(botId);
        const open = yield* assignments.listForBot(botId, { statuses: OPEN_STATUSES });

        return {
          bot,
          projectName: bot.projectId === null ? null : (names.get(bot.projectId) ?? null),
          memory,
          personaVersions: personaRows.map((persona) => ({
            id: persona.persona_version_id as PersonaVersionId,
            botId,
            content: persona.content as PersonaVersion["content"],
            createdAt: persona.created_at,
            activatedAt: persona.activated_at,
          })),
          bindings,
          assignments: open,
        } satisfies AdeBotDetail;
      }, captainize);

      const createBotFromTemplate: AdeCaptainApiShape["createBotFromTemplate"] = Effect.fn(
        "AdeCaptainApi.createBotFromTemplate",
      )(function* (input: AdeCreateBotFromTemplateInput) {
        const created = yield* captainize(
          bootstrap.instantiateTemplate({
            templateId: input.templateId,
            projectId: input.projectId,
            ...(input.name === undefined ? {} : { name: input.name }),
          }),
        );
        return yield* getBot(created.botId);
      });

      const createProject: AdeCaptainApiShape["createProject"] = Effect.fn(
        "AdeCaptainApi.createProject",
      )(function* (input: AdeCreateProjectInput) {
        // Normalize at the storage boundary. Everything downstream compares
        // this against a workspace project's resolved root, so storing what
        // the captain typed (`~/repo`, a trailing slash, a relative path)
        // guarantees the comparison misses later.
        const normalizedRepoPath =
          input.repoPath === null
            ? null
            : yield* Effect.mapError(
                workspacePaths.normalizeWorkspaceRoot(input.repoPath),
                (cause) =>
                  new AdeCaptainError({
                    reason: "project_invalid",
                    message: `Repository path '${input.repoPath}' is not usable: ${cause.message}`,
                  }),
              );
        // `normalizeWorkspaceRoot` resolves against the process cwd, so a
        // relative input still comes back absolute; this is the belt-and-braces
        // check that a bad normalizer can never store a relative root.
        if (normalizedRepoPath !== null && !normalizedRepoPath.startsWith("/")) {
          return yield* new AdeCaptainError({
            reason: "project_invalid",
            message: `Repository path '${input.repoPath}' did not resolve to an absolute path.`,
          });
        }

        // Idempotent on the repo: a captain who presses the CTA twice (or two
        // tabs racing) must not end up with two projects and two Second Mates
        // pointed at one repository.
        if (normalizedRepoPath !== null) {
          const existing = yield* captainize(
            sql<{ project_id: string; name: string; second_mate_bot_id: string }>`
              SELECT project_id, name, second_mate_bot_id FROM ade_projects
              WHERE repo_path = ${normalizedRepoPath}
              ORDER BY created_at
              LIMIT 1
            `,
          );
          const row = existing[0];
          if (row !== undefined) {
            return {
              project: { id: row.project_id as AdeProjectId, name: row.name },
              secondMateBotId: row.second_mate_bot_id as BotId,
            } satisfies AdeCreatedProject;
          }
        }

        // The Second Mate is created with the project, atomically — that hook
        // lives in AdeBootstrap and is the whole reason this goes through it
        // rather than a bare INSERT.
        const created = yield* captainize(
          bootstrap.createProject({
            name: input.name,
            repoBinding:
              normalizedRepoPath === null
                ? null
                : {
                    path: normalizedRepoPath,
                    remote: input.repoRemote ?? null,
                  },
          }),
        );
        return {
          project: { id: created.projectId, name: input.name },
          secondMateBotId: created.secondMate.botId,
        } satisfies AdeCreatedProject;
      });

      const writeBotMemory: AdeCaptainApiShape["writeBotMemory"] = Effect.fn(
        "AdeCaptainApi.writeBotMemory",
      )(function* (input: AdeWriteMemoryInput) {
        // Author is fixed, never client-supplied: this RPC is the captain's
        // edit path, and `bot` writes only ever arrive through the tool gate.
        return yield* captainize(
          personaMemory.writeMemory({
            botId: input.botId,
            content: input.content,
            author: "captain",
            ...(input.expectedUpdatedAt === undefined
              ? {}
              : { expectedUpdatedAt: input.expectedUpdatedAt }),
          }),
        );
      });

      const editBotPersona: AdeCaptainApiShape["editBotPersona"] = Effect.fn(
        "AdeCaptainApi.editBotPersona",
      )(function* (input: AdeEditPersonaInput) {
        return yield* captainize(personaMemory.editPersona(input));
      });

      const setBotComputerUse: AdeCaptainApiShape["setBotComputerUse"] = Effect.fn(
        "AdeCaptainApi.setBotComputerUse",
      )(function* (input: AdeSetComputerUseInput) {
        const updated = yield* sql<BotRow>`
            UPDATE ade_bots SET computer_use = ${input.computerUse ? 1 : 0}
            WHERE bot_id = ${input.botId}
            RETURNING *
          `;
        const row = updated[0];
        if (row === undefined) {
          return yield* new AdeCaptainError({
            reason: "bot_not_found",
            message: `ADE bot '${input.botId}' does not exist.`,
          });
        }
        return rowToBot(row);
      }, captainize);

      /**
       * Projects one bot's desktop state for the Screen tab.
       *
       * `viewerPath` is populated only when a viewer would actually connect —
       * it is derived from `viewerTargetFor`, the same read the proxy route
       * performs — so the client never opens a socket the server would refuse,
       * and a desktop that upstream lost is reported as not running rather
       * than as a broken viewer.
       */
      const projectScreen = (botId: BotId): Effect.Effect<AdeBotScreen, AdeCaptainError> =>
        Effect.gen(function* () {
          const status = yield* screenbox.statusFor(botId);
          const computerUse = yield* screenbox.isComputerUseEnabled(botId);
          const target =
            status.status === "running"
              ? yield* screenbox.viewerTargetFor(botId).pipe(Effect.result)
              : null;
          return {
            botId,
            status: status.status,
            computerUse,
            viewers: status.viewers,
            lastNeededAt: status.lastNeededAt,
            viewerPath: target?._tag === "Success" ? screenViewerPathFor(botId) : null,
            screenboxConfigured: screenbox.isConfigured,
          } satisfies AdeBotScreen;
        });

      /** A desktop refusal is never a persistence failure; keep the reason. */
      const screenboxError = (error: AdeScreenboxProvisionError) =>
        Effect.fail(
          new AdeCaptainError({ reason: "screenbox_unavailable", message: error.reason }),
        );

      const requireBot = (botId: BotId) =>
        Effect.gen(function* () {
          const rows = yield* captainize(readBotRow(botId));
          if (rows[0] === undefined) {
            return yield* new AdeCaptainError({
              reason: "bot_not_found",
              message: `ADE bot '${botId}' does not exist.`,
            });
          }
          return rows[0];
        });

      const getBotScreen: AdeCaptainApiShape["getBotScreen"] = Effect.fn(
        "AdeCaptainApi.getBotScreen",
      )(function* (botId: BotId) {
        yield* requireBot(botId);
        return yield* projectScreen(botId);
      }, captainize);

      const startBotDesktop: AdeCaptainApiShape["startBotDesktop"] = Effect.fn(
        "AdeCaptainApi.startBotDesktop",
      )(function* (botId: BotId) {
        yield* requireBot(botId);
        // The per-bot computer-use toggle is the eligibility gate for a
        // desktop existing at all (spec §4.6). Starting one for a bot with the
        // toggle off would create a desktop nothing is allowed to drive.
        const computerUse = yield* screenbox.isComputerUseEnabled(botId);
        if (!computerUse) {
          return yield* new AdeCaptainError({
            reason: "screenbox_unavailable",
            message: "Turn on computer use for this bot before starting a desktop.",
          });
        }
        yield* screenbox
          .startDesktopFor(botId)
          .pipe(Effect.catchTag("AdeScreenboxProvisionError", screenboxError));
        return yield* projectScreen(botId);
      }, captainize);

      const stopBotDesktop: AdeCaptainApiShape["stopBotDesktop"] = Effect.fn(
        "AdeCaptainApi.stopBotDesktop",
      )(function* (botId: BotId) {
        yield* requireBot(botId);
        yield* screenbox
          .stopDesktopFor(botId)
          .pipe(Effect.catchTag("AdeScreenboxProvisionError", screenboxError));
        return yield* projectScreen(botId);
      }, captainize);

      /**
       * Confirm-gated bot delete (spec §4.6).
       *
       * Ordering is load-bearing. `ade_screenbox_provisionings.bot_id`
       * cascades from `ade_bots`, so deleting the bot row first would drop the
       * provisioning record and strand a running container and its home volume
       * with nothing left that knows they exist. The upstream purge therefore
       * runs first, and a failed purge aborts the delete rather than trading a
       * visible error for a silent leak.
       */
      const deleteBot: AdeCaptainApiShape["deleteBot"] = Effect.fn("AdeCaptainApi.deleteBot")(
        function* (botId: BotId) {
          const row = yield* requireBot(botId);
          // The Firstmate is structural: refusing here keeps the fleet's single
          // permanent role from being deleted out from under every project.
          if (row.structural_role === "firstmate") {
            return yield* new AdeCaptainError({
              reason: "firstmate_permanent",
              message: `Bot '${botId}' is the Firstmate and cannot be deleted.`,
            });
          }
          // The purge and the row delete run under one per-bot lock. Releasing
          // between them would let a tool forward re-provision into the gap,
          // and the cascade would then eat the fresh provisioning record and
          // strand a live container.
          return yield* screenbox
            .deleteDesktopAndFinalize(botId, ({ desktopPurged }) =>
              Effect.gen(function* () {
                // 055's cascades take the persona versions, memory documents,
                // execution bindings, assignments, and any surviving
                // provisioning record with the row.
                yield* sql`DELETE FROM ade_bots WHERE bot_id = ${botId}`;
                // Needs You items have no FK to bots (their subject refs are
                // free form), so a provision-failure raised for this bot would
                // otherwise outlive it as an inbox item pointing at nothing.
                yield* sql`
                  UPDATE ade_needs_you_items SET status = 'resolved'
                  WHERE status = 'open'
                    AND subject_refs_json LIKE ${`%"${escapeLikePattern(botId)}"%`} ESCAPE '\'
                `;
                return { botId, desktopPurged } satisfies AdeDeletedBot;
              }),
            )
            // Only the desktop refusal needs narrowing here; a SQL failure
            // falls through to `captainize` as a persistence failure.
            .pipe(Effect.catchTag("AdeScreenboxProvisionError", (error) => screenboxError(error)));
        },
        captainize,
      );

      const getNeedsYouCount: AdeCaptainApiShape["getNeedsYouCount"] = Effect.fn(
        "AdeCaptainApi.getNeedsYouCount",
      )(function* () {
        const rows = yield* sql<{ open_count: number }>`
            SELECT COUNT(*) AS open_count FROM ade_needs_you_items WHERE status = 'open'
          `;
        return { open: rows[0]?.open_count ?? 0 } satisfies AdeNeedsYouCount;
      }, captainize);

      // -- Needs You inbox (spec §7 slice 5) ---------------------------------

      /**
       * One read of every name the projection might use. Three small table
       * scans beat N+1 lookups per item, and the inbox is bounded by what a
       * single captain has left unanswered.
       */
      const needsYouNaming = Effect.gen(function* () {
        const bots = yield* sql<{ bot_id: string; name: string }>`
            SELECT bot_id, name FROM ade_bots
          `;
        const projects = yield* sql<{ project_id: string; name: string }>`
            SELECT project_id, name FROM ade_projects
          `;
        const assignments = yield* sql<{ assignment_id: string; instruction: string }>`
            SELECT assignment_id, instruction FROM ade_assignments
          `;
        return {
          botNames: new Map(bots.map((row) => [row.bot_id, row.name] as const)),
          projectNames: new Map(projects.map((row) => [row.project_id, row.name] as const)),
          assignmentInstructions: new Map(
            assignments.map((row) => [row.assignment_id, row.instruction] as const),
          ),
        } satisfies NeedsYouNaming;
      });

      const readNeedsYouRow = (needsYouItemId: NeedsYouItemId) =>
        sql<NeedsYouRow>`
            SELECT * FROM ade_needs_you_items WHERE needs_you_item_id = ${needsYouItemId}
          `;

      const requireNeedsYouEntry = Effect.fn("AdeCaptainApi.requireNeedsYouEntry")(function* (
        needsYouItemId: NeedsYouItemId,
      ) {
        const rows = yield* readNeedsYouRow(needsYouItemId);
        const row = rows[0];
        if (row === undefined) {
          return yield* new AdeCaptainError({
            reason: "needs_you_not_found",
            message: `Needs You item '${needsYouItemId}' does not exist.`,
          });
        }
        return projectNeedsYouRow(row, yield* needsYouNaming);
      });

      const listNeedsYou: AdeCaptainApiShape["listNeedsYou"] = Effect.fn(
        "AdeCaptainApi.listNeedsYou",
      )(function* (input: AdeListNeedsYouInput) {
        const rows = input.includeResolved
          ? yield* sql<NeedsYouRow>`
                SELECT * FROM ade_needs_you_items
                ORDER BY created_at DESC, rowid DESC
                LIMIT ${NEEDS_YOU_HISTORY_LIMIT}
              `
          : yield* sql<NeedsYouRow>`
                SELECT * FROM ade_needs_you_items WHERE status = 'open'
                ORDER BY created_at DESC, rowid DESC
              `;
        const naming = yield* needsYouNaming;
        const entries = rows
          .map((row) => projectNeedsYouRow(row, naming))
          .toSorted(compareNeedsYouEntries);
        // Counted, not derived from the page. The history view is capped, so a
        // fleet with more than `NEEDS_YOU_HISTORY_LIMIT` items would otherwise
        // report an `open` that undercounts the badge it is supposed to agree
        // with.
        const counted = yield* sql<{ open_count: number }>`
            SELECT COUNT(*) AS open_count FROM ade_needs_you_items WHERE status = 'open'
          `;
        return {
          entries,
          open: counted[0]?.open_count ?? 0,
        } satisfies AdeNeedsYouList;
      }, captainize);

      const getNeedsYouItem: AdeCaptainApiShape["getNeedsYouItem"] = Effect.fn(
        "AdeCaptainApi.getNeedsYouItem",
      )(function* (needsYouItemId: NeedsYouItemId) {
        return yield* requireNeedsYouEntry(needsYouItemId);
      }, captainize);

      const submitNeedsYouDecision: AdeCaptainApiShape["submitNeedsYouDecision"] = Effect.fn(
        "AdeCaptainApi.submitNeedsYouDecision",
      )(function* (input: AdeSubmitNeedsYouDecisionInput) {
        const entry = yield* requireNeedsYouEntry(input.needsYouItemId);
        // Order matters: an item that is merely *finished* must read as the
        // benign conflict, not as "this kind takes no decision". That is what
        // the other rendering sees when it presses a beat later.
        if (entry.item.status !== "open") {
          return yield* new AdeCaptainError({
            reason: "needs_you_already_resolved",
            message: "That item was already resolved.",
          });
        }
        if (entry.action === null) {
          return yield* new AdeCaptainError({
            reason: "needs_you_not_actionable",
            message: `A '${entry.item.kind}' item carries no captain decision; it resolves when the condition clears.`,
          });
        }
        // The control the captain pressed has to be the one the item offers.
        // Acknowledging an approval would retire a decision nothing made, and
        // approving an unroutable repair would name a verdict with no recipient.
        const expected = entry.action === "acknowledge" ? "acknowledge" : "approve/deny";
        const matches =
          entry.action === "acknowledge"
            ? input.decision === "acknowledge"
            : input.decision !== "acknowledge";
        if (!matches) {
          return yield* new AdeCaptainError({
            reason: "needs_you_not_actionable",
            message: `That item takes ${expected}, not '${input.decision}'.`,
          });
        }
        const candidateId = entry.integrationCandidateId;
        if (entry.action === "approve-deny" && candidateId === null) {
          return yield* new AdeCaptainError({
            reason: "needs_you_not_actionable",
            message: "That approval names no integration candidate to decide.",
          });
        }

        // Claim first. This conditional update is the exactly-once fence: the
        // second decision — whichever rendering it came from — finds zero rows
        // and never reaches the integration service.
        const at = DateTime.formatIso(yield* DateTime.now);
        const claimed = yield* sql<NeedsYouRow>`
            UPDATE ade_needs_you_items
            SET status = 'resolved', resolved_at = ${at}, updated_at = ${at}
            WHERE needs_you_item_id = ${input.needsYouItemId} AND status = 'open'
            RETURNING *
          `;
        if (claimed[0] === undefined) {
          return yield* new AdeCaptainError({
            reason: "needs_you_already_resolved",
            message: "That item was already resolved.",
          });
        }

        // Acknowledging is the whole act: nothing is waiting on a verdict, so
        // there is nothing to forward and nothing that can fail afterwards.
        if (entry.action === "acknowledge" || candidateId === null) {
          return yield* requireNeedsYouEntry(input.needsYouItemId);
        }

        const forwarded = yield* approvals
          .submitIntegrationApproval({
            candidateId,
            // Narrowed above: an `approve-deny` item never carries "acknowledge".
            decision: input.decision === "deny" ? "deny" : "approve",
            ...(input.note === undefined ? {} : { note: input.note }),
          })
          .pipe(Effect.result);
        if (forwarded._tag === "Failure") {
          // A failed submission is ambiguous, and getting it wrong is expensive
          // in one direction only. The candidate's own state disambiguates:
          // still parked means nothing landed, so the item comes back; anything
          // else means the verdict is durable somewhere and reopening would
          // strand the item — `awaiting-approval` is the only state that retires
          // it, and the candidate can never return to it.
          const status = yield* approvals.readCandidateStatus(candidateId);
          if (status !== "awaiting-approval") {
            return yield* new AdeCaptainError({
              reason: "needs_you_already_resolved",
              message: "That decision was already applied elsewhere.",
            });
          }
          // Guarded on `status = 'resolved'` so this can only ever undo *our*
          // claim, never reopen an item something else has since retired.
          yield* sql`
              UPDATE ade_needs_you_items
              SET status = 'open', resolved_at = NULL, updated_at = ${at}
              WHERE needs_you_item_id = ${input.needsYouItemId} AND status = 'resolved'
            `.pipe(Effect.ignore);
          return yield* forwarded.failure;
        }

        return yield* requireNeedsYouEntry(input.needsYouItemId);
      }, captainize);

      const startBotChat: AdeCaptainApiShape["startBotChat"] = Effect.fn(
        "AdeCaptainApi.startBotChat",
      )(function* (botId: BotId) {
        const rows = yield* captainize(readBotRow(botId));
        if (rows[0] === undefined) {
          return yield* new AdeCaptainError({
            reason: "bot_not_found",
            message: `ADE bot '${botId}' does not exist.`,
          });
        }
        return yield* chat.startPrimaryChat(botId);
      });

      // -- Project view + work graph (spec §7 slices 3, 4) -------------------

      const readProjectRow = Effect.fn("AdeCaptainApi.readProjectRow")(function* (
        projectId: AdeProjectId,
      ) {
        const rows = yield* sql<ProjectRow>`
          SELECT * FROM ade_projects WHERE project_id = ${projectId}
        `;
        const row = rows[0];
        if (row === undefined) {
          return yield* new AdeCaptainError({
            reason: "project_not_found",
            message: `ADE project '${projectId}' does not exist.`,
          });
        }
        return row;
      });

      const getProject: AdeCaptainApiShape["getProject"] = Effect.fn("AdeCaptainApi.getProject")(
        function* (projectId: AdeProjectId) {
          const row = yield* readProjectRow(projectId);
          const project = rowToProject(row);
          // Crew is "bots whose home is this project". A borrowed fleet-shared
          // specialist has no `project_id` and so is deliberately absent: it is
          // on loan (spec §2.3 `sharedSpecialistAllowList`), not on the crew.
          const botRows = yield* sql<BotRow>`
            SELECT * FROM ade_bots
            WHERE project_id = ${projectId} AND archived_at IS NULL
          `;
          const activeRows = yield* sql<{ bot_id: string }>`
            SELECT bot_id FROM ade_bot_execution_bindings
            WHERE purpose = 'primary-text' AND status = 'active'
          `;
          const active = new Set(activeRows.map((binding) => binding.bot_id));
          const openRows = yield* sql<{ recipient_bot_id: string; open_count: number }>`
            SELECT recipient_bot_id, COUNT(*) AS open_count FROM ade_assignments
            WHERE status IN ('queued', 'running', 'blocked')
            GROUP BY recipient_bot_id
          `;
          const openCounts = new Map(
            openRows.map((open) => [open.recipient_bot_id, open.open_count] as const),
          );

          const crew = botRows
            .map((botRow) => {
              const bot = rowToBot(botRow);
              return {
                bot,
                isSecondMate: bot.id === project.secondMateBotId,
                hasActivePrimarySession: active.has(bot.id),
                openAssignmentCount: openCounts.get(bot.id) ?? 0,
              } satisfies AdeProjectCrewMember;
            })
            .sort(compareCrewMembers);

          return { project, crew } satisfies AdeProjectDetail;
        },
        captainize,
      );

      const listProjectCandidates: AdeCaptainApiShape["listProjectCandidates"] = Effect.fn(
        "AdeCaptainApi.listProjectCandidates",
      )(function* (input: { readonly projectId: AdeProjectId }) {
        yield* readProjectRow(input.projectId);
        // Queue order, oldest first — the same order the integration service
        // itself walks (ADR §7.2), so the panel's top row is the head. No
        // status filter: the panel's chips need counts for every status, so it
        // takes the whole queue and narrows client-side.
        const rows = yield* sql<CandidateRow>`
          SELECT * FROM ade_integration_candidates
          WHERE project_id = ${input.projectId}
          ORDER BY created_at ASC, rowid ASC
        `;
        // `rowToCandidate` dies on an undecodable blob — correct for the write
        // path, fatal here: this read is polled every few seconds, so one
        // corrupt `bounce_json` would blank the panel forever. Skip the row,
        // count it, and let the panel say so.
        const decoded = yield* Effect.forEach(rows, (row) =>
          rowToCandidate(row).pipe(Effect.catchCause(() => Effect.succeed(null))),
        );
        const candidates = decoded.filter((candidate) => candidate !== null);
        return {
          candidates,
          unreadableRows: decoded.length - candidates.length,
        } satisfies AdeProjectCandidates;
      }, captainize);

      const getProjectPublicationStack: AdeCaptainApiShape["getProjectPublicationStack"] =
        Effect.fn("AdeCaptainApi.getProjectPublicationStack")(function* (projectId: AdeProjectId) {
          yield* readProjectRow(projectId);
          const stackRows = yield* sql<StackRow>`
            SELECT * FROM ade_publication_stacks
            WHERE project_id = ${projectId}
            ORDER BY created_at DESC, rowid DESC
          `;
          const stackRow = selectStackRow(stackRows);
          if (stackRow === null) return null;
          const layerRows = yield* sql<LayerRow>`
            SELECT * FROM ade_publication_layers
            WHERE publication_stack_id = ${stackRow.publication_stack_id}
            ORDER BY layer_order ASC
          `;
          return {
            stack: rowToStack(stackRow),
            layers: layerRows.map(rowToLayer),
          } satisfies AdePublicationStackView;
        }, captainize);

      const getAssignmentGraph: AdeCaptainApiShape["getAssignmentGraph"] = Effect.fn(
        "AdeCaptainApi.getAssignmentGraph",
      )(function* (input: AdeAssignmentGraphInput) {
        const projectId = input.projectId;
        if (projectId !== null) yield* readProjectRow(projectId);
        // Scope narrows on project only. Bot and status filtering stays on the
        // client (spec §7 slice 4) precisely so narrowing the list cannot cut
        // the lineage chain the tree is drawing.
        //
        // The window is the other half of that bargain: `ade_assignments` only
        // grows, and this is polled on a timer, so the read takes the most
        // recent N and admits to the rest through `truncated`. One extra row is
        // fetched purely to detect that there is a rest.
        const limit = Math.min(
          input.limit ?? ASSIGNMENT_GRAPH_DEFAULT_LIMIT,
          ASSIGNMENT_GRAPH_MAX_LIMIT,
        );
        const windowed = limit + 1;
        const recent =
          projectId === null
            ? yield* sql<AssignmentRow>`
                SELECT * FROM ade_assignments
                ORDER BY created_at DESC, rowid DESC
                LIMIT ${windowed}
              `
            : yield* sql<AssignmentRow>`
                SELECT * FROM ade_assignments
                WHERE project_id = ${projectId}
                ORDER BY created_at DESC, rowid DESC
                LIMIT ${windowed}
              `;
        const truncated = recent.length > limit;
        // Back to oldest-first: the tree assembles parents before children, and
        // the contract promises creation order.
        const rows = recent.slice(0, limit).toReversed();

        const botRows = yield* sql<{ bot_id: string; name: string }>`
          SELECT bot_id, name FROM ade_bots
        `;
        const botNames = new Map(botRows.map((bot) => [bot.bot_id, bot.name] as const));
        const projects = yield* projectNames;

        // `rowToAssignment` parses JSON and throws on a corrupt blob. Same
        // reasoning as the queue: skip the row rather than fail a polled read.
        const decoded = rows.map(safeRowToAssignment);
        const assignments = decoded.filter((assignment) => assignment !== null);

        // Children are counted *within this response* — scoped, not a
        // table-wide GROUP BY. A child beyond the window or outside the project
        // is simply not counted, which is what keeps this read bounded.
        const childCounts = new Map<string, number>();
        for (const assignment of assignments) {
          const parentId = assignment.parentAssignmentId;
          if (parentId === null) continue;
          childCounts.set(parentId, (childCounts.get(parentId) ?? 0) + 1);
        }

        const nodes = assignments.map(
          (assignment) =>
            ({
              id: assignment.id,
              parentAssignmentId: assignment.parentAssignmentId,
              recipientBotId: assignment.recipientBotId,
              // A bot deleted mid-flight takes its assignments with it (055
              // cascades on recipient), but a rename race can still miss; name
              // the id rather than dropping the lineage.
              botName: botNames.get(assignment.recipientBotId) ?? assignment.recipientBotId,
              projectId: assignment.projectId,
              projectName:
                assignment.projectId === null ? null : (projects.get(assignment.projectId) ?? null),
              status: assignment.status,
              blockedReason: assignment.blockedReason,
              declaredRisk: assignment.declaredRisk,
              title: firstLine(assignment.instruction),
              resultLine:
                assignment.result === null
                  ? null
                  : nullIfBlank(firstLine(assignment.result.summary)),
              resultStatus: assignment.result === null ? null : assignment.result.status,
              childCount: childCounts.get(assignment.id) ?? 0,
              createdAt: assignment.createdAt,
            }) satisfies AdeAssignmentGraphNode,
        );

        const bots = [...new Map(nodes.map((node) => [node.recipientBotId, node]))]
          .map(([id, node]) => ({ id, name: node.botName }))
          .sort((left, right) => left.name.localeCompare(right.name));

        return {
          nodes,
          bots,
          truncated,
          unreadableRows: decoded.length - assignments.length,
        } satisfies AdeAssignmentGraph;
      }, captainize);

      return AdeCaptainApi.of({
        getRoster,
        getProject,
        listProjectCandidates,
        getProjectPublicationStack,
        getAssignmentGraph,
        getBot,
        createBotFromTemplate,
        createProject,
        writeBotMemory,
        editBotPersona,
        setBotComputerUse,
        getBotScreen,
        startBotDesktop,
        stopBotDesktop,
        deleteBot,
        getNeedsYouCount,
        listNeedsYou,
        getNeedsYouItem,
        submitNeedsYouDecision,
        startBotChat,
      });
    }),
  );
}

export type { PersistenceSqlError };
