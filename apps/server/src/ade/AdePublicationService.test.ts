/**
 * State-machine coverage for the ADE publication service (spec §4.5, ADR §8,
 * §16.3 — issue #165). The jj and `gh` mechanics ride a programmable stub port
 * so every transition, adoption, and recovery path is deterministic; the real
 * half is covered by `AdePublicationRepoPort.runtime.test.ts`.
 *
 * The stub records the *order* of the operations it is asked to perform, which
 * is what lets these tests assert the converge-then-act invariant directly:
 * "fetch, then read GitHub, then act" is a property of the sequence, not of any
 * single call.
 */
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { AdeProjectId, PublicationLayerId, PublicationStackId } from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { AdeAssignmentEngine, AdeAssignmentKernelPort } from "./AdeAssignmentEngine.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import {
  AdePublicationRepoError,
  AdePublicationRepoPort,
  type AdePublicationRepoPortShape,
  type PublishedPullRequest,
} from "./AdePublicationRepoPort.ts";
import { AdePublicationService } from "./AdePublicationService.ts";

const REPO_PATH = "/tmp/ade-publication-test/repo";

interface StubState {
  /** Every port operation, in order — the converge-then-act evidence. */
  calls: Array<string>;
  /** What GitHub currently shows, keyed by head branch. */
  pullRequests: Record<string, ReadonlyArray<PublishedPullRequest>>;
  /** SHAs the fetched base contains. */
  landedShas: ReadonlyArray<string>;
  /** Bookmark -> commit id, as the port would place them. */
  bookmarkShas: Record<string, string>;
  nativeStackNumber: number | null;
  fetchFails: boolean;
  refreshConflict: string | null;
  pushedBookmarks: Array<ReadonlyArray<string>>;
  linkedBookmarks: Array<ReadonlyArray<string>>;
  deletedBookmarks: Array<ReadonlyArray<string>>;
  retargets: Array<{ prNumber: number; baseBranch: string }>;
  createdPrs: Array<{ bookmarkName: string; baseBranch: string }>;
  mergedStacks: Array<number>;
  workingCopyCommitId: string;
}

const initialStubState = (): StubState => ({
  calls: [],
  pullRequests: {},
  landedShas: [],
  bookmarkShas: {},
  nativeStackNumber: null,
  fetchFails: false,
  refreshConflict: null,
  pushedBookmarks: [],
  linkedBookmarks: [],
  deletedBookmarks: [],
  retargets: [],
  createdPrs: [],
  mergedStacks: [],
  workingCopyCommitId: "workingcopy0000",
});

