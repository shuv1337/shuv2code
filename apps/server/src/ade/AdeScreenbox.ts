// @effect-diagnostics nodeBuiltinImport:off
/**
 * ADE Screenbox runtime (spec `docs/ade/ADE-V1-SPEC.md` §4.6; issues #168,
 * #139, #132).
 *
 * One service owns everything ADE does with desktops, because all of it keys
 * on the same durable botId-keyed provisioning record:
 *
 * - **Tool plane.** The operate-only `desktop_*` subset rides the dynamic-tool
 *   surface through the S6 `AdeScreenboxToolPlane` seam. Schemas come from
 *   upstream `tools/list` at boot, filtered to {@link SCREENBOX_OPERATE_TOOLS}
 *   and cached last-good. ADE forwards invocations itself holding the single
 *   admin token — no Screenbox credential ever enters a session config.
 * - **Scoping.** `desktop_id = botId`, always injected by ADE and never taken
 *   from model input: any caller-supplied desktop key is stripped before the
 *   forward, so bot A structurally cannot reach bot B's desktop.
 * - **Provisioning.** The first eligible tool call provisions synchronously
 *   against the durable record (idempotent per botId, concurrent calls
 *   collapse on a per-bot mutex). Failure marks the record `failed` and raises
 *   a Needs You `provision-failure` item (database-backed once-per-bot dedupe,
 *   the S17 pattern); the next call retries and resolves it on success.
 * - **Cap.** `LimitsConfig.maxConcurrentScreenboxDesktops` (default 4) counts
 *   *other* bots whose record is `running`/`provisioning`. At the cap ADE
 *   refuses with an error naming the occupants — no queue in V1; idle-stop
 *   frees slots naturally (spec §4.6), which is why a `stopped` record does
 *   not occupy one.
 * - **Idle policy.** Every forward touches `last_needed_at`; attached viewers
 *   (S15) keep touching it while present, so viewer presence feeds the policy
 *   directly. The sweep stops desktops idle past
 *   `LimitsConfig.screenboxIdleStopMinutes`, and the next forward starts them
 *   again transparently. The sweep also reconciles records against upstream's
 *   desktop list, which is the same reconcile that runs at boot (spec §16.4).
 *
 * Upstream runs unmodified with its own policy loops off; see
 * `AdeScreenboxClient.ts` for the deployment contract.
 */
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import {
  LimitsConfig,
  NeedsYouSubjectRef,
  type BotId,
  type ScreenboxProvisioningStatus,
} from "@shuv2code/contracts";

import { forkParked } from "../serverActivation.ts";
import { AdeHealthChecker, type AdeHealthProbeResult } from "./AdeHealthChecker.ts";
import {
  AdeScreenboxClient,
  type AdeScreenboxClientShape,
  boundScreenboxDetail,
  describeUnhealthy,
  type AdeScreenboxDesktop,
} from "./AdeScreenboxClient.ts";
import {
  AdeScreenboxToolPlane,
  type AdeScreenboxToolPlaneShape,
  type AdeToolCallContext,
  type AdeToolDefinition,
  type AdeToolHandlerError,
  AdeToolExecutionError,
  ADE_SCREENBOX_TOOL_PREFIX,
} from "./AdeToolGate.ts";

// ---------------------------------------------------------------------------
// Operate-only subset (spec §4.6)
// ---------------------------------------------------------------------------

/**
 * The only upstream tools a bot may ever reach. Lifecycle (`desktop_manage`),
 * knowledge, logs, and debug tools are ADE's alone and are never registered on
 * a session catalog. Everything here carries the `desktop_` prefix the S6 gate
 * reserves for this plane, and none matches the gate's approval-name denylist.
 */
export const SCREENBOX_OPERATE_TOOLS: ReadonlyArray<string> = [
  "desktop_screenshot",
  "desktop_look",
  "desktop_click",
  "desktop_type",
  "desktop_key",
  "desktop_shell",
  "desktop_batch",
  "desktop_chrome",
  "desktop_window",
  "desktop_file",
  "desktop_help",
];

const OPERATE_TOOL_SET: ReadonlySet<string> = new Set(SCREENBOX_OPERATE_TOOLS);

/**
 * Argument sanitizing is **allowlist-first, denylist-second, recursive**
 * (adversarial review of #183). A flat denylist over top-level keys is not a
 * scoping mechanism: `desktopID`, `target_desktop`, and — for `desktop_batch`,
 * whose whole shape is nested sub-invocations — `{actions: [{desktop_id: …}]}`
 * would all walk straight past it.
 *
 * So: keys are kept only if the tool's cached upstream `inputSchema` declares
 * them (when it declares any), anything that *looks* like a desktop/agent
 * target is dropped at every depth, and ADE injects `desktop_id` last at the
 * top level only.
 */
const MAX_ARGUMENT_DEPTH = 8;
const MAX_ARRAY_ITEMS = 256;

/** Case/separator-insensitive normalization: `target-Desktop ID` → `targetdesktopid`. */
const normalizeKey = (key: string): string => key.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * True for any key that could name a desktop, container, or upstream agent
 * identity. Substring matching on purpose: the cost of dropping an unrelated
 * key containing "desktop" is a tool argument the bot can re-express, while the
 * cost of missing one is cross-bot desktop access.
 */
export const isDesktopTargetingKey = (key: string): boolean => {
  const normalized = normalizeKey(key);
  return (
    normalized.includes("desktop") ||
    normalized.includes("container") ||
    normalized === "agent" ||
    normalized.includes("agentid") ||
    normalized.includes("sessiontoken") ||
    normalized.includes("apikey")
  );
};

