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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  type AdeAssignmentGraph,
  type AdeAssignmentGraphInput,
  type AdeAssignmentGraphNode,
  type AdeBotChatSession,
  type AdeBotDetail,
  type AdeBotTemplateSummary,
  type AdeCreateBotFromTemplateInput,
  type AdeCreateProjectInput,
  type AdeCreatedProject,
  type AdeEditPersonaInput,
  type AdeListProjectCandidatesInput,
  type AdeNeedsYouCount,
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
  type Bot,
  type BotDisplayMeta,
  type BotId,
  type BotName,
  type BotRoleTag,
  type BotStructuralRole,
  type IntegrationPolicy,
  type LimitsOverrides,
  type MemoryDocument,
  type PersonaVersion,
  type PersonaVersionId,
  type PublicationLayer,
  type PublicationLayerId,
  type PublicationStack,
  type PublicationStackId,
  type SharedSpecialistAllowList,
} from "@shuv2code/contracts";

import { type PersistenceSqlError } from "../persistence/Errors.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";
import { AdeAssignmentEngine, type AssignmentRow, rowToAssignment } from "./AdeAssignmentEngine.ts";
import { type CandidateRow, rowToCandidate } from "./AdeIntegrationService.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import { AdeChatSessionPort } from "./AdeChatSessionPort.ts";
import { AdePersonaMemory } from "./AdePersonaMemory.ts";
import { AdeSessionRollover } from "./AdeSessionRollover.ts";
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
const LIVE_STACK_STATUSES: ReadonlyArray<PublicationStack["status"]> = new Set([
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
  readonly getNeedsYouCount: () => Effect.Effect<AdeNeedsYouCount, AdeCaptainError>;
  readonly startBotChat: (botId: BotId) => Effect.Effect<AdeBotChatSession, AdeCaptainError>;
  readonly getProject: (
    projectId: AdeProjectId,
  ) => Effect.Effect<AdeProjectDetail, AdeCaptainError>;
  readonly listProjectCandidates: (
    input: AdeListProjectCandidatesInput,
  ) => Effect.Effect<AdeProjectCandidates, AdeCaptainError>;
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

      const getNeedsYouCount: AdeCaptainApiShape["getNeedsYouCount"] = Effect.fn(
        "AdeCaptainApi.getNeedsYouCount",
      )(function* () {
        const rows = yield* sql<{ open_count: number }>`
            SELECT COUNT(*) AS open_count FROM ade_needs_you_items WHERE status = 'open'
          `;
        return { open: rows[0]?.open_count ?? 0 } satisfies AdeNeedsYouCount;
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
      )(function* (input: AdeListProjectCandidatesInput) {
        yield* readProjectRow(input.projectId);
        // Queue order, oldest first — the same order the integration service
        // itself walks (ADR §7.2), so the panel's top row is the head.
        const rows = yield* sql<CandidateRow>`
          SELECT * FROM ade_integration_candidates
          WHERE project_id = ${input.projectId}
          ORDER BY created_at ASC, rowid ASC
        `;
        const statuses = input.statuses;
        const filtered =
          statuses === undefined || statuses.length === 0
            ? rows
            : rows.filter((row) => statuses.includes(row.status as (typeof statuses)[number]));
        const candidates = yield* Effect.forEach(filtered, rowToCandidate);
        return { candidates } satisfies AdeProjectCandidates;
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
        const rows =
          projectId === null
            ? yield* sql<AssignmentRow>`
                SELECT * FROM ade_assignments ORDER BY created_at ASC, rowid ASC
              `
            : yield* sql<AssignmentRow>`
                SELECT * FROM ade_assignments
                WHERE project_id = ${projectId}
                ORDER BY created_at ASC, rowid ASC
              `;
        // Counted across the whole table, not just this scope: a child may be
        // addressed to a bot on another project, and the node has to admit to
        // descendants the graph is not showing.
        const childRows = yield* sql<{ parent_assignment_id: string; child_count: number }>`
          SELECT parent_assignment_id, COUNT(*) AS child_count FROM ade_assignments
          WHERE parent_assignment_id IS NOT NULL
          GROUP BY parent_assignment_id
        `;
        const childCounts = new Map(
          childRows.map((child) => [child.parent_assignment_id, child.child_count] as const),
        );
        const botRows = yield* sql<{ bot_id: string; name: string }>`
          SELECT bot_id, name FROM ade_bots
        `;
        const botNames = new Map(botRows.map((bot) => [bot.bot_id, bot.name] as const));
        const projects = yield* projectNames;

        const nodes = rows.map((row) => {
          const assignment = rowToAssignment(row);
          return {
            assignment,
            // A deleted bot leaves forensic rows behind (055's delete graph);
            // the graph names it rather than dropping the lineage.
            botName: botNames.get(assignment.recipientBotId) ?? assignment.recipientBotId,
            projectName:
              assignment.projectId === null ? null : (projects.get(assignment.projectId) ?? null),
            childCount: childCounts.get(assignment.id) ?? 0,
          } satisfies AdeAssignmentGraphNode;
        });

        const bots = [...new Map(nodes.map((node) => [node.assignment.recipientBotId, node]))]
          .map(([id, node]) => ({ id, name: node.botName }))
          .sort((left, right) => left.name.localeCompare(right.name));

        return { nodes, bots } satisfies AdeAssignmentGraph;
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
        getNeedsYouCount,
        startBotChat,
      });
    }),
  );
}

export type { PersistenceSqlError };
