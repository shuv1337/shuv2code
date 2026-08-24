// @effect-diagnostics nodeBuiltinImport:off
/**
 * ADE bootstrap & bot lifecycle seams (spec `docs/ade/ADE-V1-SPEC.md` §4.1,
 * issue #157).
 *
 * - `ensureSeeded` is the idempotent, self-healing boot check: creates the
 *   permanent Firstmate (shipped persona → PersonaVersion v1, empty memory)
 *   iff no firstmate-role bot exists, and seeds the `ade_limits_config`
 *   singleton with the ADR §18.1 defaults. Both steps are race-proof: the
 *   `idx_ade_bots_single_firstmate` partial unique index and the `id = 1`
 *   primary key turn a lost race into `ON CONFLICT DO NOTHING`.
 * - `instantiateTemplate` is copy-on-create: the shipped template's content
 *   is copied into the new bot's PersonaVersion v1 and the template link ends
 *   there — later template edits never touch existing personas.
 * - `createProject` carries the auto-Second-Mate hook: every ADE project is
 *   created together with its Second Mate, atomically.
 * - `archiveBot` enforces Firstmate permanence (service-level rule, spec §2.1).
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
  type BotId,
  DEFAULT_INTEGRATION_POLICY,
  type IntegrationPolicy,
  LimitsConfig,
  type PersonaVersionId,
  type RepoBinding,
} from "@shuv2code/contracts";

import { type PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";
import {
  ADE_BOT_TEMPLATES,
  type AdeBotTemplateId,
  FIRSTMATE_TEMPLATE,
  SECOND_MATE_TEMPLATE,
} from "./personaTemplates.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** The Firstmate is permanent — archive/delete is forbidden (spec §2.1, §4.1). */
export class FirstmatePermanentError extends Schema.TaggedErrorClass<FirstmatePermanentError>()(
  "FirstmatePermanentError",
  {
    botId: Schema.String,
  },
) {
  override get message(): string {
    return `Bot '${this.botId}' is the Firstmate and cannot be archived or deleted.`;
  }
}

export class AdeBotNotFoundError extends Schema.TaggedErrorClass<AdeBotNotFoundError>()(
  "AdeBotNotFoundError",
  {
    botId: Schema.String,
  },
) {
  override get message(): string {
    return `ADE bot '${this.botId}' does not exist.`;
  }
}

/**
 * Only crew templates are one-click instantiable (spec §4.1): the Firstmate
 * exists via the ensure-on-boot check and a Second Mate only via project
 * creation. `AdeBotTemplateId` already excludes coordinators at the type
 * level; this error is the runtime defense against untyped callers.
 */
export class AdeTemplateNotInstantiableError extends Schema.TaggedErrorClass<AdeTemplateNotInstantiableError>()(
  "AdeTemplateNotInstantiableError",
  {
    templateId: Schema.String,
  },
) {
  override get message(): string {
    return `Template '${this.templateId}' is not one-click instantiable; coordinator bots come from boot or project creation.`;
  }
}

// ---------------------------------------------------------------------------
// Service shape
// ---------------------------------------------------------------------------

export interface EnsureSeededResult {
  readonly firstmateBotId: BotId;
  /** False when a previous boot (or a concurrent racer) already created it. */
  readonly firstmateCreated: boolean;
  /** False when the `ade_limits_config` singleton already existed. */
  readonly limitsSeeded: boolean;
}

export interface InstantiateTemplateInput {
  readonly templateId: AdeBotTemplateId;
  /** Crew/coordinator home project; null for fleet-shared specialists. */
  readonly projectId: AdeProjectId | null;
  /** Optional display-name override; defaults to the template's name. */
  readonly name?: string;
}

export interface InstantiatedBot {
  readonly botId: BotId;
  readonly personaVersionId: PersonaVersionId;
}

export interface CreateProjectInput {
  readonly name: string;
  readonly repoBinding?: RepoBinding | null;
  readonly integrationPolicyDefault?: IntegrationPolicy;
}

export interface CreatedProject {
  readonly projectId: AdeProjectId;
  readonly secondMate: InstantiatedBot;
}

export interface AdeBootstrapShape {
  readonly ensureSeeded: () => Effect.Effect<EnsureSeededResult, PersistenceSqlError>;
  readonly instantiateTemplate: (
    input: InstantiateTemplateInput,
  ) => Effect.Effect<InstantiatedBot, AdeTemplateNotInstantiableError | PersistenceSqlError>;
  readonly createProject: (
    input: CreateProjectInput,
  ) => Effect.Effect<CreatedProject, PersistenceSqlError>;
  readonly archiveBot: (
    botId: BotId,
  ) => Effect.Effect<void, FirstmatePermanentError | AdeBotNotFoundError | PersistenceSqlError>;
}

