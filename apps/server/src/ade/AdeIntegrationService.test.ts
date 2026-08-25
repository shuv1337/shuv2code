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
  /** Yield inside the workspace step so concurrent passes actually interleave. */
  slowPrepare: boolean;
  /** Heads canonical already contains — the "already landed" ancestry answer. */
  canonicalContains: ReadonlyArray<string>;
  /** When false, canonical has moved somewhere the head does not descend from. */
  fastForwardable: boolean;
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
  slowPrepare: false,
  canonicalContains: [],
  fastForwardable: true,
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
        if (current.slowPrepare) yield* Effect.yieldNow;
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
    canonicalState: (input) =>
      Effect.gen(function* () {
        const current = yield* Ref.get(state);
        return {
          containsHead: current.canonicalContains.includes(input.headRevision),
          fastForwardable: current.fastForwardable,
          canonicalCommitId: "canonical-commit",
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
        if (current.canonicalContains.includes(input.headRevision)) {
          return { _tag: "already-integrated", canonicalCommitId: "canonical-commit" } as const;
        }
        if (!current.fastForwardable) {
          return {
            _tag: "diverged",
            canonicalCommitId: "canonical-commit",
            detail: "canonical moved past this head",
          } as const;
        }
        yield* Ref.update(state, (value) => ({
          ...value,
          advanceCalls: [...value.advanceCalls, input.headRevision],
          canonicalContains: [...value.canonicalContains, input.headRevision],
        }));
        return { _tag: "advanced", canonicalCommitId: `commit-for-${input.headRevision}` } as const;
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

/**
 * Parking on the captain is only real if the captain can see it (spec §7
 * slice 5). The item is the durable half of that: one per waiting candidate,
 * retired the moment the candidate stops waiting — whichever surface produced
 * the verdict.
 */
scenario("raises one Needs You approval item while a candidate waits, and retires it", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "human-approval" });
    const enqueued = yield* enqueue(fixture);
    yield* fixture.service.processQueueHead(fixture.projectId);

    const openItems = () =>
      fixture.sql<{
        readonly needs_you_item_id: string;
        readonly subject_refs_json: string;
      }>`SELECT needs_you_item_id, subject_refs_json FROM ade_needs_you_items
         WHERE kind = 'approval' AND status = 'open'`;

    const raised = yield* openItems();
    assert.strictEqual(raised.length, 1);
    assert.include(raised[0]?.subject_refs_json ?? "", enqueued.candidate.id);

    // Re-running the pass must not pile up a second row: recovery re-derives
    // parking from scratch (ADR §16.2 has no journal).
    yield* fixture.service.processQueueHead(fixture.projectId);
    assert.strictEqual((yield* openItems()).length, 1);

    yield* fixture.service.submitApproval({
      candidateId: enqueued.candidate.id,
      decision: "approve",
    });
    assert.strictEqual((yield* openItems()).length, 0);
  }),
);

/**
 * The two crash windows around the item (D2). A trigger stands in for the
 * process dying between the two writes: whatever the second statement is, if it
 * cannot land then neither may the first — the split states are both
 * unrecoverable.
 */
scenario("parks the candidate and raises its item atomically, or does neither", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "human-approval" });
    const enqueued = yield* enqueue(fixture);
    yield* fixture.sql`
      CREATE TRIGGER simulated_crash_on_item_insert
      BEFORE INSERT ON ade_needs_you_items
      BEGIN SELECT RAISE(ABORT, 'simulated crash'); END
    `;

    const outcome = yield* Effect.result(fixture.service.processQueueHead(fixture.projectId));
    assert.strictEqual(outcome._tag, "Failure");

    // A candidate parked on `awaiting-approval` with no item is invisible
    // forever: recovery only re-queues `running` rows, and the queue pass
    // short-circuits on a candidate already sitting on its gate.
    const candidate = yield* fixture.service.getCandidate(enqueued.candidate.id);
    assert.notStrictEqual(candidate?.status, "awaiting-approval");
    const items = yield* fixture.sql<{
      readonly needs_you_item_id: string;
    }>`SELECT needs_you_item_id FROM ade_needs_you_items WHERE kind = 'approval'`;
    assert.strictEqual(items.length, 0);
  }),
);

