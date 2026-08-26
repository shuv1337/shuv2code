/**
 * `create_bot` — the fleet's provisioning slice of the ADE tool plane (spec
 * `docs/ade/ADE-V1-SPEC.md` §3.1–3.2, `docs/ade/MESSENGER-PIVOT.md` §4, issue
 * #223).
 *
 * A coordinator that can delegate but cannot hire is half a coordinator: asked
 * for a reviewer it could only tell the captain to go configure one by hand.
 * This layer gives the Firstmate and each Second Mate the same
 * bot-from-template path the captain's roster uses, under the gate's ordinary
 * rules.
 *
 * Two layers plug in without touching the gate:
 *
 * - `AdeFleetProvisioningInlineChecks.layer` — every refusal (coordinator-only
 *   eligibility, the Second Mate's project scope, an unknown project, the
 *   fleet/project caps) as one typed `bot-provisioning-not-allowed` denial
 *   that names the rule and, for a cap, the count that hit it.
 * - `AdeFleetProvisioningToolHandlers.layer` — name defaulting and the create
 *   itself.
 *
 * **Creation is not duplicated**: the handler calls `AdeBootstrap`, the same
 * service `ade.createBotFromTemplate` delegates to, so persona copy-on-create,
 * the empty memory document and the atomic bot graph come for free — and the
 * rail sees the new contact through `AdeRosterFeed`'s recompute, with no
 * projection wiring of our own.
 *
 * **Caps are constants, not config.** `ade_limits_config.maxBots` exists and
 * defaults to the same 24, but it is the captain's knob; a bot's own hiring
 * budget should not move because a captain widened an unrelated limit. Revisit
 * if the two ever need to agree.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { AdeCreateBotToolInput, AdeProjectId, BotId } from "@shuv2code/contracts";

import { AdeBootstrap } from "./AdeBootstrap.ts";
import { ADE_BOT_TEMPLATES } from "./personaTemplates.ts";
import {
  AdeToolExecutionError,
  AdeToolHandlers,
  AdeToolInlineChecks,
  type AdeInlineCheckDecision,
  type AdeToolCallContext,
  type AdeToolHandlersShape,
  type AdeToolInlineChecksShape,
  type CreateBotInput,
} from "./AdeToolGate.ts";

const TOOL = "create_bot";

/** Crew a single project may hold at once, coordinators included. */
export const ADE_MAX_BOTS_PER_PROJECT = 8;

/** Bots the whole fleet may hold at once (ADR §18.1's `maxBots` default). */
export const ADE_MAX_FLEET_BOTS = 24;

interface CallerRow {
  readonly structural_role: string;
  readonly project_id: string | null;
  readonly archived_at: string | null;
}

/**
 * Where a `create_bot` call resolved to, or the rule that stopped it. The
 * inline check and the handler both go through this so the decision a bot was
 * granted is the decision that gets executed.
 */
export type AdeProvisioningResolution =
  | {
      readonly _tag: "allowed";
      readonly projectId: AdeProjectId | null;
      readonly projectName: string | null;
    }
  | { readonly _tag: "refused"; readonly reason: string };

const refused = (reason: string): AdeProvisioningResolution => ({ _tag: "refused", reason });

export interface AdeFleetProvisioning {
  readonly resolve: (input: {
    readonly callerBotId: BotId;
    readonly request: AdeCreateBotToolInput;
  }) => Effect.Effect<AdeProvisioningResolution>;
  /** Fleet-unique display name: the requested one, suffixed on collision. */
  readonly resolveName: (base: string) => Effect.Effect<string>;
}