const makeStubPort = Effect.gen(function* () {
  const state = yield* Ref.make<StubState>(initialStubState());
  const record = (name: string) =>
    Ref.update(state, (value) => ({ ...value, calls: [...value.calls, name] }));

  const shape: AdePublicationRepoPortShape = {
    fetch: () =>
      Effect.gen(function* () {
        yield* record("fetch");
        const current = yield* Ref.get(state);
        if (current.fetchFails) {
          return yield* new AdePublicationRepoError({
            operation: "fetch",
            detail: "stubbed fetch failure",
          });
        }
      }),
    readPullRequestsByHeadBranch: (input) =>
      Effect.gen(function* () {
        yield* record("readPullRequestsByHeadBranch");
        const current = yield* Ref.get(state);
        return input.bookmarkNames.flatMap((name) => current.pullRequests[name] ?? []);
      }),
    ensureBookmark: (input) =>
      Effect.gen(function* () {
        yield* record("ensureBookmark");
        const current = yield* Ref.get(state);
        const existing = current.bookmarkShas[input.bookmarkName];
        const headSha = `sha-${input.changeId}`;
        yield* Ref.update(state, (value) => ({
          ...value,
          bookmarkShas: { ...value.bookmarkShas, [input.bookmarkName]: headSha },
        }));
        return {
          headSha,
          recreated: existing === undefined,
          moved: existing !== undefined && existing !== headSha,
        };
      }),
    readBookmarkSha: (input) =>
      Effect.gen(function* () {
        yield* record("readBookmarkSha");
        const current = yield* Ref.get(state);
        return current.bookmarkShas[input.bookmarkName] ?? null;
      }),
    pushBookmarks: (input) =>
      Effect.gen(function* () {
        yield* record("pushBookmarks");
        yield* Ref.update(state, (value) => ({
          ...value,
          pushedBookmarks: [...value.pushedBookmarks, input.bookmarkNames],
        }));
      }),
    deleteBookmarks: (input) =>
      Effect.gen(function* () {
        yield* record("deleteBookmarks");
        yield* Ref.update(state, (value) => ({
          ...value,
          deletedBookmarks: [...value.deletedBookmarks, input.bookmarkNames],
        }));
      }),
    linkStack: (input) =>
      Effect.gen(function* () {
        yield* record("linkStack");
        yield* Ref.update(state, (value) => ({
          ...value,
          linkedBookmarks: [...value.linkedBookmarks, input.bookmarkNames],
        }));
      }),
    readNativeStacks: () =>
      Effect.gen(function* () {
        yield* record("readNativeStacks");
        const current = yield* Ref.get(state);
        return current.nativeStackNumber === null
          ? []
          : [
              {
                number: current.nativeStackNumber,
                nodeId: "PRS_stub",
                url: `https://github.test/stacks/${current.nativeStackNumber}`,
                open: true,
                pullRequestNumbers: Object.values(current.pullRequests)
                  .flat()
                  .map((entry) => entry.number),
              },
            ];
      }),
    markPullRequestsReady: () => record("markPullRequestsReady"),
    mergeStack: (input) =>
      Effect.gen(function* () {
        yield* record("mergeStack");
        yield* Ref.update(state, (value) => ({
          ...value,
          mergedStacks: [...value.mergedStacks, input.stackNumber],
        }));
      }),
    createPullRequest: (input) =>
      Effect.gen(function* () {
        yield* record("createPullRequest");
        yield* Ref.update(state, (value) => ({
          ...value,
          createdPrs: [
            ...value.createdPrs,
            { bookmarkName: input.bookmarkName, baseBranch: input.baseBranch },
          ],
        }));
      }),
    retargetPullRequest: (input) =>
      Effect.gen(function* () {
        yield* record("retargetPullRequest");
        yield* Ref.update(state, (value) => ({
          ...value,
          retargets: [
            ...value.retargets,
            { prNumber: input.prNumber, baseBranch: input.baseBranch },
          ],
        }));
      }),
    mergePullRequest: () => record("mergePullRequest"),
    landedShas: (input) =>
      Effect.gen(function* () {
        yield* record("landedShas");
        const current = yield* Ref.get(state);
        return input.shas.filter((sha) => current.landedShas.includes(sha));
      }),
    refreshStack: () =>
      Effect.gen(function* () {
        yield* record("refreshStack");
        const current = yield* Ref.get(state);
        return {
          rebased: current.refreshConflict === null,
          conflictDetail: current.refreshConflict,
        };
      }),
    workingCopyFingerprint: () =>
      Effect.gen(function* () {
        yield* record("workingCopyFingerprint");
        const current = yield* Ref.get(state);
        return { commitId: current.workingCopyCommitId, changeId: "wcchange" };
      }),
  };

  return { state, layer: Layer.succeed(AdePublicationRepoPort, shape) };
});

