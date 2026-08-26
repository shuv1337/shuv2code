// @effect-diagnostics nodeBuiltinImport:off
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
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  AdeCreatedBotToolResult,
  type AdeCreateBotToolInput,
  type AdeProjectId,
  type BotId,
} from "@shuv2code/contracts";

import { AdeBootstrap } from "./AdeBootstrap.ts";
import { ADE_BOT_TEMPLATES, FIRSTMATE_TEMPLATE, SECOND_MATE_TEMPLATE } from "./personaTemplates.ts";
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

/**
 * One wording per rule, shared by the pre-flight inline check and the
 * transaction's authoritative refusal — a bot must not learn two different
 * sentences for the same cap depending on which one caught it.
 */
export const fleetCapRefusal = (count: number): string =>
  `the fleet is at its cap of ${ADE_MAX_FLEET_BOTS} bots (${count} active); archive one before creating another`;

export const projectCapRefusal = (project: string, count: number): string =>
  `project '${project}' is at its cap of ${ADE_MAX_BOTS_PER_PROJECT} bots (${count} active); archive one before creating another`;

/**
 * Coordinator display names are reserved. The templates behind them are
 * already unreachable (the tool's schema admits three specialist ids), but a
 * crew bot literally called "Firstmate" would defeat that at the only place
 * the distinction is visible — the captain's rail.
 */
const RESERVED_BOT_NAMES: ReadonlySet<string> = new Set(
  [FIRSTMATE_TEMPLATE.defaultName, SECOND_MATE_TEMPLATE.defaultName].map((name) =>
    name.trim().toLowerCase(),
  ),
);

export const isReservedBotName = (name: string): boolean =>
  RESERVED_BOT_NAMES.has(name.trim().toLowerCase());

/**
 * Durable replay key, mirroring `create_assignment`'s derived key
 * (`AdeAssignmentTools.deriveAssignmentIdempotencyKey`). Keyed on what the
 * coordinator *asked for*, not on what got created: the de-duplicating name
 * suffix is a consequence of the request, so keying on the resolved name would
 * make every replay look novel and mint "Coder 2".
 */