export const makeAdeFleetProvisioning = (sql: SqlClient.SqlClient): AdeFleetProvisioning => {
  const readCaller = (botId: BotId) =>
    sql<CallerRow>`
      SELECT structural_role, project_id, archived_at
      FROM ade_bots WHERE bot_id = ${botId}
    `.pipe(Effect.map((rows) => rows[0] ?? null));

  const readProjectName = (projectId: string) =>
    sql<{ name: string }>`
      SELECT name FROM ade_projects WHERE project_id = ${projectId}
    `.pipe(Effect.map((rows) => rows[0]?.name ?? null));

  const countBots = (projectId: string | null) =>
    (projectId === null
      ? sql<{ n: number }>`SELECT COUNT(*) AS n FROM ade_bots WHERE archived_at IS NULL`
      : sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM ade_bots
          WHERE archived_at IS NULL AND project_id = ${projectId}
        `
    ).pipe(Effect.map((rows) => rows[0]?.n ?? 0));

  const resolve: AdeFleetProvisioning["resolve"] = Effect.fn("AdeFleetProvisioning.resolve")(
    function* (input: { callerBotId: BotId; request: AdeCreateBotToolInput }) {
      const caller = yield* readCaller(input.callerBotId);
      if (caller === null) return refused("the calling bot no longer exists");
      if (caller.archived_at !== null) return refused("the calling bot is archived");

      const requested = input.request.projectId;
      let targetProjectId: string | null;
      if (caller.structural_role === "firstmate") {
        // Omitted means "where I live", which for the fleet-wide coordinator
        // is nowhere in particular — a fleet-shared specialist.
        targetProjectId = requested === undefined ? caller.project_id : requested;
      } else if (caller.structural_role === "second-mate") {
        if (caller.project_id === null) {
          return refused("the calling Second Mate has no project to create bots in");
        }
        if (requested === null) {
          return refused(
            "a Second Mate may only create bots in its own project; fleet-shared specialists are the Firstmate's to create",
          );
        }
        if (requested !== undefined && requested !== caller.project_id) {
          return refused(
            `a Second Mate may only create bots in its own project ('${caller.project_id}')`,
          );
        }
        targetProjectId = caller.project_id;
      } else {
        return refused(
          "only coordinators create bots — the Firstmate for the fleet, a Second Mate for its own project",
        );
      }

      const projectName = targetProjectId === null ? null : yield* readProjectName(targetProjectId);
      if (targetProjectId !== null && projectName === null) {
        return refused(`no project '${targetProjectId}' exists`);
      }

      const fleetCount = yield* countBots(null);
      if (fleetCount >= ADE_MAX_FLEET_BOTS) {
        return refused(
          `the fleet is at its cap of ${ADE_MAX_FLEET_BOTS} bots (${fleetCount} active); archive one before creating another`,
        );
      }
      if (targetProjectId !== null) {
        const projectCount = yield* countBots(targetProjectId);
        if (projectCount >= ADE_MAX_BOTS_PER_PROJECT) {
          return refused(
            `project '${projectName}' is at its cap of ${ADE_MAX_BOTS_PER_PROJECT} bots (${projectCount} active); archive one before creating another`,
          );
        }
      }

      return {
        _tag: "allowed",
        projectId: targetProjectId as AdeProjectId | null,
        projectName,
      } as const;
    },
    Effect.orDie,
  );

  /**
   * Case-insensitive over the whole live fleet, not just the target project: a
   * rail that lists "Reviewer" twice is a rail the captain cannot address.
   * Archived names are free to reuse. Terminates because the taken set is
   * bounded by the fleet cap.
   */
  const resolveName: AdeFleetProvisioning["resolveName"] = Effect.fn(
    "AdeFleetProvisioning.resolveName",
  )(function* (base: string) {
    const rows = yield* sql<{ name: string }>`
        SELECT name FROM ade_bots WHERE archived_at IS NULL
      `;
    const taken = new Set(rows.map((row) => row.name.trim().toLowerCase()));
    if (!taken.has(base.toLowerCase())) return base;
    let suffix = 2;
    let candidate = `${base} ${suffix}`;
    while (taken.has(candidate.toLowerCase())) {
      suffix += 1;
      candidate = `${base} ${suffix}`;
    }
    return candidate;
  }, Effect.orDie);

  return { resolve, resolveName };
};

export class AdeFleetProvisioningInlineChecks {
  /** Patch-style override so it stacks on the S7 routing/ownership checks. */
  static readonly layer: Layer.Layer<
    AdeToolInlineChecks,
    never,
    AdeToolInlineChecks | SqlClient.SqlClient
  > = Layer.effect(
    AdeToolInlineChecks,
    Effect.gen(function* () {
      const base = yield* AdeToolInlineChecks;
      const sql = yield* SqlClient.SqlClient;
      const provisioning = makeAdeFleetProvisioning(sql);

      const isBotProvisioningAllowed: AdeToolInlineChecksShape["isBotProvisioningAllowed"] = (
        input,
      ) =>
        provisioning
          .resolve({ callerBotId: input.caller.botId, request: input.request })
          .pipe(
            Effect.map(
              (resolution): AdeInlineCheckDecision =>
                resolution._tag === "allowed"
                  ? { allowed: true }
                  : { allowed: false, reason: resolution.reason },
            ),
          );

      return AdeToolInlineChecks.of({ ...base, isBotProvisioningAllowed });
    }),
  );
}

export class AdeFleetProvisioningToolHandlers extends Context.Service<
  AdeFleetProvisioningToolHandlers,
  Pick<AdeToolHandlersShape, "createBot">
>()("shuv2code/ade/AdeFleetProvisioningToolHandlers") {
  /** Patch-style override so it stacks with the S7/S8 handler layers. */
  static readonly layer: Layer.Layer<
    AdeToolHandlers,
    never,
    AdeToolHandlers | AdeBootstrap | SqlClient.SqlClient
  > = Layer.effect(
    AdeToolHandlers,
    Effect.gen(function* () {
      const base = yield* AdeToolHandlers;
      const bootstrap = yield* AdeBootstrap;
      const sql = yield* SqlClient.SqlClient;
      const provisioning = makeAdeFleetProvisioning(sql);

      const createBot: AdeToolHandlersShape["createBot"] = Effect.fn(
        "AdeFleetProvisioningToolHandlers.createBot",
      )(
        function* (ctx: AdeToolCallContext, input: CreateBotInput) {
          // Re-resolved rather than carried over from the inline check: the
          // seam hands the gate a yes/no, and re-deriving the target here is
          // what keeps "what was allowed" and "what was created" the same
          // decision even if the fleet moved between the two reads.
          const resolution = yield* provisioning.resolve({
            callerBotId: ctx.botId,
            request: input,
          });
          if (resolution._tag === "refused") {
            return yield* new AdeToolExecutionError({ tool: TOOL, detail: resolution.reason });
          }
          const template = ADE_BOT_TEMPLATES[input.templateId];
          const name = yield* provisioning.resolveName(input.name ?? template.defaultName);
          const created = yield* bootstrap.instantiateTemplate({
            templateId: input.templateId,
            projectId: resolution.projectId,
            name,
          });
          const where =
            resolution.projectName === null
              ? "as a fleet-shared specialist"
              : `in project '${resolution.projectName}'`;
          return JSON.stringify({
            botId: created.botId,
            name,
            roleTag: template.roleTag,
            projectId: resolution.projectId,
            summary: `Created ${name} (${template.roleTag}) ${where}. Assign work to it with create_assignment using botId '${created.botId}'.`,
          });
        },
        Effect.catchTags({
          AdeTemplateNotInstantiableError: (error) =>
            Effect.fail(new AdeToolExecutionError({ tool: TOOL, detail: error.message })),
          PersistenceSqlError: (error) =>
            Effect.fail(new AdeToolExecutionError({ tool: TOOL, detail: error.message })),
        }),
      );

      return AdeToolHandlers.of({ ...base, createBot });
    }),
  );
}