interface Fixture {
  readonly sql: SqlClient.SqlClient;
  readonly service: AdePublicationService["Service"];
  readonly state: Ref.Ref<StubState>;
  readonly projectId: AdeProjectId;
}

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`PRAGMA foreign_keys = ON`;

  const stub = yield* makeStubPort;
  const context = yield* Layer.build(
    AdePublicationService.layer.pipe(
      Layer.provideMerge(AdeBootstrap.layer),
      Layer.provideMerge(AdeAssignmentEngine.layer),
      Layer.provide(stub.layer),
      Layer.provide(AdeAssignmentKernelPort.layerUnwired),
      Layer.provide(Path.layer),
    ),
  );
  const service = yield* Effect.service(AdePublicationService).pipe(Effect.provide(context));
  const bootstrap = yield* Effect.service(AdeBootstrap).pipe(Effect.provide(context));

  yield* bootstrap.ensureSeeded();
  const project = yield* bootstrap.createProject({
    name: "Publication project",
    repoBinding: { path: REPO_PATH, remote: "origin" },
  });

  return {
    sql,
    service,
    state: stub.state,
    projectId: project.projectId,
  } satisfies Fixture;
});

const scenario = <A, E>(
  name: string,
  body: () => Effect.Effect<A, E, SqlClient.SqlClient | Scope.Scope>,
) => it.effect(name, () => Effect.scoped(Effect.provide(body(), NodeSqliteClient.layerMemory())));

const pr = (
  overrides: Partial<PublishedPullRequest> & { readonly headRefName: string },
): PublishedPullRequest => ({
  number: 1,
  baseRefName: "main",
  state: "open",
  isDraft: false,
  headSha: null,
  mergeSha: null,
  ...overrides,
});

/** Seed an integrated candidate so `adoptIntegratedCandidates` has something. */
const seedIntegratedCandidate = (
  fixture: Fixture,
  candidateId: string,
  changeIds: ReadonlyArray<string>,
) =>
  fixture.sql`
    INSERT INTO ade_integration_candidates (
      integration_candidate_id, project_id, idempotency_key,
      source_assignment_ids_json, change_ids_json, change_ids_key,
      originating_bot_id, declared_risk, status, gate, reviewer_bot_id,
      workspace_path, verdict, verdict_at, verdict_by_bot_id, verdict_detail,
      lease_holder, lease_expires_at,
      bounce_count, bounce_json, repair_assignment_id, created_at, updated_at
    )
    SELECT ${candidateId}, ${fixture.projectId}, ${candidateId},
      '[]', ${JSON.stringify(changeIds)}, ${changeIds.join("|")},
      second_mate_bot_id, 'normal', 'integrated', NULL, NULL,
      NULL, NULL, NULL, NULL, NULL,
      NULL, NULL,
      0, NULL, NULL, ${candidateId}, ${candidateId}
    FROM ade_projects WHERE project_id = ${fixture.projectId}
  `;

// ---------------------------------------------------------------------------
// Stack and layer bookkeeping
// ---------------------------------------------------------------------------

scenario("opening a stack is idempotent — one active stack per project", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const first = yield* fixture.service.openStack({ projectId: fixture.projectId });
    assert.isTrue(first.created);
    assert.strictEqual(first.stack.status, "building");
    assert.strictEqual(first.stack.mode, "native-stack");

    const second = yield* fixture.service.openStack({ projectId: fixture.projectId });
    assert.isFalse(second.created);
    assert.strictEqual(second.stack.id, first.stack.id);
  }),
);

scenario("a project with no remote cannot open a stack", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* fixture.sql`
      UPDATE ade_projects SET repo_remote = NULL WHERE project_id = ${fixture.projectId}
    `;
    const refused = yield* fixture.service
      .openStack({ projectId: fixture.projectId })
      .pipe(Effect.flip);
    assert.strictEqual(refused._tag, "AdePublicationProjectNotPublishableError");
  }),
);