scenario("records the verdict and retires its item atomically, or does neither", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "human-approval" });
    const enqueued = yield* enqueue(fixture);
    yield* fixture.service.processQueueHead(fixture.projectId);
    yield* fixture.sql`
      CREATE TRIGGER simulated_crash_on_item_resolve
      BEFORE UPDATE OF status ON ade_needs_you_items
      WHEN NEW.status = 'resolved'
      BEGIN SELECT RAISE(ABORT, 'simulated crash'); END
    `;

    const outcome = yield* Effect.result(
      fixture.service.submitApproval({ candidateId: enqueued.candidate.id, decision: "approve" }),
    );
    assert.strictEqual(outcome._tag, "Failure");

    // The inverse split is what feeds D1: a candidate recorded as decided while
    // its item stays open can never have that item retired, because
    // `claimForVerdict` is the item's only retire path and the candidate has
    // left the state that reaches it.
    const candidate = yield* fixture.service.getCandidate(enqueued.candidate.id);
    assert.strictEqual(candidate?.status, "awaiting-approval");
    assert.strictEqual(candidate?.verdict, null);
    const open = yield* fixture.sql<{
      readonly needs_you_item_id: string;
    }>`SELECT needs_you_item_id FROM ade_needs_you_items WHERE kind = 'approval' AND status = 'open'`;
    assert.strictEqual(open.length, 1);
  }),
);

/**
 * D1(a): past the claim the verdict is durable and the item already retired, so
 * a persistence failure is the sweeper's problem, not the captain's. Failing
 * here would tell them their approval bounced and send the inbox reopening an
 * item that can never be retired again.
 */
scenario("reports success when the verdict is durable but could not yet be applied", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "human-approval" });
    const enqueued = yield* enqueue(fixture);
    yield* fixture.service.processQueueHead(fixture.projectId);
    // Fails everything `applyVerdict` writes, and only that: the claim's own
    // update sets `status = 'running'`, which this trigger lets through.
    yield* fixture.sql`
      CREATE TRIGGER simulated_busy_after_claim
      BEFORE UPDATE OF status ON ade_integration_candidates
      WHEN NEW.status IN ('integrated', 'bounced', 'queued')
      BEGIN SELECT RAISE(ABORT, 'database is locked'); END
    `;

    const settled = yield* fixture.service.submitApproval({
      candidateId: enqueued.candidate.id,
      decision: "approve",
    });

    // The captain is told the approval landed, because it did.
    assert.strictEqual(settled.verdict, "approved");
    // The item is gone, and stays gone.
    const open = yield* fixture.sql<{
      readonly needs_you_item_id: string;
    }>`SELECT needs_you_item_id FROM ade_needs_you_items WHERE kind = 'approval' AND status = 'open'`;
    assert.strictEqual(open.length, 0);
    // And the candidate sits `running` with a durable verdict, exactly where
    // the sweeper picks it up (ADR §16.2).
    const candidate = yield* fixture.service.getCandidate(enqueued.candidate.id);
    assert.strictEqual(candidate?.status, "running");
    assert.strictEqual(candidate?.verdict, "approved");
  }),
);

scenario("retires the approval item on a denial too", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "human-approval" });
    const enqueued = yield* enqueue(fixture);
    yield* fixture.service.processQueueHead(fixture.projectId);

    const denied = yield* fixture.service.submitApproval({
      candidateId: enqueued.candidate.id,
      decision: "deny",
    });
    assert.strictEqual(denied.status, "bounced");

    const stillOpen = yield* fixture.sql<{
      readonly needs_you_item_id: string;
    }>`SELECT needs_you_item_id FROM ade_needs_you_items WHERE kind = 'approval' AND status = 'open'`;
    assert.strictEqual(stillOpen.length, 0);
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
    const replay = yield* enqueue(fixture, { key: "shared", changeIds: ["wwwwwwww"] });
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