export class AdeBootstrap extends Context.Service<AdeBootstrap, AdeBootstrapShape>()(
  "shuv2code/ade/AdeBootstrap",
) {
  static readonly layer = Layer.effect(
    AdeBootstrap,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
      const uuid = Effect.sync(() => NodeCrypto.randomUUID());

      /**
       * Insert bot + PersonaVersion v1 (content copied from the caller) +
       * empty memory document. Must run inside a transaction. Returns the
       * ids, or null when the bot insert lost to the single-firstmate index.
       */
      const insertBotGraph = Effect.fn("AdeBootstrap.insertBotGraph")(function* (input: {
        readonly name: string;
        readonly structuralRole: string;
        readonly roleTag: string;
        readonly projectId: string | null;
        readonly personaContent: string;
        /** Pre-minted id when another row must name this bot first. */
        readonly botId?: string;
      }) {
        const botId = input.botId ?? (yield* uuid);
        const personaVersionId = yield* uuid;
        const at = yield* nowIso;

        const inserted = yield* sql`
          INSERT INTO ade_bots (
            bot_id, name, display_meta_json, structural_role, role_tag,
            project_id, active_persona_version_id, computer_use, created_at, archived_at
          ) VALUES (
            ${botId}, ${input.name}, NULL, ${input.structuralRole}, ${input.roleTag},
            ${input.projectId}, NULL, 0, ${at}, NULL
          )
          ON CONFLICT DO NOTHING
          RETURNING bot_id
        `;
        if (inserted.length === 0) return null;

        yield* sql`
          INSERT INTO ade_persona_versions (
            persona_version_id, bot_id, content, created_at, activated_at
          ) VALUES (${personaVersionId}, ${botId}, ${input.personaContent}, ${at}, ${at})
        `;
        yield* sql`
          UPDATE ade_bots SET active_persona_version_id = ${personaVersionId}
          WHERE bot_id = ${botId}
        `;
        yield* sql`
          INSERT INTO ade_memory_documents (bot_id, content, updated_at, updated_by)
          VALUES (${botId}, ${""}, ${at}, 'system')
        `;

        return {
          botId: botId as BotId,
          personaVersionId: personaVersionId as PersonaVersionId,
        };
      });

      const ensureFirstmate = Effect.gen(function* () {
        const created = yield* insertBotGraph({
          name: FIRSTMATE_TEMPLATE.defaultName,
          structuralRole: FIRSTMATE_TEMPLATE.structuralRole,
          roleTag: FIRSTMATE_TEMPLATE.roleTag,
          projectId: null,
          personaContent: FIRSTMATE_TEMPLATE.personaContent,
        });
        if (created !== null) {
          return { firstmateBotId: created.botId, firstmateCreated: true };
        }
        // Lost to the partial unique index (or an earlier boot): read the
        // permanent row it protects.
        const rows = yield* sql<{ bot_id: string }>`
          SELECT bot_id FROM ade_bots WHERE structural_role = 'firstmate'
        `;
        const existing = rows[0];
        if (existing === undefined) {
          return yield* Effect.die(
            new Error("ade_bots rejected a firstmate insert without holding a firstmate row"),
          );
        }
        return { firstmateBotId: existing.bot_id as BotId, firstmateCreated: false };
      });

      const encodeLimitsJson = Schema.encodeEffect(Schema.fromJsonString(LimitsConfig));
      const decodeLimitsDefaults = Schema.decodeUnknownEffect(LimitsConfig);

      const ensureLimitsConfig = Effect.gen(function* () {
        // Decoding {} materializes every ADR §18.1 default (contracts ade.ts).
        const defaults = yield* Effect.orDie(decodeLimitsDefaults({}));
        const configJson = yield* Effect.orDie(encodeLimitsJson(defaults));
        const at = yield* nowIso;
        const inserted = yield* sql`
          INSERT INTO ade_limits_config (id, config_json, updated_at)
          VALUES (1, ${configJson}, ${at})
          ON CONFLICT (id) DO NOTHING
          RETURNING id
        `;
        return { limitsSeeded: inserted.length === 1 };
      });

      const ensureSeeded: AdeBootstrapShape["ensureSeeded"] = Effect.fn(
        "AdeBootstrap.ensureSeeded",
      )(
        function* () {
          const { firstmateBotId, firstmateCreated } = yield* sql.withTransaction(ensureFirstmate);
          const { limitsSeeded } = yield* sql.withTransaction(ensureLimitsConfig);
          return { firstmateBotId, firstmateCreated, limitsSeeded };
        },
        Effect.mapError(toPersistenceSqlError("AdeBootstrap.ensureSeeded")),
      );

      const instantiateTemplate: AdeBootstrapShape["instantiateTemplate"] = Effect.fn(
        "AdeBootstrap.instantiateTemplate",
      )(function* (input: InstantiateTemplateInput) {
        const template = ADE_BOT_TEMPLATES[input.templateId] as
          | (typeof ADE_BOT_TEMPLATES)[AdeBotTemplateId]
          | undefined;
        // Runtime defense against untyped callers: only crew templates are
        // one-click instantiable; coordinators come from boot (Firstmate) or
        // project creation (Second Mate).
        if (template === undefined || template.structuralRole !== "crew") {
          return yield* new AdeTemplateNotInstantiableError({ templateId: input.templateId });
        }
        const created = yield* sql
          .withTransaction(
            insertBotGraph({
              name: input.name ?? template.defaultName,
              structuralRole: template.structuralRole,
              roleTag: template.roleTag,
              projectId: input.projectId,
              personaContent: template.personaContent,
            }),
          )
          .pipe(Effect.mapError(toPersistenceSqlError("AdeBootstrap.instantiateTemplate")));
        // Crew templates never carry the firstmate role, so the
        // single-firstmate index cannot reject them and insertBotGraph
        // always returns ids.
        if (created === null) {
          return yield* Effect.die(
            new Error("template bot insert reported an impossible conflict"),
          );
        }
        return created;
      });

      const createProject: AdeBootstrapShape["createProject"] = Effect.fn(
        "AdeBootstrap.createProject",
      )(
        function* (input: CreateProjectInput) {
          const projectId = yield* uuid;
          const at = yield* nowIso;
          const repoBinding = input.repoBinding ?? null;
          const secondMate = yield* sql.withTransaction(
            Effect.gen(function* () {
              const botId = yield* uuid;
              // ade_bots.project_id references ade_projects, while
              // ade_projects.second_mate_bot_id is deliberately not a foreign
              // key (055 migration) — so the project row goes first, already
              // naming its Second Mate.
              yield* sql`
              INSERT INTO ade_projects (
                project_id, name, second_mate_bot_id, repo_path, repo_remote,
                integration_policy_default, check_commands_json,
                shared_specialist_allow_list_json, limits_overrides_json,
                created_at, updated_at
              ) VALUES (
                ${projectId}, ${input.name}, ${botId},
                ${repoBinding?.path ?? null}, ${repoBinding?.remote ?? null},
                ${input.integrationPolicyDefault ?? DEFAULT_INTEGRATION_POLICY}, '[]', '"all"', NULL,
                ${at}, ${at}
              )
            `;
              const template = SECOND_MATE_TEMPLATE;
              const created = yield* insertBotGraph({
                name: template.defaultName,
                structuralRole: template.structuralRole,
                roleTag: template.roleTag,
                projectId,
                personaContent: template.personaContent,
                botId,
              });
              if (created === null) {
                return yield* Effect.die(
                  new Error("second-mate bot insert reported an impossible conflict"),
                );
              }
              return created;
            }),
          );
          return { projectId: projectId as AdeProjectId, secondMate };
        },
        Effect.mapError(toPersistenceSqlError("AdeBootstrap.createProject")),
      );

      const toArchiveSqlError = toPersistenceSqlError("AdeBootstrap.archiveBot");

      // Structural roles are immutable, so the firstmate check does not need
      // a transaction around the SELECT + UPDATE pair.
      const archiveBot: AdeBootstrapShape["archiveBot"] = Effect.fn("AdeBootstrap.archiveBot")(
        function* (botId: BotId) {
          const at = yield* nowIso;
          const rows = yield* sql<{ structural_role: string }>`
            SELECT structural_role FROM ade_bots WHERE bot_id = ${botId}
          `.pipe(Effect.mapError(toArchiveSqlError));
          const row = rows[0];
          if (row === undefined) return yield* new AdeBotNotFoundError({ botId });
          if (row.structural_role === "firstmate") {
            return yield* new FirstmatePermanentError({ botId });
          }
          yield* sql`
            UPDATE ade_bots SET archived_at = ${at}
            WHERE bot_id = ${botId} AND archived_at IS NULL
          `.pipe(Effect.mapError(toArchiveSqlError));
        },
      );

      return AdeBootstrap.of({ ensureSeeded, instantiateTemplate, createProject, archiveBot });
    }),
  );

  /**
   * Boot layer: runs the idempotent seed once at server startup. Compose with
   * `AdeBootstrap.layer` (and a SqlClient) in the server runtime.
   */
  static readonly bootLive = Layer.effectDiscard(
    Effect.gen(function* () {
      const bootstrap = yield* AdeBootstrap;
      const result = yield* bootstrap.ensureSeeded();
      yield* Effect.log("ADE bootstrap ensured").pipe(
        Effect.annotateLogs({
          firstmateBotId: result.firstmateBotId,
          firstmateCreated: result.firstmateCreated,
          limitsSeeded: result.limitsSeeded,
        }),
      );
    }),
  );
}
