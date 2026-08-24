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
  type AdeBotChatSession,
  type AdeBotDetail,
  type AdeBotTemplateSummary,
  type AdeCreateBotFromTemplateInput,
  type AdeEditPersonaInput,
  type AdeNeedsYouCount,
  type AdeProjectId,
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
  type MemoryDocument,
  type PersonaVersion,
  type PersonaVersionId,
} from "@shuv2code/contracts";

import { type PersistenceSqlError } from "../persistence/Errors.ts";
import { AdeAssignmentEngine } from "./AdeAssignmentEngine.ts";
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
  > = Layer.effect(
    AdeCaptainApi,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const bootstrap = yield* AdeBootstrap;
      const personaMemory = yield* AdePersonaMemory;
      const rollover = yield* AdeSessionRollover;
      const assignments = yield* AdeAssignmentEngine;
      const chat = yield* AdeChatSessionPort;

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

      return AdeCaptainApi.of({
        getRoster,
        getBot,
        createBotFromTemplate,
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
