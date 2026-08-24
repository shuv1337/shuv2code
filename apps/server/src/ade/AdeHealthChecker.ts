// @effect-diagnostics nodeBuiltinImport:off
/**
 * ADE health checker (spec `docs/ade/ADE-V1-SPEC.md` §4.8, ADR §11.3, §16;
 * issue #171).
 *
 * Monitors the shuvcode service, the Codex supervisor, and the Screenbox
 * runtime through pluggable probes and feeds the sidebar kernel pills. When a
 * kernel goes down it queues-and-alerts — no failover (ADR §11.3):
 *
 * - exactly one open Needs You `kernel-down` item exists per outage. Dedupe is
 *   database-backed (any open item for the engine suppresses creation), so a
 *   server restart mid-outage never duplicates the alert;
 * - `running` assignments whose recipient bot holds an active execution
 *   binding on the down engine flip to `blocked: kernel-down`. Queued
 *   assignments stay queued untouched (ADR §11.3).
 *
 * Recovery (ADR §16, §11.3 "work resumes automatically on kernel recovery"):
 * every transition into `healthy` — including the first observation after a
 * server restart — resolves the engine's open `kernel-down` items and releases
 * its `blocked: kernel-down` assignments back to `running`, unless the
 * recipient bot also holds an active binding on another engine that is still
 * down. Release keys on *active* bindings: a blocked row whose binding was
 * lost during the outage stays blocked for the assignment engine's
 * needs-resume path (S7) rather than being silently resurrected.
 *
 * The probe seam (`AdeHealthProbes`) is how later slices plug in: S14 replaces
 * the shipped `not-provisioned` Screenbox probe with one backed by the real
 * runtime, without touching the checker.
 */
import * as NodeCrypto from "node:crypto";

import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  FleetHealthSnapshot,
  HealthState,
  HealthTargetId,
  KernelEngine,
  TargetHealthSnapshot,
} from "@shuv2code/contracts";

import { type PersistenceSqlError, toPersistenceSqlError } from "../persistence/Errors.ts";
import {
  CodexAppServerSupervisor,
  type CodexAppServerSupervisorStatus,
} from "../provider/Services/CodexAppServerSupervisor.ts";
import { discoverOpenCodeV2Service } from "../provider/opencodeV2Service.ts";
import { forkParked } from "../serverActivation.ts";
import {
  type SnapshotSubscription,
  subscribeBeforeSnapshotWithoutMutex,
} from "../utils/subscribeBeforeSnapshot.ts";

// ---------------------------------------------------------------------------
// Probe seam (S14 plugs in here)
// ---------------------------------------------------------------------------

/**
 * What a probe may report. `unknown` is reserved for "not probed yet" and is
 * never a probe outcome; probes must not fail — encode failure as `down`.
 */
export interface AdeHealthProbeResult {
  readonly state: Exclude<HealthState, "unknown">;
  readonly detail?: string;
}

export interface AdeHealthProbe {
  readonly target: HealthTargetId;
  /**
   * Never fails and should be bounded — the checker enforces a hard per-probe
   * timeout ({@link DEFAULT_PROBE_TIMEOUT}) anyway, mapping a timeout to
   * `down`, and maps defects to `down` as a backstop.
   */
  readonly probe: Effect.Effect<AdeHealthProbeResult>;
}

/**
 * The pluggable probe set. The shipped live layer probes the shuvcode service
 * registration, the Codex supervisor, and reports Screenbox as
 * `not-provisioned`; S14 provides a replacement Screenbox probe.
 */
export class AdeHealthProbes extends Context.Service<
  AdeHealthProbes,
  { readonly probes: ReadonlyArray<AdeHealthProbe> }
>()("shuv2code/ade/AdeHealthProbes") {}

/** Kernel targets carry outage semantics; Screenbox is pill-only. */
const kernelEngineOf = (target: HealthTargetId): KernelEngine | null =>
  target === "shuvcode" || target === "codex" ? target : null;

// ---------------------------------------------------------------------------
// Default probe implementations
// ---------------------------------------------------------------------------