/** Recursively drop desktop-targeting keys from any nested structure. */
const stripDesktopTargets = (value: unknown, depth: number): unknown => {
  if (depth > MAX_ARGUMENT_DEPTH) return null;
  if (Array.isArray(value)) {
    return value.slice(0, MAX_ARRAY_ITEMS).map((entry) => stripDesktopTargets(entry, depth + 1));
  }
  if (typeof value !== "object" || value === null) return value;
  const cleaned: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (isDesktopTargetingKey(key)) continue;
    cleaned[key] = stripDesktopTargets(entry, depth + 1);
  }
  return cleaned;
};

/**
 * Top-level property names upstream declares for a tool, or `null` when the
 * schema declares none (then only the recursive denylist applies).
 */
export const allowedArgumentKeys = (
  parameters: Readonly<Record<string, unknown>>,
): ReadonlySet<string> | null => {
  const properties = parameters["properties"];
  if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
    return null;
  }
  const keys = Object.keys(properties as Record<string, unknown>).filter(
    (key) => !isDesktopTargetingKey(key),
  );
  return keys.length === 0 ? null : new Set(keys);
};

/**
 * The whole of bot→desktop scoping. Model input is data, never authority.
 */
export const scopeToolArguments = (input: {
  readonly desktopId: string;
  readonly arguments: unknown;
  readonly allowedKeys: ReadonlySet<string> | null;
}): Readonly<Record<string, unknown>> => {
  const record =
    typeof input.arguments === "object" &&
    input.arguments !== null &&
    !Array.isArray(input.arguments)
      ? (input.arguments as Record<string, unknown>)
      : {};
  const scoped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (isDesktopTargetingKey(key)) continue;
    if (input.allowedKeys !== null && !input.allowedKeys.has(key)) continue;
    scoped[key] = stripDesktopTargets(value, 1);
  }
  // Injected last so nothing above can shadow it.
  scoped["desktop_id"] = input.desktopId;
  return scoped;
};

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export const AdeScreenboxProvisionFailureKind = Schema.Literals([
  "not-configured",
  "not-eligible",
  "cap-reached",
  "upstream",
  /** ADE-side bookkeeping failed (e.g. the slot reservation write). */
  "internal",
]);
export type AdeScreenboxProvisionFailureKind = typeof AdeScreenboxProvisionFailureKind.Type;

/** A desktop could not be made ready for `botId`; `reason` is model-visible. */
export class AdeScreenboxProvisionError extends Schema.TaggedErrorClass<AdeScreenboxProvisionError>()(
  "AdeScreenboxProvisionError",
  {
    botId: Schema.String,
    kind: AdeScreenboxProvisionFailureKind,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

// ---------------------------------------------------------------------------
// Service shape
// ---------------------------------------------------------------------------

/** Where the WS→VNC proxy should dial for a bot's desktop. Loopback only. */
export interface AdeScreenboxViewerTarget {
  readonly host: string;
  readonly port: number;
}

export interface AdeScreenboxDesktopStatus {
  readonly botId: BotId;
  readonly status: ScreenboxProvisioningStatus | "none";
  readonly lastNeededAt: string | null;
  readonly viewers: number;
}

export interface AdeScreenboxRuntimeShape {
  // -- tool plane ------------------------------------------------------------
  /** Cached last-good operate-only catalog (empty until the first refresh). */
  readonly toolCatalog: Effect.Effect<ReadonlyArray<AdeToolDefinition>>;
  /** Fetch + filter + cache upstream `tools/list`; never fails (keeps last good). */
  readonly refreshToolCatalog: Effect.Effect<ReadonlyArray<AdeToolDefinition>>;
  /** Per-bot computer-use toggle (spec §4.6, default off). */
  readonly isComputerUseEnabled: (botId: BotId) => Effect.Effect<boolean>;
  /** Forward one already-gated invocation; injects `desktop_id = botId`. */
  readonly forwardToolCall: (
    ctx: AdeToolCallContext,
    input: unknown,
  ) => Effect.Effect<string, AdeToolHandlerError>;

  // -- lifecycle -------------------------------------------------------------
  /** Idempotent synchronous provisioning + transparent restart-on-need. */
  readonly ensureDesktopReady: (botId: BotId) => Effect.Effect<void, AdeScreenboxProvisionError>;
  /** Captain Start (S15 Screen tab); same path as a tool-forward provision. */
  readonly startDesktopFor: (botId: BotId) => Effect.Effect<void, AdeScreenboxProvisionError>;
  /** Captain Stop (S15 Screen tab); volume persists. */
  readonly stopDesktopFor: (botId: BotId) => Effect.Effect<void, AdeScreenboxProvisionError>;
  /** Bot delete (S15): destroy without snapshot + purge data + drop the record. */
  readonly destroyDesktopFor: (botId: BotId) => Effect.Effect<void, AdeScreenboxProvisionError>;
  readonly statusFor: (botId: BotId) => Effect.Effect<AdeScreenboxDesktopStatus>;
  /**
   * Loopback RFB endpoint for this bot's desktop, for the WS→VNC proxy (§4.6).
   *
   * Deliberately **read-only**: it never provisions and never starts. Viewing
   * must not spawn a desktop, so a bot with no record — or with a stopped one —
   * is a refusal here, not an implicit `startDesktopFor`.
   */
  readonly viewerTargetFor: (
    botId: BotId,
  ) => Effect.Effect<AdeScreenboxViewerTarget, AdeScreenboxProvisionError>;

  // -- idle policy -----------------------------------------------------------
  /** Viewer attached (S15 WS→VNC proxy); presence keeps the desktop alive. */
  readonly viewerAttached: (botId: BotId) => Effect.Effect<void>;
  readonly viewerDetached: (botId: BotId) => Effect.Effect<void>;
  /** One idle pass: reconcile drift, refresh viewer-held desktops, stop the idle ones. */
  readonly sweepIdleDesktops: Effect.Effect<void>;
  /** Boot reconcile of provisioning records against upstream's desktop list. */
  readonly reconcileWithUpstream: Effect.Effect<void>;

  // -- health ----------------------------------------------------------------
  readonly probe: Effect.Effect<AdeHealthProbeResult>;
}

interface ProvisioningRow {
  readonly bot_id: string;
  readonly status: string;
  readonly last_needed_at: string | null;
}

export const DEFAULT_IDLE_SWEEP_INTERVAL = Duration.minutes(1);

const desktopIdFor = (botId: BotId): string => botId;
const containerRefFor = (botId: BotId): string => `screenbox-${botId}`;
const volumeRefFor = (botId: BotId): string => `screenbox-${botId}-home`;

const millisOf = (iso: string | null): number | null => {
  if (iso === null) return null;
  const parsed = Date.parse(iso);
  return Number.isNaN(parsed) ? null : parsed;
};

export class AdeScreenboxRuntime extends Context.Service<
  AdeScreenboxRuntime,
  AdeScreenboxRuntimeShape
>()("shuv2code/ade/AdeScreenbox/AdeScreenboxRuntime") {
  static readonly layer: Layer.Layer<
    AdeScreenboxRuntime,
    never,
    SqlClient.SqlClient | AdeScreenboxClient
  > = Layer.effect(
    AdeScreenboxRuntime,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const client = yield* AdeScreenboxClient;
      return yield* makeAdeScreenboxRuntime(sql, client);
    }),
  );

  /**
   * Boot work, parked until server activation. One loop: each sweep primes the
   * tool catalog, reconciles records against upstream, and stops idle desktops
   * — so the first tick is the boot pass and a Screenbox that was down at boot
   * recovers on a later tick without a server restart.
   */
  static readonly bootLive = (
    interval: Duration.Duration = DEFAULT_IDLE_SWEEP_INTERVAL,
  ): Layer.Layer<never, never, AdeScreenboxRuntime> =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const runtime = yield* AdeScreenboxRuntime;
        yield* forkParked(
          runtime.sweepIdleDesktops.pipe(
            Effect.repeat(Schedule.spaced(interval)),
            Effect.catchDefect((defect) =>
              Effect.logWarning("ADE Screenbox boot loop defect", { defect }),
            ),
          ),
        );
      }),
    );
}

