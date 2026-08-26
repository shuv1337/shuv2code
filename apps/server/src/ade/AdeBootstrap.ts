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

/**
 * A cap refused the create (issue #223). Raised from *inside* the insert
 * transaction, so it is the authority on the fleet's size rather than a
 * pre-flight guess: a tool-plane pre-check keeps the model's refusal fast and
 * well-worded, and this keeps two concurrent coordinators from both passing
 * that pre-check and landing bot 9.
 */
export class AdeBotCapExceededError extends Schema.TaggedErrorClass<AdeBotCapExceededError>()(
  "AdeBotCapExceededError",
  {
    scope: Schema.Literals(["fleet", "project"]),
    cap: Schema.Number,
    count: Schema.Number,
  },
) {
  override get message(): string {
    return `ADE ${this.scope} is at its cap of ${this.cap} bots (${this.count} active).`;
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

/** Per-scope bot caps enforced inside the insert transaction (issue #223). */
export interface InstantiateTemplateCaps {
  readonly maxFleetBots: number;
  readonly maxBotsPerProject: number;
}

export interface InstantiateTemplateInput {
  readonly templateId: AdeBotTemplateId;
  /** Crew/coordinator home project; null for fleet-shared specialists. */
  readonly projectId: AdeProjectId | null;
  /** Optional display-name override; defaults to the template's name. */
  readonly name?: string;
  /**
   * The bot that provisioned this one (spec §3.2 attribution). Null — the
   * default — means the captain's RPC or the boot check created it.
   */
  readonly createdByBotId?: BotId | null;
  /**
   * Durable replay key. A second call carrying a key that a *live* bot already
   * holds returns that bot with `created: false` instead of minting a twin.
   */
  readonly provisionIdempotencyKey?: string | null;
  /** Omitted → uncapped, which is what the captain's own RPC path wants. */
  readonly caps?: InstantiateTemplateCaps;
}

export interface InstantiatedBot {
  readonly botId: BotId;
  readonly personaVersionId: PersonaVersionId;
  /** False when `provisionIdempotencyKey` matched a live bot (replay). */
  readonly created: boolean;
  readonly name: string;
  readonly roleTag: string;
  readonly projectId: AdeProjectId | null;
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
  ) => Effect.Effect<
    InstantiatedBot,
    AdeTemplateNotInstantiableError | AdeBotCapExceededError | PersistenceSqlError
  >;
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
        readonly createdByBotId?: string | null;
        readonly provisionIdempotencyKey?: string | null;
      }) {
        const botId = input.botId ?? (yield* uuid);
        const personaVersionId = yield* uuid;
        const at = yield* nowIso;

        const inserted = yield* sql`
          INSERT INTO ade_bots (
            bot_id, name, display_meta_json, structural_role, role_tag,
            project_id, active_persona_version_id, computer_use, created_at, archived_at,
            created_by_bot_id, provision_idempotency_key
          ) VALUES (
            ${botId}, ${input.name}, NULL, ${input.structuralRole}, ${input.roleTag},
            ${input.projectId}, NULL, 0, ${at}, NULL,
            ${input.createdByBotId ?? null}, ${input.provisionIdempotencyKey ?? null}
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
          created: true,
          name: input.name,
          roleTag: input.roleTag,
          projectId: input.projectId as AdeProjectId | null,
        } satisfies InstantiatedBot;
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
        const key = input.provisionIdempotencyKey ?? null;
        const caps = input.caps;

        // Read-check-insert in ONE transaction. The replay lookup and the cap
        // counts are only trustworthy if nothing can insert between them and
        // the insert they gate — a pre-flight check outside the transaction
        // lets two concurrent coordinators both observe 7 bots and both land.
        const outcome = yield* sql
          .withTransaction(
            Effect.gen(function* () {
              if (key !== null) {
                const replays = yield* sql<{
                  bot_id: string;
                  name: string;
                  role_tag: string;
                  project_id: string | null;
                  active_persona_version_id: string | null;
                }>`
                  SELECT bot_id, name, role_tag, project_id, active_persona_version_id
                  FROM ade_bots
                  WHERE provision_idempotency_key = ${key} AND archived_at IS NULL
                `;
                const replay = replays[0];
                if (replay !== undefined) {
                  return {
                    botId: replay.bot_id as BotId,
                    personaVersionId: (replay.active_persona_version_id ?? "") as PersonaVersionId,
                    created: false,
                    name: replay.name,
                    roleTag: replay.role_tag,
                    projectId: replay.project_id as AdeProjectId | null,
                  } satisfies InstantiatedBot;
                }
              }

              if (caps !== undefined) {
                const fleetRows = yield* sql<{ n: number }>`
                  SELECT COUNT(*) AS n FROM ade_bots WHERE archived_at IS NULL
                `;
                const fleetCount = fleetRows[0]?.n ?? 0;
                if (fleetCount >= caps.maxFleetBots) {
                  return yield* new AdeBotCapExceededError({
                    scope: "fleet",
                    cap: caps.maxFleetBots,
                    count: fleetCount,
                  });
                }
                if (input.projectId !== null) {
                  const projectRows = yield* sql<{ n: number }>`
                    SELECT COUNT(*) AS n FROM ade_bots
                    WHERE archived_at IS NULL AND project_id = ${input.projectId}
                  `;
                  const projectCount = projectRows[0]?.n ?? 0;
                  if (projectCount >= caps.maxBotsPerProject) {
                    return yield* new AdeBotCapExceededError({
                      scope: "project",
                      cap: caps.maxBotsPerProject,
                      count: projectCount,
                    });
                  }
                }
              }

              return yield* insertBotGraph({
                name: input.name ?? template.defaultName,
                structuralRole: template.structuralRole,
                roleTag: template.roleTag,
                projectId: input.projectId,
                personaContent: template.personaContent,
                createdByBotId: input.createdByBotId ?? null,
                provisionIdempotencyKey: key,
              });
            }),
          )
          .pipe(
            // Only the SQL failure is reshaped; the cap refusal is a domain
            // answer and travels untouched.
            Effect.catchTag("SqlError", (error) =>
              Effect.fail(toPersistenceSqlError("AdeBootstrap.instantiateTemplate")(error)),
            ),
          );
        // Crew templates never carry the firstmate role, so the
        // single-firstmate index cannot reject them and insertBotGraph
        // always returns ids.
        if (outcome === null) {
          return yield* Effect.die(
            new Error("template bot insert reported an impossible conflict"),
          );
        }
        return outcome;
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