// ---------------------------------------------------------------------------
// Regressions: canonical safety, crash convergence, and injection (review #187)
// ---------------------------------------------------------------------------

scenario("D1: never moves canonical backwards when it advanced under a parked gate", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    const enqueued = yield* enqueue(fixture);
    yield* fixture.service.processQueueHead(fixture.projectId);
    assert.strictEqual(
      (yield* fixture.service.getCandidate(enqueued.candidate.id))?.status,
      "awaiting-review",
    );

    // The explicit sync operation refuses outright while a candidate is parked:
    // that candidate was rebased onto the canonical the sync would move.
    const refused = yield* fixture.service.syncUpstream(fixture.projectId).pipe(Effect.flip);
    assert.strictEqual(refused._tag, "AdeIntegrationBusyError");

    // Now simulate canonical having advanced anyway (a sync that slipped past,
    // or any other advancement): the candidate's head no longer descends from
    // canonical, so approval must NOT reset the bookmark to it.
    yield* Ref.update(fixture.state, (value) => ({ ...value, fastForwardable: false }));
    const approved = yield* fixture.service.submitReview({
      candidateId: enqueued.candidate.id,
      reviewerBotId: fixture.secondMateBotId,
      decision: "approve",
    });
    assert.strictEqual(approved.status, "queued");
    assert.strictEqual(approved.verdict, "approved");
    const diverged = yield* Ref.get(fixture.state);
    assert.deepEqual(diverged.advanceCalls, []);

    // The re-run rebases onto the new canonical and applies the recorded
    // verdict without re-asking the reviewer.
    yield* Ref.update(fixture.state, (value) => ({ ...value, fastForwardable: true }));
    yield* fixture.service.runOnce();
    const settled = yield* fixture.service.getCandidate(enqueued.candidate.id);
    assert.strictEqual(settled?.status, "integrated");
    const after = yield* Ref.get(fixture.state);
    assert.deepEqual(after.advanceCalls, ["zkmqwpxr"]);
  }),
);

scenario("D2: a kill after canonical advanced converges without a bogus bounce", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "automatic" });
    const enqueued = yield* enqueue(fixture, { declaredRisk: "mechanical" });

    // The pass advanced canonical and died before writing the status: the row
    // is still `running` while the repository already contains the change.
    yield* Ref.update(fixture.state, (value) => ({
      ...value,
      canonicalContains: ["zkmqwpxr"],
    }));
    yield* fixture.sql`
      UPDATE ade_integration_candidates
      SET status = 'running', lease_holder = NULL, lease_expires_at = NULL
      WHERE integration_candidate_id = ${enqueued.candidate.id}
    `;

    const outcome = yield* fixture.service.processQueueHead(fixture.projectId);
    assert.deepEqual(outcome, {
      _tag: "advanced",
      candidateId: enqueued.candidate.id,
      status: "integrated",
    });
    const settled = yield* fixture.service.getCandidate(enqueued.candidate.id);
    assert.strictEqual(settled?.status, "integrated");
    assert.strictEqual(settled?.bounce, null);
    assert.strictEqual(settled?.repairAssignmentId, null);

    const state = yield* Ref.get(fixture.state);
    // Re-derived from ancestry: no second advance, and no rebase that would
    // have surfaced as "cannot rebase onto descendant" and bounced the author.
    assert.deepEqual(state.advanceCalls, []);
    assert.strictEqual(state.prepareCalls, 0);
    const repairs = yield* fixture.assignments.listForBot(fixture.coderBotId);
    assert.strictEqual(repairs.length, 0);
  }),
);