scenario("layers append in order and refuse change ids that are really revsets", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({ projectId: fixture.projectId });

    const first = yield* fixture.service.appendLayer({
      stackId: stack.id,
      changeIds: ["zkmqwpxr"],
    });
    const second = yield* fixture.service.appendLayer({
      stackId: stack.id,
      changeIds: ["ymvlrtsp"],
    });
    assert.strictEqual(first.order, 0);
    assert.strictEqual(second.order, 1);
    assert.notStrictEqual(first.bookmarkName, second.bookmarkName);

    for (const hostile of ["all()", "--help", "root()"]) {
      const refused = yield* fixture.service
        .appendLayer({ stackId: stack.id, changeIds: [hostile] })
        .pipe(Effect.flip);
      assert.strictEqual(refused._tag, "AdePublicationLayerInvalidError");
    }
    // A bookmark name that would glob inside `jj git push --bookmark`.
    const refusedBookmark = yield* fixture.service
      .appendLayer({ stackId: stack.id, changeIds: ["zkmqwpxr"], bookmarkName: "pub/*" })
      .pipe(Effect.flip);
    assert.strictEqual(refusedBookmark._tag, "AdePublicationLayerInvalidError");
  }),
);

scenario("integrated candidates become layers exactly once", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    yield* fixture.service.openStack({ projectId: fixture.projectId });
    yield* seedIntegratedCandidate(fixture, "cand-a", ["zkmqwpxr"]);
    yield* seedIntegratedCandidate(fixture, "cand-b", ["ymvlrtsp"]);

    const first = yield* fixture.service.adoptIntegratedCandidates(fixture.projectId);
    assert.strictEqual(first.appended.length, 2);

    // Re-running the sweep must not append the same work twice — the adoption
    // key is the candidate id, so this is idempotent by construction.
    const second = yield* fixture.service.adoptIntegratedCandidates(fixture.projectId);
    assert.deepEqual(second.appended, []);

    const view = yield* fixture.service.getActiveStack(fixture.projectId);
    assert.strictEqual(view?.layers.length, 2);
    assert.deepEqual(
      view?.layers.map((layer) => layer.order),
      [0, 1],
    );
  }),
);

scenario("reordering swaps layers through a temporary offset", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({ projectId: fixture.projectId });
    const a = yield* fixture.service.appendLayer({ stackId: stack.id, changeIds: ["zkmqwpxr"] });
    const b = yield* fixture.service.appendLayer({ stackId: stack.id, changeIds: ["ymvlrtsp"] });

    // A naive in-place exchange trips the unique (stack, layer_order) index;
    // this passing at all is the evidence that the offset staging works.
    const reordered = yield* fixture.service.reorderLayers({
      stackId: stack.id,
      layerIdsInOrder: [b.id, a.id],
    });
    assert.deepEqual(
      reordered.layers.map((layer) => layer.id),
      [b.id, a.id],
    );

    // Order freezes when review begins (ADR §8.3).
    yield* fixture.service.freezeStack(stack.id);
    const refused = yield* fixture.service
      .reorderLayers({ stackId: stack.id, layerIdsInOrder: [a.id, b.id] })
      .pipe(Effect.flip);
    assert.strictEqual(refused._tag, "AdePublicationStackStateError");
  }),
);

scenario("a partial reorder is refused rather than silently applied", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({ projectId: fixture.projectId });
    const a = yield* fixture.service.appendLayer({ stackId: stack.id, changeIds: ["zkmqwpxr"] });
    yield* fixture.service.appendLayer({ stackId: stack.id, changeIds: ["ymvlrtsp"] });

    const refused = yield* fixture.service
      .reorderLayers({ stackId: stack.id, layerIdsInOrder: [a.id] })
      .pipe(Effect.flip);
    assert.strictEqual(refused._tag, "AdePublicationLayerInvalidError");
  }),
);

// ---------------------------------------------------------------------------
// Invariant 1 — converge-then-act
// ---------------------------------------------------------------------------