export const deriveProvisionIdempotencyKey = (input: {
  readonly callerBotId: BotId;
  readonly templateId: string;
  readonly requestedName: string;
  readonly projectId: string | null;
}): string => {
  const digest = NodeCrypto.createHash("sha256")
    .update(
      JSON.stringify([
        input.callerBotId,
        input.templateId,
        input.requestedName.trim().toLowerCase(),
        input.projectId,
      ]),
    )
    .digest("hex");
  return `provision:${digest}`;
};

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

  const readProjectById = (projectId: string) =>
    sql<{ project_id: string; name: string }>`
      SELECT project_id, name FROM ade_projects WHERE project_id = ${projectId}
    `.pipe(Effect.map((rows) => rows[0] ?? null));

  /**
   * Name lookup is the whole reason `create_bot` is usable by voice or chat.
   * Nothing in the bot-facing plane hands a model a project *id* — `fleet_read`
   * prints ids, the captain says "Harbor" — so an id-only parameter would make
   * the ticket's own acceptance ("create a reviewer bot for Harbor") fail with
   * "no project exists" or silently create a fleet-shared bot. Exact match
   * after trim, case-insensitive; ambiguity is refused rather than guessed.
   */
  const readProjectsByName = (name: string) =>
    sql<{ project_id: string; name: string }>`
      SELECT project_id, name FROM ade_projects
      WHERE lower(trim(name)) = lower(trim(${name}))
      ORDER BY created_at ASC, rowid ASC
    `;

  const countBots = (projectId: string | null) =>
    (projectId === null
      ? sql<{ n: number }>`SELECT COUNT(*) AS n FROM ade_bots WHERE archived_at IS NULL`
      : sql<{ n: number }>`
          SELECT COUNT(*) AS n FROM ade_bots
          WHERE archived_at IS NULL AND project_id = ${projectId}
        `
    ).pipe(Effect.map((rows) => rows[0]?.n ?? 0));

  /** `undefined` = not stated, `null` = explicitly fleet-shared. */
  type RequestedProject =
    | { readonly _tag: "unstated" }
    | { readonly _tag: "fleet-shared" }
    | { readonly _tag: "project"; readonly projectId: string; readonly name: string }
    | { readonly _tag: "refused"; readonly reason: string };

  // Uniform return type: without it the generator's inferred union collapses
  // into one optional-field object and the `_tag` checks below stop narrowing.
  const asRequested = (value: RequestedProject): RequestedProject => value;

  const resolveRequestedProject = Effect.fn("AdeFleetProvisioning.resolveRequestedProject")(
    function* (requested: string | null | undefined) {
      if (requested === undefined) return asRequested({ _tag: "unstated" });
      if (requested === null) return asRequested({ _tag: "fleet-shared" });
      const byId = yield* readProjectById(requested);
      if (byId !== null) {
        return asRequested({ _tag: "project", projectId: byId.project_id, name: byId.name });
      }
      const byName = yield* readProjectsByName(requested);
      if (byName.length === 0) {
        return asRequested({
          _tag: "refused",
          reason: `no project '${requested}' exists — it matched no project id and no project name`,
        });
      }
      if (byName.length > 1) {
        return asRequested({
          _tag: "refused",
          reason: `'${requested}' matches ${byName.length} projects by name (${byName
            .map((row) => `'${row.project_id}'`)
            .join(", ")}); name the project by id instead`,
        });
      }
      const only = byName[0]!;
      return asRequested({ _tag: "project", projectId: only.project_id, name: only.name });
    },
  );

  const resolve: AdeFleetProvisioning["resolve"] = Effect.fn("AdeFleetProvisioning.resolve")(
    function* (input: { callerBotId: BotId; request: AdeCreateBotToolInput }) {
      const caller = yield* readCaller(input.callerBotId);
      if (caller === null) return refused("the calling bot no longer exists");
      if (caller.archived_at !== null) return refused("the calling bot is archived");
      if (caller.structural_role !== "firstmate" && caller.structural_role !== "second-mate") {
        return refused(
          "only coordinators create bots — the Firstmate for the fleet, a Second Mate for its own project",
        );
      }

      const requestedName = input.request.name?.trim();
      if (requestedName !== undefined && isReservedBotName(requestedName)) {
        return refused(
          `'${requestedName}' is a reserved coordinator name; the Firstmate and each project's Second Mate are the only bots that carry it`,
        );
      }

      // Resolved before the role check so a Second Mate may name its own
      // project by name, not just by id.
      const requested = yield* resolveRequestedProject(input.request.projectId);
      if (requested._tag === "refused") return refused(requested.reason);

      let targetProjectId: string | null;
      let projectName: string | null;
      if (caller.structural_role === "firstmate") {
        // Unstated means "where I live", which for the fleet-wide coordinator
        // is nowhere in particular — a fleet-shared specialist.
        if (requested._tag === "project") {
          targetProjectId = requested.projectId;
          projectName = requested.name;
        } else if (requested._tag === "fleet-shared") {
          targetProjectId = null;
          projectName = null;
        } else {
          targetProjectId = caller.project_id;
          projectName =
            caller.project_id === null
              ? null
              : ((yield* readProjectById(caller.project_id))?.name ?? null);
        }
      } else {
        if (caller.project_id === null) {
          return refused("the calling Second Mate has no project to create bots in");
        }
        if (requested._tag === "fleet-shared") {
          return refused(
            "a Second Mate may only create bots in its own project; fleet-shared specialists are the Firstmate's to create",
          );
        }
        if (requested._tag === "project" && requested.projectId !== caller.project_id) {
          return refused(
            `a Second Mate may only create bots in its own project ('${caller.project_id}')`,
          );
        }
        targetProjectId = caller.project_id;
        projectName =
          requested._tag === "project"
            ? requested.name
            : ((yield* readProjectById(caller.project_id))?.name ?? null);
      }

      const fleetCount = yield* countBots(null);
      if (fleetCount >= ADE_MAX_FLEET_BOTS) {
        return refused(fleetCapRefusal(fleetCount));
      }
      if (targetProjectId !== null) {
        const projectCount = yield* countBots(targetProjectId);
        if (projectCount >= ADE_MAX_BOTS_PER_PROJECT) {
          return refused(projectCapRefusal(projectName ?? targetProjectId, projectCount));
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
  /**
   * Stated through `layerPartial` so this slice names only the field it owns
   * and inherits routing/ownership from whatever check layer is underneath.
   */
  static readonly layer: Layer.Layer<
    AdeToolInlineChecks,
    never,
    AdeToolInlineChecks | SqlClient.SqlClient
  > = Layer.unwrap(
    Effect.gen(function* () {
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

      return AdeToolInlineChecks.layerPartial({ isBotProvisioningAllowed });
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

      /**
       * The model-visible payload goes out through the contract, not a
       * hand-built object literal: the schema is the only place the shape is
       * stated, so a field renamed in `@shuv2code/contracts` cannot silently
       * keep shipping under its old name from here.
       */
      const encodeResult = Schema.encodeEffect(Schema.fromJsonString(AdeCreatedBotToolResult));
      const encodeCreatedBot = (result: AdeCreatedBotToolResult) =>
        encodeResult(result).pipe(
          Effect.mapError(
            (cause) => new AdeToolExecutionError({ tool: TOOL, detail: cause.message }),
          ),
        );

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
          const requestedName = input.name ?? template.defaultName;
          // Derived from the *request*, so a replay after a restart (or a
          // voice mutation recovered as `indeterminate`) resolves to the bot
          // the first call created instead of minting "Coder 2".
          const idempotencyKey = deriveProvisionIdempotencyKey({
            callerBotId: ctx.botId,
            templateId: input.templateId,
            requestedName,
            projectId: resolution.projectId,
          });
          const name = yield* provisioning.resolveName(requestedName);
          const created = yield* bootstrap
            .instantiateTemplate({
              templateId: input.templateId,
              projectId: resolution.projectId,
              name,
              createdByBotId: ctx.botId,
              provisionIdempotencyKey: idempotencyKey,
              caps: {
                maxFleetBots: ADE_MAX_FLEET_BOTS,
                maxBotsPerProject: ADE_MAX_BOTS_PER_PROJECT,
              },
            })
            .pipe(
              // The transaction is the authority on the caps; the inline check
              // is only a fast pre-flight. Same sentence either way.
              Effect.catchTag("AdeBotCapExceededError", (error) =>
                Effect.fail(
                  new AdeToolExecutionError({
                    tool: TOOL,
                    detail:
                      error.scope === "fleet"
                        ? fleetCapRefusal(error.count)
                        : projectCapRefusal(
                            resolution.projectName ?? String(resolution.projectId),
                            error.count,
                          ),
                  }),
                ),
              ),
            );
          const where =
            resolution.projectName === null
              ? "as a fleet-shared specialist"
              : `in project '${resolution.projectName}'`;
          const summary = created.created
            ? `Created ${created.name} (${created.roleTag}) ${where}. Assign work to it with create_assignment using botId '${created.botId}'.`
            : `${created.name} (${created.roleTag}) already exists ${where} from an identical earlier request; no second bot was created. Assign work to it with create_assignment using botId '${created.botId}'.`;
          return yield* encodeCreatedBot({
            botId: created.botId,
            name: created.name,
            roleTag: created.roleTag,
            projectId: created.projectId,
            summary,
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