scenario("D3: a kill inside the approval path recovers and unblocks the queue", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    const first = yield* enqueue(fixture, { key: "a" });
    const second = yield* enqueue(fixture, { key: "b", changeIds: ["qwlnnmts"] });
    yield* fixture.service.processQueueHead(fixture.projectId);

    // The verdict is claimed onto the row, then the process dies before
    // canonical moves. The row is `running` with an expired lease.
    yield* fixture.sql`
      UPDATE ade_integration_candidates
      SET status = 'running', verdict = 'approved', verdict_at = '2026-08-24T00:00:00.000Z',
          lease_holder = 'dead-worker', lease_expires_at = '1969-01-01T00:00:00.000Z'
      WHERE integration_candidate_id = ${first.candidate.id}
    `;

    const recovered = yield* fixture.service.recoverRunningCandidates();
    assert.deepEqual(recovered.requeued, [first.candidate.id]);

    yield* fixture.service.runOnce();
    const settled = yield* fixture.service.getCandidate(first.candidate.id);
    assert.strictEqual(settled?.status, "integrated");
    const state = yield* Ref.get(fixture.state);
    assert.deepEqual(state.advanceCalls, ["zkmqwpxr"]);

    // The queue is unblocked: the next candidate proceeds.
    yield* fixture.service.processQueueHead(fixture.projectId);
    const next = yield* fixture.service.getCandidate(second.candidate.id);
    assert.strictEqual(next?.status, "awaiting-review");
  }),
);

scenario("D4: two workers cannot adopt the same running candidate", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "automatic" });
    const enqueued = yield* enqueue(fixture, { declaredRisk: "mechanical" });
    yield* Ref.update(fixture.state, (value) => ({ ...value, slowPrepare: true }));
    yield* fixture.sql`
      UPDATE ade_integration_candidates
      SET status = 'running', lease_holder = 'dead-worker',
          lease_expires_at = '1969-01-01T00:00:00.000Z'
      WHERE integration_candidate_id = ${enqueued.candidate.id}
    `;

    const [left, right] = yield* Effect.all(
      [
        fixture.service.processQueueHead(fixture.projectId),
        fixture.service.processQueueHead(fixture.projectId),
      ],
      { concurrency: 2 },
    );
    const tags = [left._tag, right._tag].sort();
    assert.deepEqual(tags, ["advanced", "busy"]);

    const state = yield* Ref.get(fixture.state);
    // One pass, one workspace, one advance.
    assert.strictEqual(state.prepareCalls, 1);
    assert.deepEqual(state.advanceCalls, ["zkmqwpxr"]);

    // A live lease is respected too: nobody adopts a healthy running row.
    yield* fixture.sql`
      UPDATE ade_integration_candidates
      SET status = 'running', lease_holder = 'live-worker',
          lease_expires_at = '2999-01-01T00:00:00.000Z'
      WHERE integration_candidate_id = ${enqueued.candidate.id}
    `;
    const blocked = yield* fixture.service.processQueueHead(fixture.projectId);
    assert.deepEqual(blocked, { _tag: "busy" });
    const untouched = yield* fixture.service.recoverRunningCandidates();
    assert.deepEqual(untouched.requeued, []);
  }),
);

scenario("D5: hostile change ids are refused at enqueue and never reach the port", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "automatic" });
    for (const hostile of ["all()", "root()", "--help", "zkmqwpxr | all()", "abc", ""]) {
      const refused = yield* fixture.service
        .enqueueCandidate({
          projectId: fixture.projectId,
          sourceAssignmentIds: [],
          changeIds: [hostile],
          originatingBotId: fixture.coderBotId,
          idempotencyKey: `hostile-${hostile}`,
        })
        .pipe(Effect.flip);
      assert.oneOf(refused._tag, [
        "AdeIntegrationChangeIdInvalidError",
        "AdeIntegrationCandidateEmptyError",
      ]);
    }
    const queued = yield* fixture.service.listCandidates(fixture.projectId);
    assert.strictEqual(queued.length, 0);
    const state = yield* Ref.get(fixture.state);
    assert.strictEqual(state.prepareCalls, 0);
    assert.strictEqual(state.syncCalls, 0);
  }),
);