/**
 * The S6 tool-plane seam, backed by the real runtime — the layer that must be
 * provided instead of `AdeScreenboxToolPlane.layerNotEligible`.
 *
 * NOTE for S9 (#163): `AdeToolGate` is **not yet wired into `server.ts`** — S6
 * landed the gate and this slice landed the plane, but the walking-skeleton
 * ticket is what actually constructs the gate for live sessions. S9 must
 * provide BOTH `AdeToolGate.layer` and this layer (plus the S7 handlers and
 * inline checks); wiring the gate with the default `layerNotEligible` would
 * silently ship a Screenbox-less tool plane.
 */
export const AdeScreenboxToolPlaneLive: Layer.Layer<
  AdeScreenboxToolPlane,
  never,
  AdeScreenboxRuntime
> = Layer.effect(
  AdeScreenboxToolPlane,
  Effect.gen(function* () {
    const runtime = yield* AdeScreenboxRuntime;
    return {
      toolsFor: (principal) =>
        Effect.gen(function* () {
          const enabled = yield* runtime.isComputerUseEnabled(principal.botId);
          if (!enabled) return [];
          return yield* runtime.toolCatalog;
        }),
      eligibility: (ctx) =>
        Effect.gen(function* () {
          const enabled = yield* runtime.isComputerUseEnabled(ctx.botId);
          return enabled
            ? ({ eligible: true } as const)
            : ({
                eligible: false,
                reason: "computer use is disabled for this bot",
              } as const);
        }),
      forward: (ctx, input) => runtime.forwardToolCall(ctx, input),
    } satisfies AdeScreenboxToolPlaneShape;
  }),
);

/**
 * The S17 probe seam wired to the live runtime: same shuvcode/Codex probes,
 * real Screenbox probe instead of the shipped dormant one.
 */
export const AdeScreenboxHealthProbesLive = AdeHealthChecker.probesLiveWith(
  Effect.flatMap(Effect.service(AdeScreenboxRuntime), (runtime) => runtime.probe),
);