scenario("every pass fetches and re-reads GitHub before it acts", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({ projectId: fixture.projectId });
    yield* fixture.service.appendLayer({ stackId: stack.id, changeIds: ["zkmqwpxr"] });

    yield* Ref.update(fixture.state, (value) => ({ ...value, calls: [] }));
    yield* fixture.service.processStack(stack.id);
    const calls = (yield* Ref.get(fixture.state)).calls;

    const fetchAt = calls.indexOf("fetch");
    const readAt = calls.indexOf("readPullRequestsByHeadBranch");
    const pushAt = calls.indexOf("pushBookmarks");
    const linkAt = calls.indexOf("linkStack");
    assert.isAtLeast(fetchAt, 0, "the pass must fetch");
    assert.isAtLeast(readAt, 0, "the pass must re-read GitHub");
    assert.isBelow(fetchAt, readAt, "GitHub was read against a stale local view");
    assert.isBelow(readAt, pushAt, "refs were published before GitHub state was known");
    assert.isBelow(readAt, linkAt, "the stack was linked before GitHub state was known");
  }),
);

scenario("a mechanical failure defers the pass and leaves the stack untouched", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({ projectId: fixture.projectId });
    yield* fixture.service.appendLayer({ stackId: stack.id, changeIds: ["zkmqwpxr"] });
    yield* Ref.update(fixture.state, (value) => ({ ...value, fetchFails: true }));

    const outcome = yield* fixture.service.processStack(stack.id);
    assert.strictEqual(outcome._tag, "deferred");
    const view = yield* fixture.service.getStack(stack.id);
    assert.strictEqual(view?.stack.status, "building");

    // The lease was released, so the next sweep can re-run immediately.
    yield* Ref.update(fixture.state, (value) => ({ ...value, fetchFails: false }));
    const retried = yield* fixture.service.processStack(stack.id);
    assert.strictEqual(retried._tag, "advanced");
  }),
);

// ---------------------------------------------------------------------------
// Invariant 2 — mutable prNumber, adopt-by-head-branch
// ---------------------------------------------------------------------------

scenario("a replacement PR rebinds the layer by head branch", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({ projectId: fixture.projectId });
    const layer = yield* fixture.service.appendLayer({
      stackId: stack.id,
      changeIds: ["zkmqwpxr"],
    });

    // First pass: GitHub shows PR #2 for this branch.
    yield* Ref.update(fixture.state, (value) => ({
      ...value,
      pullRequests: { [layer.bookmarkName]: [pr({ headRefName: layer.bookmarkName, number: 2 })] },
    }));
    yield* fixture.service.processStack(stack.id);
    const afterFirst = yield* fixture.service.getStack(stack.id);
    assert.strictEqual(afterFirst?.layers[0]?.prNumber, 2);
    assert.strictEqual(afterFirst?.layers[0]?.prState, "open");
    assert.strictEqual(afterFirst?.layers[0]?.status, "submitted");

    // The branch is deleted out of band, #2 cascade-closes, reopening fails
    // because the head came back at a different SHA, and #4 is minted. The
    // record must follow GitHub — the number it holds is not authoritative.
    yield* Ref.update(fixture.state, (value) => ({
      ...value,
      pullRequests: {
        [layer.bookmarkName]: [
          pr({ headRefName: layer.bookmarkName, number: 2, state: "closed" }),
          pr({ headRefName: layer.bookmarkName, number: 4, state: "open" }),
        ],
      },
    }));
    yield* fixture.service.processStack(stack.id);
    const afterReplacement = yield* fixture.service.getStack(stack.id);
    assert.strictEqual(
      afterReplacement?.layers[0]?.prNumber,
      4,
      "the layer must adopt the live PR for its head branch",
    );
    assert.strictEqual(afterReplacement?.layers[0]?.prState, "open");
  }),
);

scenario("a bookmark lost to an out-of-band deletion is recreated from the change id", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({ projectId: fixture.projectId });
    const layer = yield* fixture.service.appendLayer({
      stackId: stack.id,
      changeIds: ["zkmqwpxr"],
    });

    yield* fixture.service.processStack(stack.id);
    const published = yield* fixture.service.getStack(stack.id);
    const submittedSha = published?.layers[0]?.submittedSha;
    assert.isNotNull(submittedSha ?? null);

    // The fetch imported the deletion and the local bookmark is gone.
    yield* Ref.update(fixture.state, (value) => ({ ...value, bookmarkShas: {} }));
    yield* fixture.service.processStack(stack.id);

    const repaired = yield* Ref.get(fixture.state);
    assert.strictEqual(
      repaired.bookmarkShas[layer.bookmarkName],
      submittedSha,
      "the durable change id must rebuild the branch at the same SHA",
    );
  }),
);