/**
 * Pure mapping so the Codex probe rule is unit-testable:
 *
 * - topology ≠ `shared` → `not-provisioned`: the supervisor never runs a
 *   shared process under `per-session`, so its process/crash books stay empty
 *   forever — reporting healthy would show a green pill while the ADE Codex
 *   kernel adapter (S5) fails closed. Neutral pill, no kernel-down Needs You
 *   spam on stock installs; S6/S7 still fail closed with typed errors.
 * - no live process but a recorded abnormal exit → `down`.
 * - otherwise `healthy` — an idle shared supervisor (nothing spawned yet)
 *   spawns on the next acquisition, which is not an outage.
 */
export const codexProbeResultFromStatus = (
  status: CodexAppServerSupervisorStatus,
): AdeHealthProbeResult => {
  if (status.topology !== "shared") {
    return {
      state: "not-provisioned",
      detail: `codexAppServerTopology=${status.topology}; the ADE Codex kernel requires shared topology.`,
    };
  }
  if (status.runningProcesses === 0 && status.crashed.length > 0) {
    const failures = Math.max(...status.crashed.map((crash) => crash.consecutiveFailures));
    return {
      state: "down",
      detail: `codex app-server exited (${failures} consecutive failure${failures === 1 ? "" : "s"})`,
    };
  }
  return { state: "healthy" };
};

export const SHUVCODE_DOWN_DETAIL =
  "shuvcode service is not running or not healthy; start it with `opencode service start`.";

/** Probes the shuvcode background-service registration (`GET /api/health`). */
export const shuvcodeServiceProbe: AdeHealthProbe = {
  target: "shuvcode",
  probe: Effect.tryPromise(() => discoverOpenCodeV2Service()).pipe(
    Effect.map(
      (endpoint): AdeHealthProbeResult =>
        endpoint === null
          ? { state: "down", detail: SHUVCODE_DOWN_DETAIL }
          : { state: "healthy", detail: `attached to ${endpoint.url}` },
    ),
    Effect.orElseSucceed(
      (): AdeHealthProbeResult => ({
        state: "down",
        detail: SHUVCODE_DOWN_DETAIL,
      }),
    ),
  ),
};

/** Placeholder until S14 lands the Screenbox runtime integration. */
export const screenboxNotProvisionedProbe: AdeHealthProbe = {
  target: "screenbox",
  probe: Effect.succeed({
    state: "not-provisioned",
    detail: "Screenbox runtime is not provisioned.",
  }),
};

// ---------------------------------------------------------------------------
// Service shape
// ---------------------------------------------------------------------------

export interface AdeHealthCheckerShape {
  /** Current pill row without probing. */
  readonly latest: Effect.Effect<FleetHealthSnapshot>;
  /** Latest snapshot plus a stream of subsequent changes (race-free). */
  readonly subscribe: Effect.Effect<SnapshotSubscription<FleetHealthSnapshot>, never, Scope.Scope>;
  /** Runs one probe pass, applying kernel-down/recovery side effects. */
  readonly checkNow: Effect.Effect<FleetHealthSnapshot, PersistenceSqlError>;
}

interface TargetState {
  readonly state: HealthState;
  readonly detail: string | null;
  readonly since: string;
  readonly checkedAt: string;
}

const TARGET_ORDER: ReadonlyArray<HealthTargetId> = ["shuvcode", "codex", "screenbox"];

const DEFAULT_TICK_INTERVAL = Duration.seconds(15);

/** Hard per-probe bound; a slower probe reads as `down` ("probe timed out"). */
export const DEFAULT_PROBE_TIMEOUT = Duration.seconds(5);

/** Wire bound for probe detail so a stringified defect can't ship a stack. */
const DETAIL_MAX_LENGTH = 512;

const boundedDetail = (detail: string | null | undefined): string | null =>
  detail === undefined || detail === null || detail.length === 0
    ? null
    : detail.slice(0, DETAIL_MAX_LENGTH);

export interface AdeHealthCheckerOptions {
  /** Test seam; production keeps the {@link DEFAULT_PROBE_TIMEOUT} constant. */
  readonly probeTimeout?: Duration.Duration;
}

