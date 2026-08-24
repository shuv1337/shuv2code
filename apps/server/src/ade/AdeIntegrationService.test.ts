/**
 * State-machine coverage for the ADE integration service (spec §4.4, ADR §7,
 * §16.2 — issue #164). The JJ mechanics ride a programmable stub port so every
 * transition, bounce, and restart path is deterministic; the real `jj` half is
 * covered by `AdeIntegrationRepoPort.runtime.test.ts`.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type {
  AdeProjectId,
  AssignmentId,
  BotId,
  IntegrationCandidateId,
} from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { AdeAssignmentEngine, AdeAssignmentKernelPort } from "./AdeAssignmentEngine.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import {
  AdeIntegrationRepoError,
  AdeIntegrationRepoPort,
  type AdeIntegrationRepoPortShape,
  type CheckFailure,
} from "./AdeIntegrationRepoPort.ts";
import {
  AdeIntegrationService,
  effectiveIntegrationGate,
  gateForDeclaredRisk,
} from "./AdeIntegrationService.ts";

const REPO_PATH = "/tmp/ade-integration-test/repo";

interface StubState {
  syncConflict: string | null;
  syncFails: boolean;
  prepareConflict: string | null;
  prepareFails: boolean;
  checkFailures: ReadonlyArray<CheckFailure>;
  advanceFails: boolean;
  syncCalls: number;
  prepareCalls: number;
  checkCalls: number;
  advanceCalls: Array<string>;
  cleanupCalls: Array<string>;
}

const initialStubState: StubState = {
  syncConflict: null,
  syncFails: false,
  prepareConflict: null,
  prepareFails: false,
  checkFailures: [],
  advanceFails: false,
  syncCalls: 0,
  prepareCalls: 0,
  checkCalls: 0,
  advanceCalls: [],
  cleanupCalls: [],
};

const makeStubPort = Effect.gen(function* () {
  const state = yield* Ref.make<StubState>({ ...initialStubState });

  const shape: AdeIntegrationRepoPortShape = {
    syncUpstream: () =>
      Effect.gen(function* () {
        const current = yield* Ref.updateAndGet(state, (value) => ({
          ...value,
          syncCalls: value.syncCalls + 1,
        }));
        if (current.syncFails) {
          return yield* new AdeIntegrationRepoError({
            operation: "syncUpstream",
            detail: "stubbed fetch failure",
          });
        }
        return { advanced: false, conflictDetail: current.syncConflict };
      }),
    prepareCandidateWorkspace: (input) =>
      Effect.gen(function* () {
        const current = yield* Ref.updateAndGet(state, (value) => ({
          ...value,
          prepareCalls: value.prepareCalls + 1,
        }));
        if (current.prepareFails) {
          return yield* new AdeIntegrationRepoError({
            operation: "prepareCandidateWorkspace",
            detail: "stubbed workspace failure",
          });
        }
        return {
          workspacePath: input.workspacePath,
          headRevision: input.changeIds[input.changeIds.length - 1] as string,
          conflictDetail: current.prepareConflict,
        };
      }),
    runChecks: () =>
      Effect.gen(function* () {
        const current = yield* Ref.updateAndGet(state, (value) => ({
          ...value,
          checkCalls: value.checkCalls + 1,
        }));
        return {
          passed: current.checkFailures.length === 0,
          failures: current.checkFailures,
        };
      }),
    advanceCanonical: (input) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        if (current.advanceFails) {
          return yield* new AdeIntegrationRepoError({
            operation: "advanceCanonical",
            detail: "stubbed canonical failure",
          });
        }
        yield* Ref.update(state, (value) => ({
          ...value,
          advanceCalls: [...value.advanceCalls, input.headRevision],
        }));
        return { canonicalCommitId: `commit-for-${input.headRevision}` };
      }),
    cleanupWorkspace: (input) =>
      Ref.update(state, (value) => ({
        ...value,
        cleanupCalls: [...value.cleanupCalls, input.workspacePath],
      })),
  };

  return { state, layer: Layer.succeed(AdeIntegrationRepoPort, shape) };
});

interface Fixture {
  readonly sql: SqlClient.SqlClient;
  readonly service: AdeIntegrationService["Service"];
  readonly assignments: AdeAssignmentEngine["Service"];
  readonly state: Ref.Ref<StubState>;
  readonly projectId: AdeProjectId;
  readonly secondMateBotId: BotId;
  readonly coderBotId: BotId;
}

const encodeCheckCommands = Schema.encodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));

const setup = (
  projectOptions: {
    readonly integrationPolicyDefault?: "automatic" | "agent-review" | "human-approval";
    readonly checkCommands?: ReadonlyArray<string>;
  } = {},
) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* sql`PRAGMA foreign_keys = ON`;

    const stub = yield* makeStubPort;
    const context = yield* Layer.build(
      AdeIntegrationService.layerWith({
        workspaceRoot: "/tmp/ade-integration-test/workspaces",
      }).pipe(
        Layer.provideMerge(AdeAssignmentEngine.layer),
        Layer.provideMerge(AdeBootstrap.layer),
        Layer.provide(stub.layer),
        Layer.provide(AdeAssignmentKernelPort.layerUnwired),
        Layer.provide(Path.layer),
      ),
    );
    const service = yield* Effect.service(AdeIntegrationService).pipe(Effect.provide(context));
    const assignments = yield* Effect.service(AdeAssignmentEngine).pipe(Effect.provide(context));
    const bootstrap = yield* Effect.service(AdeBootstrap).pipe(Effect.provide(context));

    yield* bootstrap.ensureSeeded();
    const project = yield* bootstrap.createProject({
      name: "Integration project",
      repoBinding: { path: REPO_PATH, remote: null },
      ...(projectOptions.integrationPolicyDefault !== undefined
        ? { integrationPolicyDefault: projectOptions.integrationPolicyDefault }
        : {}),
    });
    if (projectOptions.checkCommands !== undefined) {
      const encoded = yield* encodeCheckCommands(projectOptions.checkCommands);
      yield* sql`
        UPDATE ade_projects SET check_commands_json = ${encoded}
        WHERE project_id = ${project.projectId}
      `;
    }
    const coder = yield* bootstrap.instantiateTemplate({
      templateId: "coder",
      projectId: project.projectId,
    });

    return {
      sql,
      service,
      assignments,
      state: stub.state,
      projectId: project.projectId,
      secondMateBotId: project.secondMate.botId,
      coderBotId: coder.botId,
    } satisfies Fixture;
  });

const scenario = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) => it.effect(name, () => Effect.scoped(Effect.provide(body(), NodeSqliteClient.layerMemory())));

const enqueue = (
  fixture: Fixture,
  overrides: {
    readonly declaredRisk?: "mechanical" | "normal" | "protected";
    readonly changeIds?: ReadonlyArray<string>;
    readonly key?: string;
  } = {},
) =>
  fixture.service.enqueueCandidate({
    projectId: fixture.projectId,
    sourceAssignmentIds: [],
    changeIds: overrides.changeIds ?? ["zkmqwpxr"],
    originatingBotId: fixture.coderBotId,
    ...(overrides.declaredRisk !== undefined ? { declaredRisk: overrides.declaredRisk } : {}),
    ...(overrides.key !== undefined ? { idempotencyKey: overrides.key } : {}),
  });

// ---------------------------------------------------------------------------
// Gate policy
// ---------------------------------------------------------------------------

it("maps declared risk to a gate and never lets a bot lower the project floor", () => {
  assert.strictEqual(gateForDeclaredRisk("mechanical"), "automatic");
  assert.strictEqual(gateForDeclaredRisk("normal"), "agent-review");
  assert.strictEqual(gateForDeclaredRisk("protected"), "human-approval");

  // Mechanical skips review only where the project itself allows it (ADR §7.1).
  assert.strictEqual(effectiveIntegrationGate("automatic", "mechanical"), "automatic");
  assert.strictEqual(effectiveIntegrationGate("agent-review", "mechanical"), "agent-review");
  assert.strictEqual(effectiveIntegrationGate("human-approval", "mechanical"), "human-approval");
  // Escalation always wins.
  assert.strictEqual(effectiveIntegrationGate("automatic", "protected"), "human-approval");
  assert.strictEqual(effectiveIntegrationGate("agent-review", "protected"), "human-approval");
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

scenario("integrates a mechanical candidate automatically once checks are green", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "automatic" });
    const enqueued = yield* enqueue(fixture, { declaredRisk: "mechanical" });
    assert.isTrue(enqueued.created);
    assert.strictEqual(enqueued.candidate.status, "queued");

    const outcome = yield* fixture.service.processQueueHead(fixture.projectId);
    assert.deepEqual(outcome, {
      _tag: "advanced",
      candidateId: enqueued.candidate.id,
      status: "integrated",
    });

    const settled = yield* fixture.service.getCandidate(enqueued.candidate.id);
    assert.strictEqual(settled?.status, "integrated");
    assert.strictEqual(settled?.gate, "automatic");
    // The workspace is released on the happy path (ADR §14.4).
    assert.strictEqual(settled?.workspacePath, null);

    const state = yield* Ref.get(fixture.state);
    // Upstream sync happens before anything mutates (ADR §14.3).
    assert.strictEqual(state.syncCalls, 1);
    assert.strictEqual(state.checkCalls, 1);
    assert.deepEqual(state.advanceCalls, ["zkmqwpxr"]);
    assert.strictEqual(state.cleanupCalls.length, 1);

    // The queue is empty afterwards.
    const next = yield* fixture.service.processQueueHead(fixture.projectId);
    assert.deepEqual(next, { _tag: "idle" });
  }),
);

scenario("routes a normal-risk candidate to the project Reviewer, never its author", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    const reviewerRows = yield* fixture.sql<{ readonly bot_id: string }>`
      INSERT INTO ade_bots (bot_id, name, structural_role, role_tag, project_id, created_at)
      VALUES ('bot-reviewer', 'Reviewer', 'crew', 'Reviewer', ${fixture.projectId},
              '2026-08-24T00:00:00.000Z')
      RETURNING bot_id
    `;
    assert.strictEqual(reviewerRows[0]?.bot_id, "bot-reviewer");

    const enqueued = yield* enqueue(fixture);
    yield* fixture.service.processQueueHead(fixture.projectId);

    const parked = yield* fixture.service.getCandidate(enqueued.candidate.id);
    assert.strictEqual(parked?.status, "awaiting-review");
    assert.strictEqual(parked?.gate, "agent-review");
    assert.strictEqual(parked?.reviewerBotId, "bot-reviewer");
    assert.notStrictEqual(parked?.reviewerBotId, fixture.coderBotId);
    assert.isNotNull(parked?.workspacePath);

    // The reviewer was briefed through the assignment engine.
    const briefs = yield* fixture.assignments.listForBot("bot-reviewer" as BotId);
    assert.strictEqual(briefs.length, 1);
    assert.include(briefs[0]?.instruction ?? "", enqueued.candidate.id);

    // A parked gate holds the whole project queue (ADR §7.2).
    const second = yield* enqueue(fixture, { changeIds: ["qwlnnmts"], key: "second" });
    const held = yield* fixture.service.processQueueHead(fixture.projectId);
    assert.deepEqual(held, { _tag: "waiting", candidateId: enqueued.candidate.id });
    const stillQueued = yield* fixture.service.getCandidate(second.candidate.id);
    assert.strictEqual(stillQueued?.status, "queued");

    // Approval advances canonical, then the next candidate is free to run.
    const approved = yield* fixture.service.submitReview({
      candidateId: enqueued.candidate.id,
      reviewerBotId: "bot-reviewer" as BotId,
      decision: "approve",
    });
    assert.strictEqual(approved.status, "integrated");
    const released = yield* fixture.service.processQueueHead(fixture.projectId);
    assert.strictEqual(released._tag, "advanced");
  }),
);

scenario("falls back to the Second Mate, then escalates when only the author is left", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();

    // No Reviewer in the crew: the Second Mate reviews (ADR §7.2).
    const first = yield* enqueue(fixture);
    yield* fixture.service.processQueueHead(fixture.projectId);
    const viaSecondMate = yield* fixture.service.getCandidate(first.candidate.id);
    assert.strictEqual(viaSecondMate?.status, "awaiting-review");
    assert.strictEqual(viaSecondMate?.reviewerBotId, fixture.secondMateBotId);
    yield* fixture.service.submitReview({
      candidateId: first.candidate.id,
      reviewerBotId: fixture.secondMateBotId,
      decision: "approve",
    });

    // The Second Mate authoring its own change leaves nobody eligible, so the
    // candidate escalates to captain approval rather than self-reviewing.
    const authored = yield* fixture.service.enqueueCandidate({
      projectId: fixture.projectId,
      sourceAssignmentIds: [],
      changeIds: ["mmvpwsxk"],
      originatingBotId: fixture.secondMateBotId,
    });
    yield* fixture.service.processQueueHead(fixture.projectId);
    const escalated = yield* fixture.service.getCandidate(authored.candidate.id);
    assert.strictEqual(escalated?.status, "awaiting-approval");
    assert.strictEqual(escalated?.gate, "human-approval");
    assert.strictEqual(escalated?.reviewerBotId, null);
  }),
);

scenario("sends a protected candidate straight to captain approval", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "automatic" });
    const enqueued = yield* enqueue(fixture, { declaredRisk: "protected" });
    yield* fixture.service.processQueueHead(fixture.projectId);

    const parked = yield* fixture.service.getCandidate(enqueued.candidate.id);
    assert.strictEqual(parked?.status, "awaiting-approval");
    assert.strictEqual(parked?.gate, "human-approval");

    const integrated = yield* fixture.service.submitApproval({
      candidateId: enqueued.candidate.id,
      decision: "approve",
    });
    assert.strictEqual(integrated.status, "integrated");
    const state = yield* Ref.get(fixture.state);
    assert.deepEqual(state.advanceCalls, ["zkmqwpxr"]);
  }),
);

// ---------------------------------------------------------------------------
// Bounces + repair emission
// ---------------------------------------------------------------------------

const assertRepair = (
  fixture: Fixture,
  candidateId: IntegrationCandidateId,
  expectedFragment: string,
) =>
  Effect.gen(function* () {
    const settled = yield* fixture.service.getCandidate(candidateId);
    assert.strictEqual(settled?.status, "bounced");
    assert.strictEqual(settled?.bounceCount, 1);
    // The workspace is retained for forensics (ADR §14.4).
    assert.isNotNull(settled?.repairAssignmentId);

    const repairs = yield* fixture.assignments.listForBot(fixture.coderBotId);
    assert.strictEqual(repairs.length, 1);
    const repair = repairs[0];
    assert.strictEqual(repair?.id, settled?.repairAssignmentId as AssignmentId);
    assert.strictEqual(repair?.recipientBotId, fixture.coderBotId);
    assert.include(repair?.instruction ?? "", expectedFragment);
    assert.strictEqual(repair?.idempotencyKey, `ade-integration-repair:${candidateId}`);
    return settled;
  });

scenario("bounces a conflicted rebase and emits one repair assignment to its author", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "automatic" });
    yield* Ref.update(fixture.state, (value) => ({
      ...value,
      prepareConflict: "conflict in src/widget.ts",
    }));
    const enqueued = yield* enqueue(fixture, { declaredRisk: "mechanical" });
    const outcome = yield* fixture.service.processQueueHead(fixture.projectId);
    assert.deepEqual(outcome, {
      _tag: "advanced",
      candidateId: enqueued.candidate.id,
      status: "bounced",
    });

    const settled = yield* assertRepair(fixture, enqueued.candidate.id, "rebase-conflict");
    assert.strictEqual(settled?.bounce?.reason, "rebase-conflict");
    assert.isNotNull(settled?.workspacePath);

    // Canonical never moved.
    const state = yield* Ref.get(fixture.state);
    assert.deepEqual(state.advanceCalls, []);
    assert.deepEqual(state.cleanupCalls, []);
  }),
);

scenario("bounces red checks even under an automatic gate (always-green)", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({
      integrationPolicyDefault: "automatic",
      checkCommands: ["pnpm test"],
    });
    yield* Ref.update(fixture.state, (value) => ({
      ...value,
      checkFailures: [{ command: "pnpm test", exitCode: 1, output: "3 failing" }],
    }));
    const enqueued = yield* enqueue(fixture, { declaredRisk: "mechanical" });
    yield* fixture.service.processQueueHead(fixture.projectId);

    const settled = yield* assertRepair(fixture, enqueued.candidate.id, "pnpm test");
    assert.strictEqual(settled?.bounce?.reason, "checks-failed");
    const state = yield* Ref.get(fixture.state);
    assert.deepEqual(state.advanceCalls, []);
  }),
);

scenario("bounces a rejected review and a denied approval", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    const reviewed = yield* enqueue(fixture);
    yield* fixture.service.processQueueHead(fixture.projectId);
    const rejected = yield* fixture.service.submitReview({
      candidateId: reviewed.candidate.id,
      reviewerBotId: fixture.secondMateBotId,
      decision: "reject",
      feedback: "The migration needs a down path.",
    });
    assert.strictEqual(rejected.status, "bounced");
    assert.strictEqual(rejected.bounce?.reason, "review-rejected");
    yield* assertRepair(fixture, reviewed.candidate.id, "down path");

    const protectedCandidate = yield* enqueue(fixture, {
      declaredRisk: "protected",
      changeIds: ["mmvpwsxk"],
      key: "protected-one",
    });
    yield* fixture.service.processQueueHead(fixture.projectId);
    const denied = yield* fixture.service.submitApproval({
      candidateId: protectedCandidate.candidate.id,
      decision: "deny",
      note: "Not this release.",
    });
    assert.strictEqual(denied.status, "bounced");
    assert.strictEqual(denied.bounce?.reason, "approval-denied");

    const state = yield* Ref.get(fixture.state);
    assert.deepEqual(state.advanceCalls, []);
  }),
);

scenario("refuses a verdict from anyone but the recorded reviewer", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    const enqueued = yield* enqueue(fixture);
    yield* fixture.service.processQueueHead(fixture.projectId);

    // The author is never the reviewer, and a stranger's verdict is refused.
    const selfReview = yield* fixture.service
      .submitReview({
        candidateId: enqueued.candidate.id,
        reviewerBotId: fixture.coderBotId,
        decision: "approve",
      })
      .pipe(Effect.flip);
    assert.strictEqual(selfReview._tag, "AdeIntegrationReviewerMismatchError");

    // An approval verdict does not apply to a review-gated candidate.
    const wrongGate = yield* fixture.service
      .submitApproval({ candidateId: enqueued.candidate.id, decision: "approve" })
      .pipe(Effect.flip);
    assert.strictEqual(wrongGate._tag, "AdeIntegrationCandidateStateError");

    const state = yield* Ref.get(fixture.state);
    assert.deepEqual(state.advanceCalls, []);
  }),
);

scenario("notifies the Second Mate when the same change set bounces again", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "automatic" });
    yield* Ref.update(fixture.state, (value) => ({ ...value, prepareConflict: "conflict" }));

    yield* enqueue(fixture, { declaredRisk: "mechanical", key: "attempt-1" });
    yield* fixture.service.processQueueHead(fixture.projectId);
    const firstNotices = yield* fixture.assignments.listForBot(fixture.secondMateBotId);
    assert.strictEqual(firstNotices.length, 0);

    yield* enqueue(fixture, { declaredRisk: "mechanical", key: "attempt-2" });
    yield* fixture.service.processQueueHead(fixture.projectId);
    const notices = yield* fixture.assignments.listForBot(fixture.secondMateBotId);
    assert.strictEqual(notices.length, 1);
    assert.include(notices[0]?.instruction ?? "", "bounced 2 times");
  }),
);

// ---------------------------------------------------------------------------
// Serialization + restart
// ---------------------------------------------------------------------------

scenario("enforces one running candidate per project, in the DB and in the service", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    const first = yield* enqueue(fixture, { key: "a" });
    const second = yield* enqueue(fixture, { key: "b", changeIds: ["qwlnnmts"] });

    // The partial unique index is the arbiter: a hand-rolled concurrent claim
    // of the second candidate cannot coexist with a running first.
    yield* fixture.sql`
      UPDATE ade_integration_candidates SET status = 'running'
      WHERE integration_candidate_id = ${first.candidate.id}
    `;
    const conflict = yield* fixture.sql`
      UPDATE ade_integration_candidates SET status = 'running'
      WHERE integration_candidate_id = ${second.candidate.id}
    `.pipe(Effect.flip);
    assert.strictEqual(conflict._tag, "SqlError");

    // And the service refuses to claim while another candidate holds the slot:
    // it adopts the running row instead of starting a second pass.
    const outcome = yield* fixture.service.processQueueHead(fixture.projectId);
    assert.strictEqual(outcome._tag, "advanced");
    if (outcome._tag === "advanced") {
      assert.strictEqual(outcome.candidateId, first.candidate.id);
    }
    const stillQueued = yield* fixture.service.getCandidate(second.candidate.id);
    assert.strictEqual(stillQueued?.status, "queued");

    const runningRows = yield* fixture.sql<{ readonly n: number }>`
      SELECT COUNT(*) AS n FROM ade_integration_candidates
      WHERE project_id = ${fixture.projectId} AND status = 'running'
    `;
    assert.strictEqual(runningRows[0]?.n, 0);
  }),
);

scenario("a kill mid-run converges: the queue head re-runs from scratch", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "automatic" });

    // Crash between steps: the workspace step failed hard, leaving a running
    // row (this is exactly the state a `kill -9` leaves behind).
    yield* Ref.update(fixture.state, (value) => ({ ...value, prepareFails: true }));
    const enqueued = yield* enqueue(fixture, { declaredRisk: "mechanical" });
    const deferred = yield* fixture.service.processQueueHead(fixture.projectId);
    assert.strictEqual(deferred._tag, "deferred");
    const afterCrash = yield* fixture.service.getCandidate(enqueued.candidate.id);
    // No bounce: the author did nothing wrong, so the candidate stays queued.
    assert.strictEqual(afterCrash?.status, "queued");

    // Simulate a hard kill that left the row `running` with no process behind
    // it, then restart recovery.
    yield* fixture.sql`
      UPDATE ade_integration_candidates SET status = 'running'
      WHERE integration_candidate_id = ${enqueued.candidate.id}
    `;
    const recovered = yield* fixture.service.recoverRunningCandidates();
    assert.deepEqual(recovered.requeued, [enqueued.candidate.id]);
    const afterRecovery = yield* fixture.service.getCandidate(enqueued.candidate.id);
    assert.strictEqual(afterRecovery?.status, "queued");

    // The re-run converges: every step executes again from scratch and the
    // candidate integrates exactly once.
    yield* Ref.update(fixture.state, (value) => ({ ...value, prepareFails: false }));
    const rerun = yield* fixture.service.runOnce();
    assert.deepEqual(rerun.projects, [fixture.projectId]);
    const settled = yield* fixture.service.getCandidate(enqueued.candidate.id);
    assert.strictEqual(settled?.status, "integrated");

    const state = yield* Ref.get(fixture.state);
    // Steps are idempotent and re-ran; canonical advanced exactly once.
    assert.isAtLeast(state.syncCalls, 2);
    assert.isAtLeast(state.prepareCalls, 2);
    assert.deepEqual(state.advanceCalls, ["zkmqwpxr"]);

    // A further sweep is a no-op — the durable commit point already happened.
    yield* fixture.service.runOnce();
    const stateAfter = yield* Ref.get(fixture.state);
    assert.deepEqual(stateAfter.advanceCalls, ["zkmqwpxr"]);
  }),
);

scenario("recovery leaves gate-parked candidates alone", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    const enqueued = yield* enqueue(fixture);
    yield* fixture.service.processQueueHead(fixture.projectId);
    assert.strictEqual(
      (yield* fixture.service.getCandidate(enqueued.candidate.id))?.status,
      "awaiting-review",
    );

    const recovered = yield* fixture.service.recoverRunningCandidates();
    assert.deepEqual(recovered.requeued, []);
    const parked = yield* fixture.service.getCandidate(enqueued.candidate.id);
    // The verdict it waits for is still coming; re-running would discard it.
    assert.strictEqual(parked?.status, "awaiting-review");
  }),
);

// ---------------------------------------------------------------------------
// Enqueue + housekeeping
// ---------------------------------------------------------------------------

scenario("enqueue is idempotent per project and refuses unbound projects", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    const first = yield* enqueue(fixture, { key: "shared" });
    const replay = yield* enqueue(fixture, { key: "shared", changeIds: ["different"] });
    assert.isTrue(first.created);
    assert.isFalse(replay.created);
    assert.strictEqual(replay.candidate.id, first.candidate.id);
    assert.deepEqual(replay.candidate.changeIds, first.candidate.changeIds);

    const empty = yield* fixture.service
      .enqueueCandidate({
        projectId: fixture.projectId,
        sourceAssignmentIds: [],
        changeIds: [],
        originatingBotId: fixture.coderBotId,
      })
      .pipe(Effect.flip);
    assert.strictEqual(empty._tag, "AdeIntegrationCandidateEmptyError");

    const unbound = yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO ade_projects (
          project_id, name, second_mate_bot_id, integration_policy_default,
          created_at, updated_at
        ) VALUES ('project-unbound', 'Research', ${fixture.secondMateBotId}, 'agent-review',
                  '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z')
      `;
      return yield* fixture.service
        .enqueueCandidate({
          projectId: "project-unbound" as AdeProjectId,
          sourceAssignmentIds: [],
          changeIds: ["zkmqwpxr"],
          originatingBotId: fixture.coderBotId,
        })
        .pipe(Effect.flip);
    });
    assert.strictEqual(unbound._tag, "AdeIntegrationProjectNotRepoBoundError");
  }),
);

scenario("explicit upstream sync refuses to move canonical under a running pass", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    const enqueued = yield* enqueue(fixture);
    yield* fixture.sql`
      UPDATE ade_integration_candidates SET status = 'running'
      WHERE integration_candidate_id = ${enqueued.candidate.id}
    `;
    const busy = yield* fixture.service.syncUpstream(fixture.projectId).pipe(Effect.flip);
    assert.strictEqual(busy._tag, "AdeIntegrationBusyError");

    yield* fixture.sql`
      UPDATE ade_integration_candidates SET status = 'queued'
      WHERE integration_candidate_id = ${enqueued.candidate.id}
    `;
    const synced = yield* fixture.service.syncUpstream(fixture.projectId);
    assert.deepEqual(synced, { advanced: false, conflictDetail: null });
  }),
);

scenario("releases a bounced candidate's retained workspace on explicit cleanup", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "automatic" });
    yield* Ref.update(fixture.state, (value) => ({ ...value, prepareConflict: "conflict" }));
    const enqueued = yield* enqueue(fixture, { declaredRisk: "mechanical" });
    yield* fixture.service.processQueueHead(fixture.projectId);

    const bounced = yield* fixture.service.getCandidate(enqueued.candidate.id);
    assert.isNotNull(bounced?.workspacePath);

    const cleaned = yield* fixture.service.cleanupCandidateWorkspace(enqueued.candidate.id);
    assert.strictEqual(cleaned.workspacePath, null);
    // Cleanup does not resurrect the candidate.
    assert.strictEqual(cleaned.status, "bounced");
    const state = yield* Ref.get(fixture.state);
    assert.strictEqual(state.cleanupCalls.length, 1);

    const listed = yield* fixture.service.listCandidates(fixture.projectId, {
      statuses: ["bounced"],
    });
    assert.strictEqual(listed.length, 1);
  }),
);