// ---------------------------------------------------------------------------
// Invariant 3 — SHA-keyed post-merge reconciliation
// ---------------------------------------------------------------------------

scenario("a stack reconciles once its recorded merge SHAs are on the base", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({ projectId: fixture.projectId });
    const layer = yield* fixture.service.appendLayer({
      stackId: stack.id,
      changeIds: ["zkmqwpxr"],
    });
    yield* Ref.update(fixture.state, (value) => ({
      ...value,
      nativeStackNumber: 7,
      pullRequests: { [layer.bookmarkName]: [pr({ headRefName: layer.bookmarkName, number: 2 })] },
    }));
    yield* fixture.service.processStack(stack.id);
    yield* fixture.service.requestMerge(stack.id);

    // The merge runs, but nothing is *assumed* merged: the layer only moves
    // once GitHub reports a merge SHA on the next converge.
    yield* fixture.service.processStack(stack.id);
    assert.deepEqual((yield* Ref.get(fixture.state)).mergedStacks, [7]);
    const stillMerging = yield* fixture.service.getStack(stack.id);
    assert.strictEqual(stillMerging?.stack.status, "merging");
    assert.notStrictEqual(stillMerging?.layers[0]?.status, "merged");

    // GitHub now reports the merge, but the base does not contain it yet, so
    // reconciliation must not fire on the PR state alone.
    yield* Ref.update(fixture.state, (value) => ({
      ...value,
      pullRequests: {
        [layer.bookmarkName]: [
          pr({
            headRefName: layer.bookmarkName,
            number: 2,
            state: "merged",
            mergeSha: "abc1234",
          }),
        ],
      },
    }));
    yield* fixture.service.processStack(stack.id);
    const notYet = yield* fixture.service.getStack(stack.id);
    assert.strictEqual(notYet?.layers[0]?.mergeSha, "abc1234");
    assert.strictEqual(notYet?.layers[0]?.status, "merged");
    assert.strictEqual(
      notYet?.stack.status,
      "merging",
      "landing must be proven by ancestry, not taken from the PR state",
    );

    // Once the fetched base actually contains the recorded SHA, the stack
    // reconciles.
    yield* Ref.update(fixture.state, (value) => ({ ...value, landedShas: ["abc1234"] }));
    const outcome = yield* fixture.service.processStack(stack.id);
    assert.deepEqual(outcome, { _tag: "advanced", stackId: stack.id, status: "reconciled" });
    const calls = (yield* Ref.get(fixture.state)).calls;
    assert.include(calls, "refreshStack");
  }),
);

scenario("a conflicted reconciliation blocks instead of forcing", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({ projectId: fixture.projectId });
    const layer = yield* fixture.service.appendLayer({
      stackId: stack.id,
      changeIds: ["zkmqwpxr"],
    });
    yield* Ref.update(fixture.state, (value) => ({
      ...value,
      landedShas: ["abc1234"],
      refreshConflict: "there are unresolved conflicts",
      pullRequests: {
        [layer.bookmarkName]: [
          pr({ headRefName: layer.bookmarkName, number: 2, state: "merged", mergeSha: "abc1234" }),
        ],
      },
    }));

    const outcome = yield* fixture.service.processStack(stack.id);
    assert.strictEqual(outcome._tag, "blocked");
    const view = yield* fixture.service.getStack(stack.id);
    assert.strictEqual(view?.stack.status, "merged");
    // Cleanup must refuse a stack that never reconciled — deleting its branches
    // now is exactly the cascade-closure hazard invariant 5 exists to prevent.
    const refused = yield* fixture.service.cleanupStack(stack.id).pipe(Effect.flip);
    assert.strictEqual(refused._tag, "AdePublicationStackStateError");
  }),
);