scenario("D6: the designated Reviewer is matched by role-tag word, not equality", () =>
  Effect.gen(function* () {
    const fixture = yield* setup();
    yield* fixture.sql`
      INSERT INTO ade_bots (bot_id, name, structural_role, role_tag, project_id, created_at)
      VALUES ('bot-lower', 'Rev', 'crew', '  reviewer ', ${fixture.projectId},
              '2026-08-24T00:00:00.000Z')
    `;
    const first = yield* enqueue(fixture, { key: "a" });
    yield* fixture.service.processQueueHead(fixture.projectId);
    assert.strictEqual(
      (yield* fixture.service.getCandidate(first.candidate.id))?.reviewerBotId,
      "bot-lower",
    );
    yield* fixture.service.submitReview({
      candidateId: first.candidate.id,
      reviewerBotId: "bot-lower" as BotId,
      decision: "approve",
    });

    // A suffixed tag is still the project's reviewer.
    yield* fixture.sql`
      UPDATE ade_bots SET archived_at = '2026-08-24T00:00:00.000Z' WHERE bot_id = 'bot-lower'
    `;
    yield* fixture.sql`
      INSERT INTO ade_bots (bot_id, name, structural_role, role_tag, project_id, created_at)
      VALUES ('bot-code-reviewer', 'Rev2', 'crew', 'Code Reviewer', ${fixture.projectId},
              '2026-08-24T00:00:01.000Z')
    `;
    const second = yield* enqueue(fixture, { key: "b", changeIds: ["qwlnnmts"] });
    yield* fixture.service.processQueueHead(fixture.projectId);
    assert.strictEqual(
      (yield* fixture.service.getCandidate(second.candidate.id))?.reviewerBotId,
      "bot-code-reviewer",
    );
  }),
);

scenario("D7: a repair that cannot be emitted blocks the bounce until it can", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "automatic" });
    yield* Ref.update(fixture.state, (value) => ({ ...value, prepareConflict: "conflict" }));

    // Squeeze the recipient's queue so repair creation fails transiently.
    yield* fixture.sql`
      UPDATE ade_limits_config
      SET config_json = '{"maxQueuedAssignmentsPerBot":1}'
      WHERE id = 1
    `;
    yield* fixture.assignments.createAssignment({
      requester: { _tag: "captain" },
      recipientBotId: fixture.coderBotId,
      instruction: "occupy the queue",
      idempotencyKey: "occupier",
    });

    const enqueued = yield* enqueue(fixture, { declaredRisk: "mechanical" });
    const deferred = yield* fixture.service.processQueueHead(fixture.projectId);
    assert.strictEqual(deferred._tag, "deferred");
    const notBounced = yield* fixture.service.getCandidate(enqueued.candidate.id);
    // The candidate is NOT settled bounced without its repair.
    assert.strictEqual(notBounced?.status, "queued");
    assert.strictEqual(notBounced?.bounce, null);

    yield* fixture.sql`
      UPDATE ade_limits_config SET config_json = '{}' WHERE id = 1
    `;
    yield* fixture.service.runOnce();
    const bounced = yield* fixture.service.getCandidate(enqueued.candidate.id);
    assert.strictEqual(bounced?.status, "bounced");
    assert.isNotNull(bounced?.repairAssignmentId);
    const repairs = yield* fixture.assignments.listForBot(fixture.coderBotId);
    // Exactly one repair, not one per attempt.
    assert.strictEqual(
      repairs.filter((assignment) =>
        assignment.idempotencyKey.startsWith("ade-integration-repair:"),
      ).length,
      1,
    );
  }),
);

scenario("D7: an unroutable author raises a Needs You item instead of a log line", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "automatic" });
    yield* Ref.update(fixture.state, (value) => ({ ...value, prepareConflict: "conflict" }));
    const enqueued = yield* enqueue(fixture, { declaredRisk: "mechanical" });
    yield* fixture.sql`
      UPDATE ade_bots SET archived_at = '2026-08-24T00:00:00.000Z'
      WHERE bot_id = ${fixture.coderBotId}
    `;

    yield* fixture.service.processQueueHead(fixture.projectId);
    const bounced = yield* fixture.service.getCandidate(enqueued.candidate.id);
    assert.strictEqual(bounced?.status, "bounced");
    assert.strictEqual(bounced?.repairAssignmentId, null);

    const items = yield* fixture.sql<{
      readonly needs_you_item_id: string;
      readonly subject_refs_json: string;
    }>`
      SELECT needs_you_item_id, subject_refs_json FROM ade_needs_you_items
      WHERE kind = 'stall' AND status = 'open'
    `;
    assert.strictEqual(items.length, 1);
    assert.include(items[0]?.subject_refs_json ?? "", enqueued.candidate.id);
  }),
);