export class AdeHealthChecker extends Context.Service<AdeHealthChecker, AdeHealthCheckerShape>()(
  "shuv2code/ade/AdeHealthChecker",
) {
  static readonly layerWith = (options: AdeHealthCheckerOptions = {}) =>
    Layer.effect(
      AdeHealthChecker,
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const { probes } = yield* AdeHealthProbes;
        const probeTimeout = options.probeTimeout ?? DEFAULT_PROBE_TIMEOUT;

        const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
        const uuid = Effect.sync(() => NodeCrypto.randomUUID());
        const bootAt = yield* nowIso;

        const stateRef = yield* Ref.make(
          new Map<HealthTargetId, TargetState>(
            probes.map((probe) => [
              probe.target,
              { state: "unknown", detail: null, since: bootAt, checkedAt: bootAt },
            ]),
          ),
        );
        // Sliding: a stalled subscriber only ever needs the newest pill row.
        const changesPubSub = yield* Effect.acquireRelease(
          PubSub.sliding<FleetHealthSnapshot>(8),
          (pubsub) => PubSub.shutdown(pubsub),
        );
        // Serializes probe passes only. Reads (`latest`) and new subscriptions
        // deliberately do NOT take this mutex: one slow tick must never freeze
        // snapshot reads or `subscribeAdeFleetHealth` calls.
        const tickMutex = Semaphore.makeUnsafe(1);

        const toSnapshot = (
          states: ReadonlyMap<HealthTargetId, TargetState>,
        ): FleetHealthSnapshot => {
          const targets: Array<TargetHealthSnapshot> = [];
          for (const target of TARGET_ORDER) {
            const state = states.get(target);
            if (state === undefined) continue;
            targets.push({
              target,
              state: state.state,
              detail: state.detail,
              since: state.since,
              checkedAt: state.checkedAt,
            });
          }
          return { targets };
        };

        const subjectRefsNameKernel = (subjectRefsJson: string, engine: KernelEngine): boolean => {
          try {
            const refs = JSON.parse(subjectRefsJson) as unknown;
            return (
              Array.isArray(refs) &&
              refs.some(
                (ref) =>
                  typeof ref === "object" &&
                  ref !== null &&
                  (ref as { _tag?: unknown })._tag === "kernel" &&
                  (ref as { engine?: unknown }).engine === engine,
              )
            );
          } catch {
            return false;
          }
        };

        /**
         * Queue-and-alert: one Needs You per outage + block running work.
         *
         * Blocking is edge-triggered (down transitions only). S7 contract: the
         * assignment engine must check kernel health at admission — an
         * assignment promoted queued→running mid-outage is S7's responsibility,
         * not swept up by a later tick here.
         */
        const onKernelDown = (engine: KernelEngine, at: string) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const openItems = yield* sql<{ subject_refs_json: string }>`
              SELECT subject_refs_json FROM ade_needs_you_items
              WHERE kind = 'kernel-down' AND status = 'open'
            `;
              const alreadyAlerted = openItems.some((row) =>
                subjectRefsNameKernel(row.subject_refs_json, engine),
              );
              if (!alreadyAlerted) {
                const id = yield* uuid;
                const subjectRefs = JSON.stringify([{ _tag: "kernel", engine }]);
                yield* sql`
                INSERT INTO ade_needs_you_items (
                  needs_you_item_id, kind, subject_refs_json, status,
                  created_at, updated_at, resolved_at
                ) VALUES (${id}, 'kernel-down', ${subjectRefs}, 'open', ${at}, ${at}, NULL)
              `;
              }
              yield* sql`
              UPDATE ade_assignments
              SET status = 'blocked', blocked_reason = 'kernel-down', updated_at = ${at}
              WHERE status = 'running'
                AND recipient_bot_id IN (
                  SELECT DISTINCT bot_id FROM ade_bot_execution_bindings
                  WHERE engine = ${engine} AND status = 'active'
                )
            `;
            }),
          );

        /**
         * Resolve the alert and release work the recovered engine was blocking.
         * Both release UPDATEs are scoped to `blocked_reason = 'kernel-down'` on
         * purpose: the checker only ever promotes rows it blocked itself —
         * approval/children/needs-resume blocks belong to S7/S13.
         */
        const onKernelRecovered = (
          engine: KernelEngine,
          stillDownEngines: ReadonlyArray<KernelEngine>,
          at: string,
        ) =>
          sql.withTransaction(
            Effect.gen(function* () {
              const openItems = yield* sql<{
                needs_you_item_id: string;
                subject_refs_json: string;
              }>`
              SELECT needs_you_item_id, subject_refs_json FROM ade_needs_you_items
              WHERE kind = 'kernel-down' AND status = 'open'
            `;
              for (const row of openItems) {
                if (!subjectRefsNameKernel(row.subject_refs_json, engine)) continue;
                yield* sql`
                UPDATE ade_needs_you_items
                SET status = 'resolved', resolved_at = ${at}, updated_at = ${at}
                WHERE needs_you_item_id = ${row.needs_you_item_id}
              `;
              }
              // Only two kernel engines exist, so at most one can still be down.
              const otherDown = stillDownEngines.find((candidate) => candidate !== engine);
              if (otherDown === undefined) {
                yield* sql`
                UPDATE ade_assignments
                SET status = 'running', blocked_reason = NULL, updated_at = ${at}
                WHERE status = 'blocked' AND blocked_reason = 'kernel-down'
                  AND recipient_bot_id IN (
                    SELECT DISTINCT bot_id FROM ade_bot_execution_bindings
                    WHERE engine = ${engine} AND status = 'active'
                  )
              `;
              } else {
                yield* sql`
                UPDATE ade_assignments
                SET status = 'running', blocked_reason = NULL, updated_at = ${at}
                WHERE status = 'blocked' AND blocked_reason = 'kernel-down'
                  AND recipient_bot_id IN (
                    SELECT DISTINCT bot_id FROM ade_bot_execution_bindings
                    WHERE engine = ${engine} AND status = 'active'
                  )
                  AND recipient_bot_id NOT IN (
                    SELECT DISTINCT bot_id FROM ade_bot_execution_bindings
                    WHERE engine = ${otherDown} AND status = 'active'
                  )
              `;
              }
            }),
          );

        const checkNow = tickMutex
          .withPermits(1)(
            Effect.gen(function* () {
              const checkedAt = yield* nowIso;
              const previous = yield* Ref.get(stateRef);
              const results = yield* Effect.forEach(
                probes,
                (probe) =>
                  probe.probe.pipe(
                    Effect.timeoutOrElse({
                      duration: probeTimeout,
                      orElse: () =>
                        Effect.succeed<AdeHealthProbeResult>({
                          state: "down",
                          detail: "probe timed out",
                        }),
                    }),
                    Effect.catchDefect((defect) =>
                      Effect.succeed<AdeHealthProbeResult>({
                        state: "down",
                        detail: `probe crashed: ${String(defect)}`,
                      }),
                    ),
                    Effect.map((result) => ({ target: probe.target, result })),
                  ),
                { concurrency: "unbounded" },
              );

              const next = new Map(previous);
              let changed = false;
              const transitions: Array<{
                readonly engine: KernelEngine;
                readonly kind: "down" | "recovered";
                readonly detail: string | null;
              }> = [];
              for (const { target, result } of results) {
                const prior = previous.get(target);
                const priorState = prior?.state ?? "unknown";
                const detail = boundedDetail(result.detail);
                next.set(target, {
                  state: result.state,
                  detail,
                  since:
                    prior !== undefined && priorState === result.state ? prior.since : checkedAt,
                  checkedAt,
                });
                if (priorState !== result.state || prior?.detail !== detail) {
                  changed = true;
                }
                const engine = kernelEngineOf(target);
                if (engine === null) continue;
                if (result.state === "down" && priorState !== "down") {
                  transitions.push({ engine, kind: "down", detail });
                } else if (result.state === "healthy" && priorState !== "healthy") {
                  transitions.push({ engine, kind: "recovered", detail });
                }
              }

              const stillDownEngines = [...next.entries()].flatMap(([target, state]) => {
                const engine = kernelEngineOf(target);
                return engine !== null && state.state === "down" ? [engine] : [];
              });
              for (const transition of transitions) {
                if (transition.kind === "down") {
                  yield* onKernelDown(transition.engine, checkedAt);
                  yield* Effect.logWarning("ADE kernel down", {
                    engine: transition.engine,
                    detail: transition.detail,
                  });
                } else {
                  yield* onKernelRecovered(transition.engine, stillDownEngines, checkedAt);
                  yield* Effect.log("ADE kernel recovered", { engine: transition.engine });
                }
              }

              yield* Ref.set(stateRef, next);
              const snapshot = toSnapshot(next);
              if (changed) {
                yield* PubSub.publish(changesPubSub, snapshot);
              }
              return snapshot;
            }),
          )
          .pipe(Effect.mapError(toPersistenceSqlError("AdeHealthChecker.checkNow")));

        const latest = Effect.map(Ref.get(stateRef), toSnapshot);

        return AdeHealthChecker.of({
          latest,
          // Subscription-before-snapshot without the tick mutex: the critical
          // section is just "subscribe, then read the Ref" — it never spans
          // probing, so a hung probe can't block new subscribers. A snapshot
          // published between the two steps is delivered again through the
          // stream; identical-snapshot redelivery is idempotent for clients.
          subscribe: subscribeBeforeSnapshotWithoutMutex(changesPubSub, latest),
          checkNow,
        });
      }),
    );

  static readonly layer = AdeHealthChecker.layerWith();

  /**
   * Shipped probe set with a caller-supplied Screenbox probe: shuvcode service
   * registration, Codex supervisor, and whatever the Screenbox slice provides.
   * S14 passes its live runtime probe here; the probe's own requirements are
   * captured at layer-build time so the stored `Effect` stays requirement-free
   * for the checker.
   */
  static readonly probesLiveWith = <R>(
    screenboxProbe: Effect.Effect<AdeHealthProbeResult, never, R>,
  ): Layer.Layer<AdeHealthProbes, never, CodexAppServerSupervisor | R> =>
    Layer.effect(
      AdeHealthProbes,
      Effect.gen(function* () {
        const supervisor = yield* CodexAppServerSupervisor;
        const services = yield* Effect.context<R>();
        return AdeHealthProbes.of({
          probes: [
            shuvcodeServiceProbe,
            {
              target: "codex",
              // Blocked assignments never call acquireConnection, so a crashed
              // shared process would otherwise stay down forever (the outage
              // blocks the only lazy-respawn path). The probe actively asserts
              // liveness: attempt a bounded respawn of crashed identities, then
              // read the books. The tick cadence is the retry schedule.
              probe: supervisor.reviveCrashed.pipe(
                Effect.andThen(supervisor.status),
                Effect.map(codexProbeResultFromStatus),
              ),
            },
            { target: "screenbox", probe: Effect.provide(screenboxProbe, services) },
          ],
        });
      }),
    );

  /** Default wiring: Screenbox dormant until S14's runtime layer is provided. */
  static readonly probesLive = AdeHealthChecker.probesLiveWith(screenboxNotProvisionedProbe.probe);

  /**
   * Periodic tick, parked until server activation. Probe passes are cheap
   * (local HTTP health read + two Ref reads), so a fixed cadence suffices.
   */
  static readonly tickerLive = (
    interval: Duration.Duration = DEFAULT_TICK_INTERVAL,
  ): Layer.Layer<never, never, AdeHealthChecker> =>
    Layer.effectDiscard(
      Effect.gen(function* () {
        const checker = yield* AdeHealthChecker;
        yield* forkParked(
          checker.checkNow.pipe(
            Effect.catch((error) => Effect.logWarning("ADE health tick failed", { error })),
            Effect.catchDefect((defect) => Effect.logWarning("ADE health tick defect", { defect })),
            Effect.repeat(Schedule.spaced(interval)),
          ),
        );
      }),
    );
}