// ---------------------------------------------------------------------------
// Base computation & the chained fallback
// ---------------------------------------------------------------------------

scenario("chained mode chains each layer onto the previous unmerged one", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({
      projectId: fixture.projectId,
      mode: "chained",
    });
    const bottom = yield* fixture.service.appendLayer({
      stackId: stack.id,
      changeIds: ["zkmqwpxr"],
    });
    const top = yield* fixture.service.appendLayer({ stackId: stack.id, changeIds: ["ymvlrtsp"] });

    // First pass: no PRs exist yet, so both are created against the computed
    // chain — bottom onto `main`, top onto the bottom's branch.
    yield* fixture.service.processStack(stack.id);
    const created = (yield* Ref.get(fixture.state)).createdPrs;
    assert.deepEqual(created, [
      { bookmarkName: bottom.bookmarkName, baseBranch: "main" },
      { bookmarkName: top.bookmarkName, baseBranch: bottom.bookmarkName },
    ]);

    // Once the bottom layer has landed, the top must be retargeted onto the
    // base — GitHub does not auto-retarget dependents, and merging into the
    // stale publication branch is the failure this prevents.
    yield* Ref.update(fixture.state, (value) => ({
      ...value,
      landedShas: ["merge-bottom"],
      createdPrs: [],
      retargets: [],
      pullRequests: {
        [bottom.bookmarkName]: [
          pr({
            headRefName: bottom.bookmarkName,
            number: 1,
            state: "merged",
            mergeSha: "merge-bottom",
          }),
        ],
        [top.bookmarkName]: [pr({ headRefName: top.bookmarkName, number: 2 })],
      },
    }));
    yield* fixture.service.processStack(stack.id);
    assert.deepEqual((yield* Ref.get(fixture.state)).retargets, [
      { prNumber: 2, baseBranch: "main" },
    ]);
  }),
);

// ---------------------------------------------------------------------------
// Invariants 4 & 5 — workspace safety and explicit cleanup
// ---------------------------------------------------------------------------

scenario("cleanup runs only after reconciliation, and only then deletes branches", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({ projectId: fixture.projectId });
    const layer = yield* fixture.service.appendLayer({
      stackId: stack.id,
      changeIds: ["zkmqwpxr"],
    });

    // While the stack is live, cleanup is refused outright.
    const refused = yield* fixture.service.cleanupStack(stack.id).pipe(Effect.flip);
    assert.strictEqual(refused._tag, "AdePublicationStackStateError");
    assert.deepEqual((yield* Ref.get(fixture.state)).deletedBookmarks, []);

    yield* Ref.update(fixture.state, (value) => ({
      ...value,
      landedShas: ["abc1234"],
      pullRequests: {
        [layer.bookmarkName]: [
          pr({ headRefName: layer.bookmarkName, number: 2, state: "merged", mergeSha: "abc1234" }),
        ],
      },
    }));
    yield* fixture.service.processStack(stack.id);
    const reconciled = yield* fixture.service.getStack(stack.id);
    assert.strictEqual(reconciled?.stack.status, "reconciled");

    const cleaned = yield* fixture.service.cleanupStack(stack.id);
    assert.deepEqual(cleaned.deletedBookmarks, [layer.bookmarkName]);
    assert.deepEqual((yield* Ref.get(fixture.state)).deletedBookmarks, [[layer.bookmarkName]]);
  }),
);

scenario("a pass fingerprints the working copy on both sides of its work", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({ projectId: fixture.projectId });
    yield* fixture.service.appendLayer({ stackId: stack.id, changeIds: ["zkmqwpxr"] });

    yield* Ref.update(fixture.state, (value) => ({ ...value, calls: [] }));
    yield* fixture.service.processStack(stack.id);
    const calls = (yield* Ref.get(fixture.state)).calls;
    const fingerprints = calls.filter((call) => call === "workingCopyFingerprint");
    assert.strictEqual(
      fingerprints.length,
      2,
      "the pass must observe the working copy before and after its work",
    );
    assert.strictEqual(calls[0], "workingCopyFingerprint");
    assert.strictEqual(calls[calls.length - 1], "workingCopyFingerprint");
  }),
);