export const makeAdeScreenboxRuntime = (
  sql: SqlClient.SqlClient,
  client: AdeScreenboxClientShape,
): Effect.Effect<AdeScreenboxRuntimeShape> =>
  Effect.gen(function* () {
    const catalogRef = yield* Ref.make<ReadonlyArray<AdeToolDefinition>>([]);
    const viewers = new Map<string, number>();
    const botMutexes = new Map<string, Semaphore.Semaphore>();

    const mutexFor = (botId: BotId): Semaphore.Semaphore => {
      const existing = botMutexes.get(botId);
      if (existing !== undefined) return existing;
      const created = Semaphore.makeUnsafe(1);
      botMutexes.set(botId, created);
      return created;
    };

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

    /**
     * Database failures are infrastructure, not policy: they must never crash a
     * tool dispatch. Every read here degrades to a safe fail-closed default.
     */
    const orLogAndSucceed = <A, E>(effect: Effect.Effect<A, E>, note: string, fallback: A) =>
      effect.pipe(
        Effect.catch((error) => Effect.logWarning(note, { error }).pipe(Effect.as(fallback))),
        Effect.catchDefect((defect) =>
          Effect.logWarning(note, { defect }).pipe(Effect.as(fallback)),
        ),
      );

    // -- limits --------------------------------------------------------------

    const decodeLimits = Schema.decodeUnknownEffect(LimitsConfig);
    const decodeLimitsJson = Schema.decodeUnknownEffect(Schema.fromJsonString(LimitsConfig));
    // Decoding `{}` yields the ADR §18.1 seed values; used when the singleton
    // row is missing or unreadable so policy never stalls on a bad read.
    const defaultLimits = yield* decodeLimits({}).pipe(Effect.orDie);

    const readLimits = orLogAndSucceed(
      Effect.gen(function* () {
        const rows = yield* sql<{ config_json: string }>`
          SELECT config_json FROM ade_limits_config WHERE id = 1
        `;
        const raw = rows[0]?.config_json;
        if (raw === undefined) return defaultLimits;
        return yield* decodeLimitsJson(raw);
      }),
      "ADE Screenbox could not read LimitsConfig; using defaults",
      defaultLimits,
    );

    // -- records -------------------------------------------------------------

    const readRow = (botId: BotId) =>
      orLogAndSucceed(
        Effect.map(
          sql<ProvisioningRow>`
            SELECT bot_id, status, last_needed_at FROM ade_screenbox_provisionings
            WHERE bot_id = ${botId}
          `,
          (rows) => rows[0] ?? null,
        ),
        "ADE Screenbox could not read a provisioning record",
        null,
      );

    const setStatus = (botId: BotId, status: ScreenboxProvisioningStatus, at: string) =>
      orLogAndSucceed(
        sql`
          UPDATE ade_screenbox_provisionings
          SET status = ${status}, last_needed_at = ${at}
          WHERE bot_id = ${botId}
        `,
        "ADE Screenbox could not update a provisioning record",
        undefined,
      ).pipe(Effect.asVoid);

    const touch = (botId: BotId, at: string) =>
      orLogAndSucceed(
        sql`
          UPDATE ade_screenbox_provisionings SET last_needed_at = ${at} WHERE bot_id = ${botId}
        `,
        "ADE Screenbox could not touch a provisioning record",
        undefined,
      ).pipe(Effect.asVoid);

    const insertProvisioning = (botId: BotId, at: string) =>
      sql`
        INSERT INTO ade_screenbox_provisionings (
          bot_id, status, container_ref, volume_ref, created_at, last_needed_at
        ) VALUES (
          ${botId}, 'provisioning', ${containerRefFor(botId)}, ${volumeRefFor(botId)}, ${at}, ${at}
        )
        ON CONFLICT (bot_id) DO UPDATE SET status = 'provisioning', last_needed_at = ${at}
      `;

    // -- Needs You (provision-failure) ---------------------------------------

    const SubjectRefsJson = Schema.fromJsonString(Schema.Array(NeedsYouSubjectRef));
    const decodeSubjectRefs = Schema.decodeUnknownEffect(SubjectRefsJson);
    const encodeSubjectRefs = Schema.encodeEffect(SubjectRefsJson);

    /** Does this item's subject list name `botId`? Undecodable rows say no. */
    const subjectRefsNameBot = (subjectRefsJson: string, botId: BotId) =>
      decodeSubjectRefs(subjectRefsJson).pipe(
        Effect.map((refs) => refs.some((ref) => ref._tag === "bot" && ref.botId === botId)),
        Effect.orElseSucceed(() => false),
      );

    /** Database-backed once-per-outage dedupe, mirroring S17's kernel-down item. */
    const raiseProvisionFailureItem = (botId: BotId, at: string) =>
      orLogAndSucceed(
        sql.withTransaction(
          Effect.gen(function* () {
            const open = yield* sql<{ subject_refs_json: string }>`
              SELECT subject_refs_json FROM ade_needs_you_items
              WHERE kind = 'provision-failure' AND status = 'open'
            `;
            for (const row of open) {
              if (yield* subjectRefsNameBot(row.subject_refs_json, botId)) return;
            }
            const id = NodeCrypto.randomUUID();
            const subjectRefs = yield* encodeSubjectRefs([{ _tag: "bot", botId }]);
            yield* sql`
              INSERT INTO ade_needs_you_items (
                needs_you_item_id, kind, subject_refs_json, status,
                created_at, updated_at, resolved_at
              ) VALUES (${id}, 'provision-failure', ${subjectRefs}, 'open', ${at}, ${at}, NULL)
            `;
          }),
        ),
        "ADE Screenbox could not raise a provision-failure Needs You item",
        undefined,
      ).pipe(Effect.asVoid);

    const resolveProvisionFailureItems = (botId: BotId, at: string) =>
      orLogAndSucceed(
        sql.withTransaction(
          Effect.gen(function* () {
            const open = yield* sql<{
              needs_you_item_id: string;
              subject_refs_json: string;
            }>`
              SELECT needs_you_item_id, subject_refs_json FROM ade_needs_you_items
              WHERE kind = 'provision-failure' AND status = 'open'
            `;
            for (const row of open) {
              if (!(yield* subjectRefsNameBot(row.subject_refs_json, botId))) continue;
              yield* sql`
                UPDATE ade_needs_you_items
                SET status = 'resolved', resolved_at = ${at}, updated_at = ${at}
                WHERE needs_you_item_id = ${row.needs_you_item_id}
              `;
            }
          }),
        ),
        "ADE Screenbox could not resolve provision-failure Needs You items",
        undefined,
      ).pipe(Effect.asVoid);

    // -- cap -----------------------------------------------------------------

    /**
     * Occupants are the *other* bots holding an active desktop
     * (`running`/`provisioning`). A `stopped` record keeps its volume but frees
     * the slot — that is what makes idle-stop a cap-relief mechanism (§4.6).
     */
    const capRefusal = (
      botId: BotId,
      limit: number,
      occupants: ReadonlyArray<{ bot_id: string; name: string | null }>,
    ) => {
      const named = occupants
        .map((row) => (row.name === null ? row.bot_id : `${row.name} (${row.bot_id})`))
        .join(", ");
      return new AdeScreenboxProvisionError({
        botId,
        kind: "cap-reached",
        reason:
          `Screenbox desktop cap reached (${limit} concurrent desktops). ` +
          `Currently occupied by: ${named.length === 0 ? "unknown" : named}. ` +
          "Stop one of those desktops (or wait for its idle-stop) and try again.",
      });
    };

    /**
     * Cap check and slot claim in ONE transaction (adversarial review of #183).
     * The per-bot mutex serializes a single bot's first calls but does nothing
     * about N different bots racing at the cap boundary — counting outside the
     * write let `limit + N - 1` desktops through. SQLite's single writer makes
     * the transaction sufficient both in-process and across processes.
     */
    const claimDesktopSlot = (botId: BotId, at: string, limit: number) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const occupants = yield* sql<{ bot_id: string; name: string | null }>`
            SELECT p.bot_id AS bot_id, b.name AS name
            FROM ade_screenbox_provisionings p
            LEFT JOIN ade_bots b ON b.bot_id = p.bot_id
            WHERE p.status IN ('running', 'provisioning') AND p.bot_id <> ${botId}
            ORDER BY p.bot_id
          `;
          if (occupants.length >= limit) {
            return { claimed: false as const, occupants };
          }
          yield* insertProvisioning(botId, at);
          return { claimed: true as const, occupants };
        }),
      );

    // -- upstream lifecycle --------------------------------------------------

    const failUpstream = (botId: BotId, at: string, detail: string) =>
      setStatus(botId, "failed", at).pipe(
        Effect.andThen(raiseProvisionFailureItem(botId, at)),
        Effect.andThen(
          Effect.fail(
            new AdeScreenboxProvisionError({
              botId,
              kind: "upstream",
              reason: `Screenbox could not provide a desktop for this bot: ${boundScreenboxDetail(detail)}`,
            }),
          ),
        ),
      );

    /**
     * Bring the upstream desktop up. `start` is tried first (the idle-stop
     * round trip), falling back to `create` — which upstream treats as
     * re-entrant for a running desktop and as recreate for a removed one. That
     * fallback is what makes a record whose container vanished self-heal.
     */
    const bringUp = (botId: BotId, fromStopped: boolean) => {
      const desktopId = desktopIdFor(botId);
      const create = client.createDesktop(desktopId);
      return fromStopped
        ? client.controlDesktop(desktopId, "start").pipe(
            Effect.catch((error) =>
              Effect.logWarning("ADE Screenbox start failed; recreating desktop", {
                botId,
                error: error.message,
              }).pipe(Effect.andThen(create)),
            ),
          )
        : create;
    };

    const ensureDesktopReadyUnsynchronized = Effect.fn("AdeScreenbox.ensureDesktopReady")(
      function* (botId: BotId) {
        if (!client.isConfigured) {
          return yield* new AdeScreenboxProvisionError({
            botId,
            kind: "not-configured",
            reason: "Screenbox is not configured on this host.",
          });
        }
        const at = yield* nowIso;
        const row = yield* readRow(botId);
        if (row !== null && row.status === "running") {
          // Already ours and up: the only work is the idle-policy touch.
          yield* touch(botId, at);
          return;
        }
        const limits = yield* readLimits;
        const claim = yield* claimDesktopSlot(
          botId,
          at,
          limits.maxConcurrentScreenboxDesktops,
        ).pipe(Effect.result);
        if (claim._tag === "Failure") {
          // The reservation write itself failed: refuse rather than provision
          // an unrecorded desktop that nothing would ever stop or delete.
          yield* Effect.logWarning("ADE Screenbox could not claim a desktop slot", {
            botId,
            error: claim.failure,
          });
          return yield* new AdeScreenboxProvisionError({
            botId,
            kind: "internal",
            reason: "ADE could not record a desktop reservation for this bot.",
          });
        }
        if (!claim.success.claimed) {
          return yield* capRefusal(
            botId,
            limits.maxConcurrentScreenboxDesktops,
            claim.success.occupants,
          );
        }
        const outcome = yield* bringUp(botId, row?.status === "stopped").pipe(Effect.result);
        if (outcome._tag === "Failure") {
          return yield* failUpstream(botId, at, outcome.failure.message);
        }
        yield* setStatus(botId, "running", at);
        yield* resolveProvisionFailureItems(botId, at);
      },
    );

    /**
     * Per-bot serialization: two concurrent first tool calls must produce one
     * desktop, not a `docker create` name race (audit gap 1). Cross-process
     * dedupe is the record's `bot_id` primary key.
     */
    const ensureDesktopReady: AdeScreenboxRuntimeShape["ensureDesktopReady"] = (botId) =>
      Effect.suspend(() => mutexFor(botId).withPermits(1)(ensureDesktopReadyUnsynchronized(botId)));

    const stopDesktopFor: AdeScreenboxRuntimeShape["stopDesktopFor"] = (botId) =>
      Effect.suspend(() =>
        mutexFor(botId).withPermits(1)(
          Effect.gen(function* () {
            const at = yield* nowIso;
            const row = yield* readRow(botId);
            if (row === null || row.status === "stopped") return;
            const outcome = yield* client
              .controlDesktop(desktopIdFor(botId), "stop")
              .pipe(Effect.result);
            if (outcome._tag === "Failure") {
              return yield* new AdeScreenboxProvisionError({
                botId,
                kind: "upstream",
                reason: `Screenbox could not stop this bot's desktop: ${boundScreenboxDetail(outcome.failure.message)}`,
              });
            }
            yield* setStatus(botId, "stopped", at);
          }),
        ),
      );

    const destroyDesktopFor: AdeScreenboxRuntimeShape["destroyDesktopFor"] = (botId) =>
      Effect.suspend(() =>
        mutexFor(botId).withPermits(1)(
          Effect.gen(function* () {
            const desktopId = desktopIdFor(botId);
            // Confirm-gated delete asks upstream to purge all three stores
            // (§4.6): container (no snapshot), dossier, and home volume.
            //
            // Upstream defect, accommodated rather than worked around: the
            // home volume removal fails silently (its docker-proxy whitelist
            // has no `DELETE /volumes` route) yet delete-data still reports
            // `{"deleted": true}`. ADE makes no docker calls and does not
            // retry; it logs the operator's one-liner so a purge that left
            // data behind is at least visible in the server log.
            const outcome = yield* client
              .destroyDesktop(desktopId)
              .pipe(Effect.andThen(client.deleteDesktopData(desktopId)), Effect.result);
            if (outcome._tag === "Success") {
              yield* Effect.logWarning(
                "ADE Screenbox deleted a desktop; upstream may have left its home volume behind",
                {
                  botId,
                  desktopId,
                  operatorWorkaround: `docker volume rm -f screenbox-${desktopId}-home`,
                },
              );
            }
            yield* orLogAndSucceed(
              sql`DELETE FROM ade_screenbox_provisionings WHERE bot_id = ${botId}`,
              "ADE Screenbox could not delete a provisioning record",
              undefined,
            );
            viewers.delete(botId);
            if (outcome._tag === "Failure") {
              return yield* new AdeScreenboxProvisionError({
                botId,
                kind: "upstream",
                reason: `Screenbox could not fully delete this bot's desktop: ${boundScreenboxDetail(outcome.failure.message)}`,
              });
            }
          }),
        ),
      );

    // -- tool plane ----------------------------------------------------------

    const refreshToolCatalog: AdeScreenboxRuntimeShape["refreshToolCatalog"] = Effect.gen(
      function* () {
        if (!client.isConfigured) return yield* Ref.get(catalogRef);
        const outcome = yield* client.listTools.pipe(Effect.result);
        if (outcome._tag === "Failure") {
          // Last-good cache is the fallback while Screenbox is down (§4.6).
          yield* Effect.logWarning("ADE Screenbox tools/list failed; keeping cached catalog", {
            error: outcome.failure.message,
          });
          return yield* Ref.get(catalogRef);
        }
        const filtered = outcome.success
          .filter(
            (tool) =>
              tool.name.startsWith(ADE_SCREENBOX_TOOL_PREFIX) && OPERATE_TOOL_SET.has(tool.name),
          )
          .map(
            (tool): AdeToolDefinition => ({
              name: tool.name,
              description: tool.description,
              parameters: tool.parameters,
            }),
          );
        if (filtered.length === 0) {
          yield* Effect.logWarning(
            "ADE Screenbox tools/list returned no operate-subset tools; keeping cached catalog",
          );
          return yield* Ref.get(catalogRef);
        }
        yield* Ref.set(catalogRef, filtered);
        return filtered;
      },
    ).pipe(
      Effect.catchDefect((defect) =>
        Effect.logWarning("ADE Screenbox catalog refresh defect", { defect }).pipe(
          Effect.andThen(Ref.get(catalogRef)),
        ),
      ),
    );

    const isComputerUseEnabled: AdeScreenboxRuntimeShape["isComputerUseEnabled"] = (botId) =>
      client.isConfigured
        ? orLogAndSucceed(
            Effect.map(
              sql<{ computer_use: number }>`
                SELECT computer_use FROM ade_bots
                WHERE bot_id = ${botId} AND archived_at IS NULL
              `,
              (rows) => (rows[0]?.computer_use ?? 0) === 1,
            ),
            "ADE Screenbox could not read the computer-use toggle",
            false,
          )
        : Effect.succeed(false);

    /**
     * The argument allowlist for one tool, taken from the cached upstream
     * schema. Unknown tool (empty cache) → no allowlist, denylist only.
     */
    const allowedKeysFor = (tool: string) =>
      Effect.map(Ref.get(catalogRef), (catalog) => {
        const definition = catalog.find((entry) => entry.name === tool);
        return definition === undefined ? null : allowedArgumentKeys(definition.parameters);
      });

    /** Upstream's way of saying "the container isn't up" (state drift). */
    const looksLikeDesktopNotRunning = (detail: string): boolean =>
      /not\s+running|is\s+stopped|no\s+such\s+(container|desktop)|unknown\s+desktop|not\s+found/i.test(
        detail,
      );

    const forwardToolCall: AdeScreenboxRuntimeShape["forwardToolCall"] = (ctx, input) =>
      Effect.gen(function* () {
        if (!OPERATE_TOOL_SET.has(ctx.tool)) {
          // Defense in depth behind the gate's catalog resolution: lifecycle
          // and knowledge tools are never proxied for a bot.
          return yield* new AdeToolExecutionError({
            tool: ctx.tool,
            detail: "this desktop tool is not part of the operate-only subset",
          });
        }
        yield* ensureDesktopReady(ctx.botId).pipe(
          Effect.mapError(
            (error) => new AdeToolExecutionError({ tool: ctx.tool, detail: error.reason }),
          ),
        );
        const allowedKeys = yield* allowedKeysFor(ctx.tool);
        const outcome = yield* client
          .callTool({
            name: ctx.tool,
            arguments: scopeToolArguments({
              desktopId: desktopIdFor(ctx.botId),
              arguments: input,
              allowedKeys,
            }),
          })
          .pipe(Effect.result);
        if (outcome._tag === "Failure") {
          const detail = boundScreenboxDetail(outcome.failure.message);
          if (looksLikeDesktopNotRunning(detail)) {
            // Record drift: mark the desktop stopped so the NEXT forward
            // revives it through restart-on-need instead of waiting for the
            // sweep. Deliberately no retry of *this* call:
            // `desktop_click`/`type`/`shell` are not idempotent, so a failed
            // forward must surface, not replay.
            const at = yield* nowIso;
            yield* setStatus(ctx.botId, "stopped", at);
          }
          return yield* new AdeToolExecutionError({ tool: ctx.tool, detail });
        }
        return outcome.success;
      });

    // -- idle policy ---------------------------------------------------------

    const viewerAttached: AdeScreenboxRuntimeShape["viewerAttached"] = (botId) =>
      Effect.gen(function* () {
        viewers.set(botId, (viewers.get(botId) ?? 0) + 1);
        const at = yield* nowIso;
        yield* touch(botId, at);
      });

    const viewerDetached: AdeScreenboxRuntimeShape["viewerDetached"] = (botId) =>
      Effect.gen(function* () {
        const next = (viewers.get(botId) ?? 0) - 1;
        if (next <= 0) viewers.delete(botId);
        else viewers.set(botId, next);
        const at = yield* nowIso;
        // Detaching starts the idle clock from now, not from the last forward.
        yield* touch(botId, at);
      });

    const upstreamStateByDesktop = Effect.gen(function* () {
      if (!client.isConfigured) return null;
      const outcome = yield* client.listDesktops.pipe(Effect.result);
      if (outcome._tag === "Failure") {
        yield* Effect.logWarning("ADE Screenbox desktop list failed; skipping reconcile", {
          error: outcome.failure.message,
        });
        return null;
      }
      const map = new Map<string, AdeScreenboxDesktop>();
      for (const desktop of outcome.success) map.set(desktop.desktopId, desktop);
      return map;
    });

    /**
     * Records are ADE's truth about intent; upstream is the truth about
     * containers. Reconcile drops the gap: a desktop that disappeared or was
     * stopped out of band becomes `stopped`, which the next forward revives.
     */
    const reconcileWithUpstream: AdeScreenboxRuntimeShape["reconcileWithUpstream"] = Effect.gen(
      function* () {
        const upstream = yield* upstreamStateByDesktop;
        if (upstream === null) return;
        const rows = yield* orLogAndSucceed(
          sql<ProvisioningRow>`
            SELECT bot_id, status, last_needed_at FROM ade_screenbox_provisionings
          `,
          "ADE Screenbox could not read provisioning records for reconcile",
          [] as ReadonlyArray<ProvisioningRow>,
        );
        const at = yield* nowIso;
        for (const row of rows) {
          const botId = row.bot_id as BotId;
          const desktop = upstream.get(desktopIdFor(botId));
          const observed: ScreenboxProvisioningStatus =
            desktop === undefined
              ? "stopped"
              : desktop.state === "running"
                ? "running"
                : desktop.state === "error"
                  ? "failed"
                  : "stopped";
          if (observed === row.status) continue;
          yield* orLogAndSucceed(
            sql`
              UPDATE ade_screenbox_provisionings SET status = ${observed} WHERE bot_id = ${botId}
            `,
            "ADE Screenbox could not reconcile a provisioning record",
            undefined,
          );
          yield* Effect.log("ADE Screenbox reconciled a provisioning record", {
            botId,
            from: row.status,
            to: observed,
            at,
          });
        }
      },
    ).pipe(
      Effect.catchDefect((defect) =>
        Effect.logWarning("ADE Screenbox reconcile defect", { defect }),
      ),
    );

    /**
     * Stop one idle desktop **under that bot's provisioning mutex**
     * (adversarial review of #183): the sweep's row snapshot is taken outside
     * any lock, so without this a forward could provision/touch between the
     * snapshot and the stop — the tool call would then land on a desktop this
     * sweep is about to stop, and `setStatus` would clobber the fresh
     * `last_needed_at`. The idle decision is therefore re-made from a fresh
     * read inside the critical section.
     */
    const stopIfStillIdle = (botId: BotId, windowMs: number) =>
      Effect.suspend(() =>
        mutexFor(botId).withPermits(1)(
          Effect.gen(function* () {
            const now = yield* DateTime.now;
            const at = DateTime.formatIso(now);
            const nowMs = DateTime.toEpochMillis(now);
            const row = yield* readRow(botId);
            if (row === null || row.status !== "running") return;
            if ((viewers.get(botId) ?? 0) > 0) {
              yield* touch(botId, at);
              return;
            }
            const lastMs = millisOf(row.last_needed_at);
            if (lastMs !== null && nowMs - lastMs < windowMs) return;
            const outcome = yield* client
              .controlDesktop(desktopIdFor(botId), "stop")
              .pipe(Effect.result);
            if (outcome._tag === "Failure") {
              yield* Effect.logWarning("ADE Screenbox idle stop failed", {
                botId,
                error: outcome.failure.message,
              });
              return;
            }
            yield* setStatus(botId, "stopped", at);
            yield* Effect.log("ADE Screenbox stopped an idle desktop", { botId });
          }),
        ),
      );

    const sweepIdleDesktops: AdeScreenboxRuntimeShape["sweepIdleDesktops"] = Effect.gen(
      function* () {
        if (!client.isConfigured) return;
        // The catalog is refreshed on every tick, not only at boot: a boot-time
        // Screenbox outage would otherwise leave the last-good cache empty
        // forever, denying every `desktop_*` call until a server restart.
        // Failures keep the previous cache.
        yield* refreshToolCatalog;
        yield* reconcileWithUpstream;
        const limits = yield* readLimits;
        const windowMs = Duration.toMillis(Duration.minutes(limits.screenboxIdleStopMinutes));
        const rows = yield* orLogAndSucceed(
          sql<ProvisioningRow>`
            SELECT bot_id, status, last_needed_at FROM ade_screenbox_provisionings
            WHERE status = 'running'
          `,
          "ADE Screenbox could not read running provisioning records",
          [] as ReadonlyArray<ProvisioningRow>,
        );
        for (const row of rows) {
          yield* stopIfStillIdle(row.bot_id as BotId, windowMs);
        }
      },
    ).pipe(
      Effect.catchDefect((defect) =>
        Effect.logWarning("ADE Screenbox idle sweep defect", { defect }),
      ),
    );

    const statusFor: AdeScreenboxRuntimeShape["statusFor"] = (botId) =>
      Effect.map(readRow(botId), (row) => ({
        botId,
        status: (row?.status ?? "none") as ScreenboxProvisioningStatus | "none",
        lastNeededAt: row?.last_needed_at ?? null,
        viewers: viewers.get(botId) ?? 0,
      }));

    const viewerRefusal = (
      botId: BotId,
      kind: AdeScreenboxProvisionFailureKind,
      reason: string,
    ) => new AdeScreenboxProvisionError({ botId, kind, reason });

    const viewerTargetFor: AdeScreenboxRuntimeShape["viewerTargetFor"] = (botId) =>
      Effect.gen(function* () {
        if (!client.isConfigured) {
          return yield* viewerRefusal(
            botId,
            "not-configured",
            "Screenbox is not configured on this host.",
          );
        }
        const row = yield* readRow(botId);
        if (row === null) {
          return yield* viewerRefusal(
            botId,
            "not-eligible",
            "This bot has no desktop yet. Start one from the Screen tab.",
          );
        }
        if (row.status !== "running") {
          return yield* viewerRefusal(
            botId,
            "not-eligible",
            "This bot's desktop is not running. Start it from the Screen tab.",
          );
        }
        const listed = yield* client.listDesktops.pipe(Effect.result);
        if (listed._tag === "Failure") {
          return yield* viewerRefusal(
            botId,
            "upstream",
            `Screenbox could not be reached: ${boundScreenboxDetail(listed.failure.message)}`,
          );
        }
        // Match on the desktop id rather than trusting list order, and require
        // upstream to agree the desktop is running: a record that says
        // "running" while upstream stopped it would otherwise dial a port that
        // now belongs to some other desktop.
        const desktopId = desktopIdFor(botId);
        const desktop = listed.success.find((entry) => entry.desktopId === desktopId);
        if (desktop === undefined || desktop.state !== "running") {
          return yield* viewerRefusal(
            botId,
            "not-eligible",
            "This bot's desktop is not running. Start it from the Screen tab.",
          );
        }
        if (desktop.vncPort === null) {
          return yield* viewerRefusal(
            botId,
            "upstream",
            "Screenbox did not publish a VNC port for this desktop.",
          );
        }
        // Loopback is not a default that a payload may override: upstream binds
        // desktop ports to 127.0.0.1, and hard-coding the host here means a
        // hostile or buggy `list` entry can never redirect the proxy off-box.
        return { host: "127.0.0.1", port: desktop.vncPort };
      });

    const probe: AdeScreenboxRuntimeShape["probe"] = Effect.gen(function* () {
      if (!client.isConfigured) {
        return {
          state: "not-provisioned",
          detail: "Screenbox is not configured on this host.",
        } as const;
      }
      const outcome = yield* client.health.pipe(Effect.result);
      if (outcome._tag === "Failure") {
        return { state: "down", detail: boundScreenboxDetail(outcome.failure.message) } as const;
      }
      // `/api/health` answers 200 even while degraded (missing desktop image,
      // for instance), so a reachable upstream is not a healthy one: the
      // pill follows the body's `ok`, not the status code.
      return outcome.success.ok
        ? ({ state: "healthy" } as const)
        : ({ state: "down", detail: describeUnhealthy(outcome.success) } as const);
    });

    return {
      toolCatalog: Ref.get(catalogRef),
      refreshToolCatalog,
      isComputerUseEnabled,
      forwardToolCall,
      ensureDesktopReady,
      startDesktopFor: ensureDesktopReady,
      stopDesktopFor,
      destroyDesktopFor,
      statusFor,
      viewerTargetFor,
      viewerAttached,
      viewerDetached,
      sweepIdleDesktops,
      reconcileWithUpstream,
      probe,
    } satisfies AdeScreenboxRuntimeShape;
  });