scenario("D8: a bounced candidate does not burn its idempotency key", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "automatic" });
    yield* Ref.update(fixture.state, (value) => ({ ...value, prepareConflict: "conflict" }));
    const first = yield* enqueue(fixture, { declaredRisk: "mechanical", key: "toolcall-1" });
    yield* fixture.service.processQueueHead(fixture.projectId);
    assert.strictEqual(
      (yield* fixture.service.getCandidate(first.candidate.id))?.status,
      "bounced",
    );

    // The repaired change comes back under the same tool-call-derived key.
    yield* Ref.update(fixture.state, (value) => ({ ...value, prepareConflict: null }));
    const repaired = yield* enqueue(fixture, { declaredRisk: "mechanical", key: "toolcall-1" });
    assert.isTrue(repaired.created);
    assert.notStrictEqual(repaired.candidate.id, first.candidate.id);
    assert.strictEqual(repaired.candidate.status, "queued");

    yield* fixture.service.processQueueHead(fixture.projectId);
    assert.strictEqual(
      (yield* fixture.service.getCandidate(repaired.candidate.id))?.status,
      "integrated",
    );

    // An integrated candidate frees the key too.
    const again = yield* enqueue(fixture, { declaredRisk: "mechanical", key: "toolcall-1" });
    assert.isTrue(again.created);
  }),
);

scenario("minor: repeat-bounce detection ignores change-id order", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "automatic" });
    yield* Ref.update(fixture.state, (value) => ({ ...value, prepareConflict: "conflict" }));

    yield* enqueue(fixture, {
      declaredRisk: "mechanical",
      key: "a",
      changeIds: ["zkmqwpxr", "qwlnnmts"],
    });
    yield* fixture.service.processQueueHead(fixture.projectId);
    yield* enqueue(fixture, {
      declaredRisk: "mechanical",
      key: "b",
      changeIds: ["qwlnnmts", "zkmqwpxr"],
    });
    yield* fixture.service.processQueueHead(fixture.projectId);

    const notices = yield* fixture.assignments.listForBot(fixture.secondMateBotId);
    assert.strictEqual(notices.length, 1);
    assert.include(notices[0]?.instruction ?? "", "bounced 2 times");
  }),
);

scenario("minor: the retention sweep reclaims aged forensic workspaces", () =>
  Effect.gen(function* () {
    const fixture = yield* setup({ integrationPolicyDefault: "automatic" });
    yield* Ref.update(fixture.state, (value) => ({ ...value, prepareConflict: "conflict" }));
    const enqueued = yield* enqueue(fixture, { declaredRisk: "mechanical" });
    yield* fixture.service.processQueueHead(fixture.projectId);
    assert.isNotNull((yield* fixture.service.getCandidate(enqueued.candidate.id))?.workspacePath);

    // Fresh bounces are kept for forensics.
    const untouched = yield* fixture.service.sweepRetainedWorkspaces();
    assert.deepEqual(untouched.cleaned, []);

    yield* fixture.sql`
      UPDATE ade_integration_candidates SET updated_at = '1960-01-01T00:00:00.000Z'
      WHERE integration_candidate_id = ${enqueued.candidate.id}
    `;
    const swept = yield* fixture.service.sweepRetainedWorkspaces();
    assert.deepEqual(swept.cleaned, [enqueued.candidate.id]);
    const reclaimed = yield* fixture.service.getCandidate(enqueued.candidate.id);
    assert.strictEqual(reclaimed?.workspacePath, null);
    assert.strictEqual(reclaimed?.status, "bounced");
    const state = yield* Ref.get(fixture.state);
    assert.strictEqual(state.cleanupCalls.length, 1);
  }),
);