// ---------------------------------------------------------------------------
// Concurrency & recovery (ADR §16.3)
// ---------------------------------------------------------------------------

scenario("a second concurrent pass is refused rather than duplicating GitHub work", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({ projectId: fixture.projectId });
    yield* fixture.service.appendLayer({ stackId: stack.id, changeIds: ["zkmqwpxr"] });

    // Hold the lease by hand: two passes creating PRs for the same branches is
    // precisely the duplication the lease exists to prevent.
    yield* fixture.sql`
      UPDATE ade_publication_stacks
      SET lease_holder = 'other-worker', lease_expires_at = '2999-01-01T00:00:00.000Z'
      WHERE publication_stack_id = ${stack.id}
    `;
    const outcome = yield* fixture.service.processStack(stack.id);
    assert.deepEqual(outcome, { _tag: "busy", stackId: stack.id });
    assert.deepEqual((yield* Ref.get(fixture.state)).pushedBookmarks, []);
  }),
);

scenario("recovery reclaims only expired leases, then the pass re-converges", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({ projectId: fixture.projectId });
    yield* fixture.service.appendLayer({ stackId: stack.id, changeIds: ["zkmqwpxr"] });

    // `it.effect` runs on the test clock, which sits at the epoch — so a live
    // lease is dated after 1970 and an expired one before it (as in S10).
    yield* fixture.sql`
      UPDATE ade_publication_stacks
      SET lease_holder = 'dead-worker', lease_expires_at = '2999-01-01T00:00:00.000Z'
      WHERE publication_stack_id = ${stack.id}
    `;
    // A live lease is never yanked out from under its holder.
    assert.deepEqual((yield* fixture.service.recoverStacks()).released, []);

    yield* fixture.sql`
      UPDATE ade_publication_stacks
      SET lease_expires_at = '1969-01-01T00:00:00.000Z'
      WHERE publication_stack_id = ${stack.id}
    `;
    assert.deepEqual((yield* fixture.service.recoverStacks()).released, [
      stack.id as PublicationStackId,
    ]);

    const outcome = yield* fixture.service.processStack(stack.id);
    assert.strictEqual(outcome._tag, "advanced");
  }),
);

scenario("the sweep adopts new candidates and publishes them in one pass", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({ projectId: fixture.projectId });
    yield* seedIntegratedCandidate(fixture, "cand-a", ["zkmqwpxr"]);

    const swept = yield* fixture.service.runOnce();
    assert.deepEqual(swept.stacks, [stack.id as PublicationStackId]);

    const view = yield* fixture.service.getStack(stack.id);
    assert.strictEqual(view?.layers.length, 1);
    const pushed = (yield* Ref.get(fixture.state)).pushedBookmarks;
    assert.deepEqual(pushed, [[view?.layers[0]?.bookmarkName as string]]);
  }),
);

scenario("an empty stack is idle, not an error", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({ projectId: fixture.projectId });
    const outcome = yield* fixture.service.processStack(stack.id);
    assert.deepEqual(outcome, { _tag: "idle", stackId: stack.id as PublicationStackId });
  }),
);

scenario("layer ids are stable across passes so S12 can key its rendering", () =>
  Effect.gen(function* () {
    const fixture = yield* setup;
    const { stack } = yield* fixture.service.openStack({ projectId: fixture.projectId });
    const layer = yield* fixture.service.appendLayer({
      stackId: stack.id,
      changeIds: ["zkmqwpxr"],
    });
    yield* fixture.service.processStack(stack.id);
    yield* fixture.service.processStack(stack.id);
    const view = yield* fixture.service.getStack(stack.id);
    assert.deepEqual(
      view?.layers.map((entry) => entry.id),
      [layer.id as PublicationLayerId],
    );
  }),
);
