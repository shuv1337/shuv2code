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
  subscribeBeforeSnapshot,
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
  /** Never fails; defects are mapped to `down` by the checker as a backstop. */
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

/** Pure mapping so the Codex probe rule is unit-testable. */
export const codexProbeResultFromStatus = (
  status: CodexAppServerSupervisorStatus,
): AdeHealthProbeResult => {
  if (status.runningProcesses === 0 && status.crashed.length > 0) {
    const failures = Math.max(...status.crashed.map((crash) => crash.consecutiveFailures));
    return {
      state: "down",
      detail: `codex app-server exited (${failures} consecutive failure${failures === 1 ? "" : "s"})`,
    };
  }
  // An idle supervisor (no process spawned yet) is healthy: it spawns on the
  // next acquisition. Per-session topology has no shared process to watch.
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

export class AdeHealthChecker extends Context.Service<AdeHealthChecker, AdeHealthCheckerShape>()(
  "shuv2code/ade/AdeHealthChecker",
) {
  static readonly layer = Layer.effect(
    AdeHealthChecker,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const { probes } = yield* AdeHealthProbes;

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
      const changesPubSub = yield* Effect.acquireRelease(
        PubSub.unbounded<FleetHealthSnapshot>(),
        (pubsub) => PubSub.shutdown(pubsub),
      );
      const mutex = Semaphore.makeUnsafe(1);

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

      /** Queue-and-alert: one Needs You per outage + block running work. */
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

      /** Resolve the alert and release work the recovered engine was blocking. */
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

      const checkNow = mutex
        .withPermits(1)(
          Effect.gen(function* () {
            const checkedAt = yield* nowIso;
            const previous = yield* Ref.get(stateRef);
            const results = yield* Effect.forEach(
              probes,
              (probe) =>
                probe.probe.pipe(
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
              const detail = result.detail ?? null;
              next.set(target, {
                state: result.state,
                detail,
                since: prior !== undefined && priorState === result.state ? prior.since : checkedAt,
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
        subscribe: subscribeBeforeSnapshot(changesPubSub, latest, mutex),
        checkNow,
      });
    }),
  );

  /**
   * Shipped probe set: shuvcode service registration, Codex supervisor,
   * Screenbox dormant. S14 swaps the Screenbox entry for a live probe.
   */
  static readonly probesLive = Layer.effect(
    AdeHealthProbes,
    Effect.gen(function* () {
      const supervisor = yield* CodexAppServerSupervisor;
      return AdeHealthProbes.of({
        probes: [
          shuvcodeServiceProbe,
          {
            target: "codex",
            probe: Effect.map(supervisor.status, codexProbeResultFromStatus),
          },
          screenboxNotProvisionedProbe,
        ],
      });
    }),
  );

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
