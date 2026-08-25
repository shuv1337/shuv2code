import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import { FetchHttpClient } from "effect/unstable/http";

import {
  AdeCaptainError,
  IntegrationBounce,
  type AdeBotChatSession,
  type AdeProjectId,
  type BotId,
  type NeedsYouItemId,
} from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { AdeApprovalPort } from "./AdeApprovalPort.ts";
import { AdeAssignmentEngine, AdeAssignmentKernelPort } from "./AdeAssignmentEngine.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import { AdeCaptainApi } from "./AdeCaptainApi.ts";
import { AdeChatSessionPort } from "./AdeChatSessionPort.ts";
import { AdePersonaMemory } from "./AdePersonaMemory.ts";
import { AdeScreenboxRuntime } from "./AdeScreenbox.ts";
import { AdeScreenboxClient, AdeScreenboxConfig } from "./AdeScreenboxClient.ts";
import { startAdeScreenboxMock } from "./adeScreenboxMock.testSupport.ts";
import { AdeSessionRollover } from "./AdeSessionRollover.ts";
import { WorkspacePaths } from "../workspace/WorkspacePaths.ts";

/** Tagged so the stub's failure stays distinguishable in the error channel. */
class StubWorkspacePathError extends Schema.TaggedErrorClass<StubWorkspacePathError>()(
  "StubWorkspacePathError",
  { message: Schema.String },
) {}

const chatSession: AdeBotChatSession = {
  botId: "bot" as BotId,
  threadId: "ade-bot-bot" as AdeBotChatSession["threadId"],
  engine: "shuvcode",
  bindingId: "binding" as AdeBotChatSession["bindingId"],
  sessionId: "oc-1" as AdeBotChatSession["sessionId"],
  startedNow: true,
  toolsAttached: true,
};

/** A chat port that always succeeds — chat wiring is exercised separately. */
const chatPortOk = Layer.succeed(AdeChatSessionPort, {
  startPrimaryChat: (botId: BotId) => Effect.succeed({ ...chatSession, botId }),
});

/** A port that accepts every verdict — the seam is exercised in detail below. */
const approvalPortOk = Layer.succeed(AdeApprovalPort, {
  submitIntegrationApproval: () => Effect.void,
  readCandidateStatus: () => Effect.succeed("awaiting-approval" as string | null),
});

/**
 * A real `AdeScreenboxRuntime` over a real client. `baseUrl` null is an
 * unconfigured host, which is what most captain-API cases want; the Screen tab
 * and delete cases point it at the mock upstream so the desktop lifecycle is
 * genuinely exercised rather than stubbed.
 */
const screenboxLayer = (baseUrl: string | null) =>
  AdeScreenboxRuntime.layer.pipe(
    Layer.provide(AdeScreenboxClient.layer),
    Layer.provide(AdeScreenboxConfig.layer({ baseUrl, adminToken: "admin-token" })),
    Layer.provide(FetchHttpClient.layer),
  );

const makeLayer = (
  options: {
    readonly chatPort?: Layer.Layer<AdeChatSessionPort>;
    readonly approvalPort?: Layer.Layer<AdeApprovalPort>;
    readonly screenboxBaseUrl?: string | null;
  } = {},
) =>
  AdeCaptainApi.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        AdeBootstrap.layer,
        AdePersonaMemory.layer,
        AdeSessionRollover.layer,
        AdeAssignmentEngine.layer,
        screenboxLayer(options.screenboxBaseUrl ?? null),
        options.chatPort ?? chatPortOk,
        options.approvalPort ?? approvalPortOk,
        // Stands in for real path resolution: expands `~`, drops trailing
        // slashes, and refuses anything that does not exist.
        Layer.succeed(WorkspacePaths, {
          normalizeWorkspaceRoot: (root: string) =>
            root.startsWith("~/repos/demo")
              ? Effect.succeed("/normalized/repos/demo")
              : Effect.fail(
                  new StubWorkspacePathError({ message: `workspace root does not exist: ${root}` }),
                ),
        } as unknown as WorkspacePaths["Service"]),
      ),
    ),
    Layer.provide(AdeAssignmentKernelPort.layerUnwired),
    Layer.provideMerge(NodeSqliteClient.layerMemory()),
  );

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* sql`PRAGMA foreign_keys = ON`;
  const bootstrap = yield* AdeBootstrap;
  const seeded = yield* bootstrap.ensureSeeded();
  return {
    sql,
    bootstrap,
    api: yield* AdeCaptainApi,
    engine: yield* AdeAssignmentEngine,
    rollover: yield* AdeSessionRollover,
    firstmateId: seeded.firstmateBotId,
  };
});

describe("AdeCaptainApi.getRoster", () => {
  it.effect("pins the Firstmate first and lists shipped crew templates", () =>
    Effect.gen(function* () {
      const { api, bootstrap } = yield* setup;
      // Deliberately created before the Second Mate so insertion order cannot
      // be what produces the pin.
      yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });
      const project = yield* bootstrap.createProject({ name: "Zebra" });

      const roster = yield* api.getRoster();

      assert.deepEqual(
        roster.entries.map((entry) => entry.bot.structuralRole),
        ["firstmate", "second-mate", "crew"],
      );
      assert.deepEqual(roster.templates.map((template) => template.templateId).toSorted(), [
        "coder",
        "researcher",
        "reviewer",
      ]);
      assert.deepEqual(
        roster.projects.map((summary) => summary.name),
        ["Zebra"],
      );
      // The Second Mate carries its project's name; a fleet-shared crew bot
      // has none.
      const secondMate = roster.entries[1];
      assert.equal(secondMate?.projectName, "Zebra");
      assert.equal(secondMate?.bot.projectId, project.projectId);
      assert.equal(roster.entries[2]?.projectName, null);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("counts only open work and reports a warm chat per bot", () =>
    Effect.gen(function* () {
      const { api, bootstrap, engine, rollover, firstmateId } = yield* setup;
      const coder = yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });

      const open = yield* engine.createAssignment({
        requester: { _tag: "captain" },
        recipientBotId: coder.botId,
        instruction: "Fix the flake.",
        idempotencyKey: "open-1",
      });
      const done = yield* engine.createAssignment({
        requester: { _tag: "captain" },
        recipientBotId: coder.botId,
        instruction: "Already handled.",
        idempotencyKey: "done-1",
      });
      yield* engine.cancelAssignment({ assignmentId: done.assignment.id, cascade: false });

      yield* rollover.startPrimarySession({
        botId: firstmateId,
        engine: "shuvcode",
        sessionId: "oc-firstmate" as AdeBotChatSession["sessionId"],
      });

      const roster = yield* api.getRoster();
      const byId = new Map(roster.entries.map((entry) => [entry.bot.id, entry]));

      // The cancelled one must not inflate the badge.
      assert.equal(byId.get(coder.botId)?.openAssignmentCount, 1);
      assert.equal(byId.get(coder.botId)?.hasActivePrimarySession, false);
      assert.equal(byId.get(firstmateId)?.openAssignmentCount, 0);
      assert.equal(byId.get(firstmateId)?.hasActivePrimarySession, true);
      assert.equal(open.assignment.status, "queued");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("omits archived bots", () =>
    Effect.gen(function* () {
      const { api, bootstrap } = yield* setup;
      const coder = yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });
      yield* bootstrap.archiveBot(coder.botId);

      const roster = yield* api.getRoster();
      assert.isUndefined(roster.entries.find((entry) => entry.bot.id === coder.botId));
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("AdeCaptainApi.getBot", () => {
  it.effect("returns memory, persona versions newest-first, bindings, and open work", () =>
    Effect.gen(function* () {
      const { api, engine, rollover, firstmateId } = yield* setup;

      yield* api.writeBotMemory({ botId: firstmateId, content: "Remember the milk." });
      yield* api.editBotPersona({ botId: firstmateId, content: "A newer persona." });
      yield* rollover.startPrimarySession({
        botId: firstmateId,
        engine: "shuvcode",
        sessionId: "oc-1" as AdeBotChatSession["sessionId"],
      });
      yield* engine.createAssignment({
        requester: { _tag: "captain" },
        recipientBotId: firstmateId,
        instruction: "Plan the week.",
        idempotencyKey: "plan-1",
      });

      const detail = yield* api.getBot(firstmateId);

      assert.equal(detail.bot.id, firstmateId);
      assert.equal(detail.memory.content, "Remember the milk.");
      assert.equal(detail.memory.updatedBy, "captain");
      assert.lengthOf(detail.personaVersions, 2);
      assert.equal(detail.personaVersions[0]?.content, "A newer persona.");
      assert.lengthOf(detail.bindings, 1);
      assert.equal(detail.bindings[0]?.purpose, "primary-text");
      assert.lengthOf(detail.assignments, 1);
      assert.equal(detail.assignments[0]?.instruction, "Plan the week.");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("narrows a missing bot to bot_not_found", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;
      const error = yield* Effect.flip(api.getBot("nope" as BotId));
      assert.equal(error._tag, "AdeCaptainError");
      assert.equal(error.reason, "bot_not_found");
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("AdeCaptainApi mutations", () => {
  it.effect("instantiates a crew template and returns its detail", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;
      const detail = yield* api.createBotFromTemplate({
        templateId: "researcher",
        projectId: null,
        name: "Scout",
      });
      assert.equal(detail.bot.name, "Scout");
      assert.equal(detail.bot.structuralRole, "crew");
      assert.equal(detail.bot.roleTag, "Researcher");
      // Copy-on-create: persona v1 exists and is already active.
      assert.lengthOf(detail.personaVersions, 1);
      assert.equal(detail.bot.activePersonaVersionId, detail.personaVersions[0]?.id);
      assert.equal(detail.memory.content, "");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("narrows a coordinator template to template_not_instantiable", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;
      const error = yield* Effect.flip(
        api.createBotFromTemplate({
          // Only crew templates are one-click; the type excludes this, so the
          // cast reproduces exactly what an untyped client could send.
          templateId: "firstmate" as "coder",
          projectId: null,
        }),
      );
      assert.equal(error.reason, "template_not_instantiable");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("attributes captain memory edits and honours the CAS precondition", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;

      const first = yield* api.writeBotMemory({ botId: firstmateId, content: "one" });
      assert.equal(first.updatedBy, "captain");

      // Matching precondition lands.
      const second = yield* api.writeBotMemory({
        botId: firstmateId,
        content: "two",
        expectedUpdatedAt: first.updatedAt,
      });
      assert.equal(second.content, "two");

      // A stale precondition — the document moved under the editor — refuses
      // rather than clobbering.
      const error = yield* Effect.flip(
        api.writeBotMemory({
          botId: firstmateId,
          content: "three",
          expectedUpdatedAt: "2020-01-01T00:00:00.000Z",
        }),
      );
      assert.equal(error.reason, "memory_conflict");

      const detail = yield* api.getBot(firstmateId);
      assert.equal(detail.memory.content, "two");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("leaves a persona edit pending until the next session", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;
      const before = yield* api.getBot(firstmateId);

      const version = yield* api.editBotPersona({ botId: firstmateId, content: "Be terse." });
      assert.isNull(version.activatedAt);

      const after = yield* api.getBot(firstmateId);
      // The running session keeps its projection: the active pointer is
      // unchanged (ADR §12.1).
      assert.equal(after.bot.activePersonaVersionId, before.bot.activePersonaVersionId);
      assert.notEqual(after.bot.activePersonaVersionId, version.id);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("persists the computer-use toggle on the bot row", () =>
    Effect.gen(function* () {
      const { api, sql, firstmateId } = yield* setup;
      assert.isFalse((yield* api.getBot(firstmateId)).bot.computerUse);

      const enabled = yield* api.setBotComputerUse({ botId: firstmateId, computerUse: true });
      assert.isTrue(enabled.computerUse);
      const rows = yield* sql<{ computer_use: number }>`
        SELECT computer_use FROM ade_bots WHERE bot_id = ${firstmateId}
      `;
      assert.equal(rows[0]?.computer_use, 1);

      const disabled = yield* api.setBotComputerUse({ botId: firstmateId, computerUse: false });
      assert.isFalse(disabled.computerUse);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("narrows a computer-use toggle on a missing bot", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;
      const error = yield* Effect.flip(
        api.setBotComputerUse({ botId: "nope" as BotId, computerUse: true }),
      );
      assert.equal(error.reason, "bot_not_found");
    }).pipe(Effect.provide(makeLayer())),
  );
  it.effect("creates a project together with its Second Mate", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;
      const created = yield* api.createProject({
        name: "Demo Fleet Project",
        repoPath: "~/repos/demo",
      });
      assert.equal(created.project.name, "Demo Fleet Project");

      // The auto-Second-Mate hook is the reason this goes through
      // AdeBootstrap: without it a new project has no coordinator at all.
      const detail = yield* api.getBot(created.secondMateBotId);
      assert.equal(detail.bot.structuralRole, "second-mate");
      assert.equal(detail.bot.projectId, created.project.id);

      const roster = yield* api.getRoster();
      assert.deepEqual(
        roster.projects.map((project) => project.name),
        ["Demo Fleet Project"],
      );
      // A bound repo is what lets the chat resolve somewhere to run.
      assert.equal(detail.projectName, "Demo Fleet Project");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("normalizes the repo path so later comparisons can match", () =>
    Effect.gen(function* () {
      const { api, sql } = yield* setup;
      // What the captain typed vs what workspace projects store. Storing the
      // raw form is what made the chat's project lookup miss and re-dispatch
      // project.create on every visit.
      const created = yield* api.createProject({ name: "Tilde", repoPath: "~/repos/demo/" });
      const rows = yield* sql<{ repo_path: string | null }>`
        SELECT repo_path FROM ade_projects WHERE project_id = ${created.project.id}
      `;
      assert.equal(rows[0]?.repo_path, "/normalized/repos/demo");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("is idempotent per repository: one project, one Second Mate", () =>
    Effect.gen(function* () {
      const { api, sql } = yield* setup;
      const first = yield* api.createProject({ name: "Demo", repoPath: "~/repos/demo" });
      // Same repo, different spelling and name — a captain pressing the CTA
      // twice, or two tabs racing.
      const second = yield* api.createProject({ name: "Demo again", repoPath: "~/repos/demo/" });

      assert.equal(second.project.id, first.project.id);
      assert.equal(second.secondMateBotId, first.secondMateBotId);
      const projects = yield* sql<{ project_id: string }>`SELECT project_id FROM ade_projects`;
      assert.lengthOf(projects, 1);
      const mates = yield* sql<{ bot_id: string }>`
        SELECT bot_id FROM ade_bots WHERE structural_role = 'second-mate'
      `;
      assert.lengthOf(mates, 1);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a repository path it cannot resolve", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;
      const error = yield* Effect.flip(
        api.createProject({ name: "Bad", repoPath: "/does/not/exist" }),
      );
      assert.equal(error.reason, "project_invalid");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("accepts a project with no repository binding", () =>
    Effect.gen(function* () {
      const { api, sql } = yield* setup;
      const created = yield* api.createProject({ name: "Unbound", repoPath: null });
      const rows = yield* sql<{ repo_path: string | null }>`
        SELECT repo_path FROM ade_projects WHERE project_id = ${created.project.id}
      `;
      assert.equal(rows[0]?.repo_path, null);
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("AdeCaptainApi.getNeedsYouCount", () => {
  it.effect("counts only open items", () =>
    Effect.gen(function* () {
      const { api, sql } = yield* setup;
      assert.deepEqual(yield* api.getNeedsYouCount(), { open: 0 });

      const insert = (id: string, status: string) => sql`
        INSERT INTO ade_needs_you_items (
          needs_you_item_id, kind, subject_refs_json, status, created_at, updated_at, resolved_at
        ) VALUES (${id}, 'approval', '[]', ${status}, '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z', NULL)
      `;
      yield* insert("a", "open");
      yield* insert("b", "open");
      yield* insert("c", "resolved");
      yield* insert("d", "dismissed");

      assert.deepEqual(yield* api.getNeedsYouCount(), { open: 2 });
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("AdeCaptainApi.startBotChat", () => {
  it.effect("delegates to the chat port for an existing bot", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;
      const session = yield* api.startBotChat(firstmateId);
      assert.equal(session.botId, firstmateId);
      assert.equal(session.engine, "shuvcode");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a missing bot before touching the kernel", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;
      const error = yield* Effect.flip(api.startBotChat("nope" as BotId));
      assert.equal(error.reason, "bot_not_found");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("surfaces an unwired kernel as session_unavailable, not a crash", () =>
    Effect.gen(function* () {
      const { api, firstmateId } = yield* setup;
      const error = yield* Effect.flip(api.startBotChat(firstmateId));
      assert.equal(error.reason, "session_unavailable");
      // …and the rest of the captain surface still works while degraded.
      const roster = yield* api.getRoster();
      assert.isAbove(roster.entries.length, 0);
    }).pipe(Effect.provide(makeLayer({ chatPort: AdeChatSessionPort.layerUnavailable }))),
  );
});

// ---------------------------------------------------------------------------
// Needs You inbox (spec §7 slice 5, S13)
// ---------------------------------------------------------------------------

interface ForwardedVerdict {
  readonly candidateId: string;
  readonly decision: string;
}

/** An approval port that records every verdict actually forwarded. */
const recordingApprovalPort = (calls: Array<ForwardedVerdict>) =>
  Layer.succeed(AdeApprovalPort, {
    submitIntegrationApproval: (input: {
      readonly candidateId: string;
      readonly decision: string;
    }) =>
      Effect.sync(() => {
        calls.push({ candidateId: input.candidateId, decision: input.decision });
      }),
    readCandidateStatus: () => Effect.succeed("awaiting-approval"),
  } as unknown as AdeApprovalPort["Service"]);

const failingApprovalPort = (candidateStatus: string | null) =>
  Layer.succeed(AdeApprovalPort, {
    submitIntegrationApproval: () =>
      Effect.fail(
        new AdeCaptainError({
          reason: "needs_you_decision_rejected",
          message: "the submission failed",
        }),
      ),
    readCandidateStatus: () => Effect.succeed(candidateStatus),
  } as unknown as AdeApprovalPort["Service"]);

/**
 * Pre-claim failure: the integration service never recorded a verdict, so the
 * candidate is still parked and the item has to come back.
 */
const refusingApprovalPort = failingApprovalPort("awaiting-approval");

/**
 * The D1 window: the submission reported failure, but the verdict was already
 * durable — `claimForVerdict` records it and retires the item *before*
 * `applyVerdict` runs, so a post-claim persistence failure surfaces as a failed
 * call on a candidate that has already moved on. Reopening here would strand
 * the item: `awaiting-approval` is the only state that retires it, and the
 * candidate can never re-enter it.
 */
const verdictLandedThenFailedPort = failingApprovalPort("integrated");

const APPROVAL_REFS = JSON.stringify([
  { _tag: "integrationCandidate", integrationCandidateId: "candidate-1" },
]);

const insertNeedsYouItem = (
  sql: SqlClient.SqlClient,
  input: {
    readonly id: string;
    readonly kind: string;
    readonly subjectRefs: string;
    readonly status?: string;
  },
) => sql`
  INSERT INTO ade_needs_you_items (
    needs_you_item_id, kind, subject_refs_json, status, created_at, updated_at, resolved_at
  ) VALUES (
    ${input.id}, ${input.kind}, ${input.subjectRefs}, ${input.status ?? "open"},
    '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z', NULL
  )
`;

describe("AdeCaptainApi.listNeedsYou", () => {
  it.effect("lists open items by default and history on request", () =>
    Effect.gen(function* () {
      const { api, sql } = yield* setup;
      yield* insertNeedsYouItem(sql, {
        id: "open-1",
        kind: "approval",
        subjectRefs: APPROVAL_REFS,
      });
      yield* insertNeedsYouItem(sql, {
        id: "done-1",
        kind: "stall",
        subjectRefs: "[]",
        status: "resolved",
      });

      const open = yield* api.listNeedsYou({ includeResolved: false });
      assert.deepEqual(
        open.entries.map((entry) => entry.item.id),
        ["open-1"],
      );
      // The badge and the list are one number. A captain who follows a badge
      // into an inbox that disagrees with it has been lied to by one of them.
      assert.equal(open.open, (yield* api.getNeedsYouCount()).open);

      const all = yield* api.listNeedsYou({ includeResolved: true });
      assert.deepEqual(
        all.entries.map((entry) => entry.item.id),
        ["open-1", "done-1"],
      );
      assert.equal(all.open, 1);
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("AdeCaptainApi.submitNeedsYouDecision", () => {
  it.effect("approves once and resolves the durable item", () => {
    const verdicts: Array<ForwardedVerdict> = [];
    return Effect.gen(function* () {
      const { api, sql } = yield* setup;
      yield* insertNeedsYouItem(sql, {
        id: "item-1",
        kind: "approval",
        subjectRefs: APPROVAL_REFS,
      });

      const resolved = yield* api.submitNeedsYouDecision({
        needsYouItemId: "item-1" as NeedsYouItemId,
        decision: "approve",
      });

      assert.equal(resolved.item.status, "resolved");
      assert.equal(resolved.actionable, false);
      assert.deepEqual(verdicts, [{ candidateId: "candidate-1", decision: "approve" }]);
      assert.deepEqual(yield* api.getNeedsYouCount(), { open: 0 });
    }).pipe(Effect.provide(makeLayer({ approvalPort: recordingApprovalPort(verdicts) })));
  });

  it.effect("denies, and forwards the denial rather than swallowing it", () => {
    const verdicts: Array<ForwardedVerdict> = [];
    return Effect.gen(function* () {
      const { api, sql } = yield* setup;
      yield* insertNeedsYouItem(sql, {
        id: "item-1",
        kind: "approval",
        subjectRefs: APPROVAL_REFS,
      });

      const resolved = yield* api.submitNeedsYouDecision({
        needsYouItemId: "item-1" as NeedsYouItemId,
        decision: "deny",
        note: "not yet",
      });

      assert.equal(resolved.item.status, "resolved");
      assert.deepEqual(verdicts, [{ candidateId: "candidate-1", decision: "deny" }]);
    }).pipe(Effect.provide(makeLayer({ approvalPort: recordingApprovalPort(verdicts) })));
  });

  it.effect("resolves one item exactly once — the second decision is a benign conflict", () => {
    const verdicts: Array<ForwardedVerdict> = [];
    return Effect.gen(function* () {
      const { api, sql } = yield* setup;
      yield* insertNeedsYouItem(sql, {
        id: "item-1",
        kind: "approval",
        subjectRefs: APPROVAL_REFS,
      });
      const decide = () =>
        api.submitNeedsYouDecision({
          needsYouItemId: "item-1" as NeedsYouItemId,
          decision: "approve",
        });

      yield* decide();
      const second = yield* Effect.flip(decide());

      assert.equal(second.reason, "needs_you_already_resolved");
      // The point of the claim: the integration service saw exactly one
      // verdict, whichever rendering the second press came from.
      assert.equal(verdicts.length, 1);
    }).pipe(Effect.provide(makeLayer({ approvalPort: recordingApprovalPort(verdicts) })));
  });

  it.effect("refuses to decide a kind that resolves itself", () => {
    const verdicts: Array<ForwardedVerdict> = [];
    return Effect.gen(function* () {
      const { api, sql } = yield* setup;
      yield* insertNeedsYouItem(sql, { id: "kernel-1", kind: "kernel-down", subjectRefs: "[]" });

      const error = yield* Effect.flip(
        api.submitNeedsYouDecision({
          needsYouItemId: "kernel-1" as NeedsYouItemId,
          decision: "approve",
        }),
      );

      assert.equal(error.reason, "needs_you_not_actionable");
      // Still open: refusing to decide it must not retire it.
      assert.deepEqual(yield* api.getNeedsYouCount(), { open: 1 });
      assert.equal(verdicts.length, 0);
    }).pipe(Effect.provide(makeLayer({ approvalPort: recordingApprovalPort(verdicts) })));
  });

  it.effect("reopens the item when the verdict does not land", () =>
    Effect.gen(function* () {
      const { api, sql } = yield* setup;
      yield* insertNeedsYouItem(sql, {
        id: "item-1",
        kind: "approval",
        subjectRefs: APPROVAL_REFS,
      });

      const error = yield* Effect.flip(
        api.submitNeedsYouDecision({
          needsYouItemId: "item-1" as NeedsYouItemId,
          decision: "approve",
        }),
      );

      assert.equal(error.reason, "needs_you_decision_rejected");
      // An item resolved against a decision nothing applied is work silently
      // dropped; it has to come back.
      const entry = yield* api.getNeedsYouItem("item-1" as NeedsYouItemId);
      assert.equal(entry.item.status, "open");
      assert.equal(entry.actionable, true);
      assert.deepEqual(yield* api.getNeedsYouCount(), { open: 1 });
    }).pipe(Effect.provide(makeLayer({ approvalPort: refusingApprovalPort }))),
  );

  it.effect("leaves the item retired when the verdict landed before the failure", () =>
    Effect.gen(function* () {
      const { api, sql } = yield* setup;
      yield* insertNeedsYouItem(sql, {
        id: "item-1",
        kind: "approval",
        subjectRefs: APPROVAL_REFS,
      });

      const error = yield* Effect.flip(
        api.submitNeedsYouDecision({
          needsYouItemId: "item-1" as NeedsYouItemId,
          decision: "approve",
        }),
      );

      // Reported as the benign conflict it is, not as a rejected decision.
      assert.equal(error.reason, "needs_you_already_resolved");
      // And crucially *not* reopened: the candidate has left `awaiting-approval`
      // for good, so an item put back here could never be retired again.
      const entry = yield* api.getNeedsYouItem("item-1" as NeedsYouItemId);
      assert.equal(entry.item.status, "resolved");
      assert.deepEqual(yield* api.getNeedsYouCount(), { open: 0 });
    }).pipe(Effect.provide(makeLayer({ approvalPort: verdictLandedThenFailedPort }))),
  );

  it.effect("never reopens an item something else retired in the meantime", () => {
    // Runs inside the failed submission's recovery, between the claim and the
    // reopen — the exact window the `status = 'resolved'` guard exists for.
    const duringRecovery: { run: Effect.Effect<void> } = { run: Effect.void };
    const racingPort = Layer.succeed(AdeApprovalPort, {
      submitIntegrationApproval: () =>
        Effect.fail(
          new AdeCaptainError({ reason: "needs_you_decision_rejected", message: "failed" }),
        ),
      readCandidateStatus: () =>
        Effect.as(Effect.orDie(duringRecovery.run), "awaiting-approval" as string | null),
    } as unknown as AdeApprovalPort["Service"]);

    return Effect.gen(function* () {
      const { api, sql } = yield* setup;
      yield* insertNeedsYouItem(sql, {
        id: "item-1",
        kind: "approval",
        subjectRefs: APPROVAL_REFS,
      });
      duringRecovery.run = Effect.orDie(
        sql`UPDATE ade_needs_you_items SET status = 'dismissed' WHERE needs_you_item_id = 'item-1'`,
      ).pipe(Effect.asVoid);

      yield* Effect.flip(
        api.submitNeedsYouDecision({
          needsYouItemId: "item-1" as NeedsYouItemId,
          decision: "approve",
        }),
      );

      // The reopen can only ever undo *our* claim. A row something else has
      // since retired stays retired rather than springing back open.
      const entry = yield* api.getNeedsYouItem("item-1" as NeedsYouItemId);
      assert.equal(entry.item.status, "dismissed");
    }).pipe(Effect.provide(makeLayer({ approvalPort: racingPort })));
  });

  it.effect("reports a missing item rather than failing opaquely", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;
      const error = yield* Effect.flip(
        api.submitNeedsYouDecision({
          needsYouItemId: "ghost" as NeedsYouItemId,
          decision: "approve",
        }),
      );
      assert.equal(error.reason, "needs_you_not_found");
    }).pipe(Effect.provide(makeLayer())),
  );
});

/**
 * D3: the unroutable-repair item. Nothing waits on a verdict and nothing will
 * ever clear it, so the captain retires it by hand — through the same gated
 * RPC, with no port call underneath.
 */
describe("AdeCaptainApi.submitNeedsYouDecision (acknowledge)", () => {
  const UNROUTABLE_REFS = JSON.stringify([
    { _tag: "integrationCandidate", integrationCandidateId: "candidate-9" },
  ]);

  it.effect("acknowledges an unroutable repair without forwarding anything", () => {
    const verdicts: Array<ForwardedVerdict> = [];
    return Effect.gen(function* () {
      const { api, sql } = yield* setup;
      yield* insertNeedsYouItem(sql, {
        id: "stuck-1",
        kind: "stall",
        subjectRefs: UNROUTABLE_REFS,
      });

      const listed = yield* api.listNeedsYou({ includeResolved: false });
      assert.equal(listed.entries[0]?.action, "acknowledge");

      const resolved = yield* api.submitNeedsYouDecision({
        needsYouItemId: "stuck-1" as NeedsYouItemId,
        decision: "acknowledge",
      });

      assert.equal(resolved.item.status, "resolved");
      assert.equal(resolved.action, null);
      // No verdict exists to forward; inventing one would name a candidate
      // nothing is waiting on.
      assert.deepEqual(verdicts, []);
      assert.deepEqual(yield* api.getNeedsYouCount(), { open: 0 });
    }).pipe(Effect.provide(makeLayer({ approvalPort: recordingApprovalPort(verdicts) })));
  });

  it.effect("refuses a control the item does not offer, in either direction", () => {
    const verdicts: Array<ForwardedVerdict> = [];
    return Effect.gen(function* () {
      const { api, sql } = yield* setup;
      yield* insertNeedsYouItem(sql, {
        id: "stuck-1",
        kind: "stall",
        subjectRefs: UNROUTABLE_REFS,
      });
      yield* insertNeedsYouItem(sql, {
        id: "approval-1",
        kind: "approval",
        subjectRefs: APPROVAL_REFS,
      });

      const approvedAStall = yield* Effect.flip(
        api.submitNeedsYouDecision({
          needsYouItemId: "stuck-1" as NeedsYouItemId,
          decision: "approve",
        }),
      );
      const acknowledgedAnApproval = yield* Effect.flip(
        api.submitNeedsYouDecision({
          needsYouItemId: "approval-1" as NeedsYouItemId,
          decision: "acknowledge",
        }),
      );

      assert.equal(approvedAStall.reason, "needs_you_not_actionable");
      assert.equal(acknowledgedAnApproval.reason, "needs_you_not_actionable");
      // Neither refusal retired anything, and no verdict escaped.
      assert.deepEqual(yield* api.getNeedsYouCount(), { open: 2 });
      assert.deepEqual(verdicts, []);
    }).pipe(Effect.provide(makeLayer({ approvalPort: recordingApprovalPort(verdicts) })));
  });

  it.effect("acknowledging is exactly-once like every other resolution", () =>
    Effect.gen(function* () {
      const { api, sql } = yield* setup;
      yield* insertNeedsYouItem(sql, {
        id: "stuck-1",
        kind: "stall",
        subjectRefs: UNROUTABLE_REFS,
      });
      const acknowledge = () =>
        api.submitNeedsYouDecision({
          needsYouItemId: "stuck-1" as NeedsYouItemId,
          decision: "acknowledge",
        });

      yield* acknowledge();
      const second = yield* Effect.flip(acknowledge());
      assert.equal(second.reason, "needs_you_already_resolved");
    }).pipe(Effect.provide(makeLayer())),
  );
});

// ---------------------------------------------------------------------------
// Project view + work graph (spec §7 slices 3, 4 — issue #166)
// ---------------------------------------------------------------------------

type Sql = SqlClient.SqlClient;

/**
 * Encodes a bounce the way the integration service does, so the fixture is
 * exercising the same wire shape the projection has to decode.
 */
const encodeBounce = Schema.encodeSync(Schema.fromJsonString(IntegrationBounce));

/**
 * Seeds a candidate row directly. The integration service's own
 * `enqueueCandidate` insists on a repo-bound project and a real JJ workspace;
 * these tests are about the *projection*, so they write the states a pass would
 * produce and assert the panel reads them back.
 */
const seedCandidate = (
  sql: Sql,
  row: {
    readonly id: string;
    readonly projectId: string;
    readonly botId: string;
    readonly status: string;
    readonly createdAt: string;
    readonly gate?: string | null;
    /** Pre-encoded `bounce_json`; build it with {@link encodeBounce}. */
    readonly bounce?: string | null;
  },
) => sql`
  INSERT INTO ade_integration_candidates (
    integration_candidate_id, project_id, idempotency_key,
    source_assignment_ids_json, change_ids_json, originating_bot_id,
    declared_risk, status, gate, bounce_count, bounce_json,
    created_at, updated_at
  ) VALUES (
    ${row.id}, ${row.projectId}, ${row.id},
    '[]', '["kmnopqrs"]', ${row.botId},
    'normal', ${row.status}, ${row.gate ?? null},
    ${row.bounce == null ? 0 : 1}, ${row.bounce ?? null},
    ${row.createdAt}, ${row.createdAt}
  )
`;

const seedStack = (
  sql: Sql,
  row: { id: string; projectId: string; status: string; createdAt: string },
) => sql`
  INSERT INTO ade_publication_stacks (
    publication_stack_id, project_id, mode, status, stack_url,
    native_stack_number, native_stack_node_id, created_at, updated_at
  ) VALUES (
    ${row.id}, ${row.projectId}, 'chained', ${row.status},
    ${`https://example.test/${row.id}`}, NULL, NULL, ${row.createdAt}, ${row.createdAt}
  )
`;

describe("AdeCaptainApi.getProject", () => {
  it.effect("pins the Second Mate, counts open work, and omits archived crew", () =>
    Effect.gen(function* () {
      const { api, bootstrap, engine } = yield* setup;
      const project = yield* bootstrap.createProject({ name: "Demo" });
      const coder = yield* bootstrap.instantiateTemplate({
        templateId: "coder",
        projectId: project.projectId,
      });
      const archived = yield* bootstrap.instantiateTemplate({
        templateId: "reviewer",
        projectId: project.projectId,
      });
      yield* bootstrap.archiveBot(archived.botId);
      // A fleet-shared specialist is on loan, not on the crew.
      yield* bootstrap.instantiateTemplate({ templateId: "researcher", projectId: null });

      yield* engine.createAssignment({
        requester: { _tag: "captain" },
        recipientBotId: coder.botId,
        instruction: "Ship the panel.",
        idempotencyKey: "crew-1",
        projectId: project.projectId,
      });

      const detail = yield* api.getProject(project.projectId);

      assert.equal(detail.project.name, "Demo");
      assert.deepEqual(
        detail.crew.map((member) => member.bot.structuralRole),
        ["second-mate", "crew"],
      );
      assert.equal(detail.crew[0]?.isSecondMate, true);
      assert.equal(detail.crew[1]?.isSecondMate, false);
      assert.equal(detail.crew[1]?.openAssignmentCount, 1);
      assert.equal(detail.crew[1]?.hasActivePrimarySession, false);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("narrows a missing project to project_not_found", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;
      const error = yield* Effect.flip(api.getProject("nope" as AdeProjectId));
      assert.equal(error._tag, "AdeCaptainError");
      assert.equal(error.reason, "project_not_found");
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("AdeCaptainApi.listProjectCandidates", () => {
  it.effect("returns queue order with gates and bounce reasons intact", () =>
    Effect.gen(function* () {
      const { api, sql, bootstrap } = yield* setup;
      const project = yield* bootstrap.createProject({ name: "Demo" });
      const other = yield* bootstrap.createProject({ name: "Other" });

      yield* seedCandidate(sql, {
        id: "cand-bounced",
        projectId: project.projectId,
        botId: project.secondMate.botId,
        status: "bounced",
        createdAt: "2026-08-24T00:00:00.000Z",
        bounce: encodeBounce({
          reason: "checks-failed",
          detail: "vp check exited 1",
          at: "2026-08-24T00:01:00.000Z",
        }),
      });
      yield* seedCandidate(sql, {
        id: "cand-awaiting",
        projectId: project.projectId,
        botId: project.secondMate.botId,
        status: "awaiting-approval",
        createdAt: "2026-08-24T00:02:00.000Z",
        gate: "human-approval",
      });
      // Another project's queue must never leak into this panel.
      yield* seedCandidate(sql, {
        id: "cand-other",
        projectId: other.projectId,
        botId: other.secondMate.botId,
        status: "queued",
        createdAt: "2026-08-24T00:00:30.000Z",
      });

      const all = yield* api.listProjectCandidates({ projectId: project.projectId });
      assert.deepEqual(
        all.candidates.map((candidate) => candidate.id),
        ["cand-bounced", "cand-awaiting"],
      );
      assert.equal(all.candidates[0]?.bounce?.reason, "checks-failed");
      assert.equal(all.candidates[0]?.bounce?.detail, "vp check exited 1");
      assert.equal(all.candidates[1]?.gate, "human-approval");

      assert.equal(all.unreadableRows, 0);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("refuses a missing project rather than returning an empty queue", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;
      const error = yield* Effect.flip(
        api.listProjectCandidates({ projectId: "nope" as AdeProjectId }),
      );
      assert.equal(error.reason, "project_not_found");
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("AdeCaptainApi.getProjectPublicationStack", () => {
  it.effect("prefers the live stack over a newer settled one and orders layers bottom-up", () =>
    Effect.gen(function* () {
      const { api, sql, bootstrap } = yield* setup;
      const project = yield* bootstrap.createProject({ name: "Demo" });

      yield* seedStack(sql, {
        id: "stack-live",
        projectId: project.projectId,
        status: "building",
        createdAt: "2026-08-24T00:00:00.000Z",
      });
      // Newer, but settled: recency must not beat liveness.
      yield* seedStack(sql, {
        id: "stack-merged",
        projectId: project.projectId,
        status: "merged",
        createdAt: "2026-08-24T01:00:00.000Z",
      });
      // Inserted out of order so the ORDER BY is what sorts them.
      for (const layer of [
        { id: "layer-1", order: 1, pr: 42, state: "open", status: "submitted" },
        { id: "layer-0", order: 0, pr: 41, state: "merged", status: "merged" },
      ]) {
        yield* sql`
          INSERT INTO ade_publication_layers (
            publication_layer_id, publication_stack_id, layer_order, change_ids_json,
            bookmark_name, pr_number, head_sha, submitted_sha, merge_sha, pr_state,
            status, created_at, updated_at
          ) VALUES (
            ${layer.id}, 'stack-live', ${layer.order}, '["kmnopqrs"]',
            ${`ade/${layer.id}`}, ${layer.pr}, 'headsha', 'submittedsha', NULL,
            ${layer.state}, ${layer.status},
            '2026-08-24T00:00:00.000Z', '2026-08-24T00:00:00.000Z'
          )
        `;
      }

      const view = yield* api.getProjectPublicationStack(project.projectId);

      assert.equal(view?.stack.id, "stack-live");
      assert.equal(view?.stack.status, "building");
      assert.deepEqual(
        view?.layers.map((layer) => layer.order),
        [0, 1],
      );
      assert.equal(view?.layers[0]?.prNumber, 41);
      assert.equal(view?.layers[0]?.prState, "merged");
      assert.equal(view?.layers[1]?.prState, "open");
      assert.deepEqual(view?.layers[1]?.changeIds as ReadonlyArray<string>, ["kmnopqrs"]);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("falls back to the most recent settled stack, and null when there is none", () =>
    Effect.gen(function* () {
      const { api, sql, bootstrap } = yield* setup;
      const project = yield* bootstrap.createProject({ name: "Demo" });

      // A project that has never published is normal, not an error.
      assert.isNull(yield* api.getProjectPublicationStack(project.projectId));

      yield* seedStack(sql, {
        id: "stack-old",
        projectId: project.projectId,
        status: "merged",
        createdAt: "2026-08-24T00:00:00.000Z",
      });
      yield* seedStack(sql, {
        id: "stack-new",
        projectId: project.projectId,
        status: "reconciled",
        createdAt: "2026-08-24T02:00:00.000Z",
      });

      const view = yield* api.getProjectPublicationStack(project.projectId);
      assert.equal(view?.stack.id, "stack-new");
      assert.deepEqual(view?.layers, []);
    }).pipe(Effect.provide(makeLayer())),
  );
});

describe("AdeCaptainApi.getAssignmentGraph", () => {
  it.effect("scopes to a project, names bots, and counts out-of-scope children", () =>
    Effect.gen(function* () {
      const { api, bootstrap, engine } = yield* setup;
      const project = yield* bootstrap.createProject({ name: "Demo" });
      const coder = yield* bootstrap.instantiateTemplate({
        templateId: "coder",
        projectId: project.projectId,
      });
      const shared = yield* bootstrap.instantiateTemplate({
        templateId: "researcher",
        projectId: null,
      });

      const parent = yield* engine.createAssignment({
        requester: { _tag: "captain" },
        recipientBotId: project.secondMate.botId,
        instruction: "Land the feature.",
        idempotencyKey: "parent-1",
        projectId: project.projectId,
      });
      yield* engine.createAssignment({
        requester: { _tag: "bot", botId: project.secondMate.botId },
        recipientBotId: coder.botId,
        instruction: "Write the panel.",
        idempotencyKey: "child-1",
        projectId: project.projectId,
        parentAssignmentId: parent.assignment.id,
      });
      // Delegated off-project: it must be counted but not listed in this scope.
      yield* engine.createAssignment({
        requester: { _tag: "bot", botId: project.secondMate.botId },
        recipientBotId: shared.botId,
        instruction: "Go read the spec.",
        idempotencyKey: "child-2",
        projectId: null,
        parentAssignmentId: parent.assignment.id,
      });

      const scoped = yield* api.getAssignmentGraph({ projectId: project.projectId });

      assert.deepEqual(
        scoped.nodes.map((node) => node.title),
        ["Land the feature.", "Write the panel."],
      );
      const root = scoped.nodes[0];
      assert.equal(root?.parentAssignmentId, null);
      // childCount is scoped to the response: the off-project child is not
      // in this window, so it is not counted here.
      assert.equal(root?.childCount, 1);
      assert.equal(root?.projectName, "Demo");
      assert.equal(scoped.nodes[1]?.parentAssignmentId, parent.assignment.id);
      assert.equal(scoped.nodes[1]?.botName, (yield* api.getBot(coder.botId)).bot.name);
      assert.isFalse(scoped.truncated);
      assert.equal(scoped.unreadableRows, 0);
      assert.deepEqual(
        scoped.bots.map((bot) => bot.id).toSorted(),
        [coder.botId, project.secondMate.botId].toSorted(),
      );

      // Fleet-wide sees all three, and a fleet-shared bot has no project name.
      const fleet = yield* api.getAssignmentGraph({ projectId: null });
      assert.lengthOf(fleet.nodes, 3);
      const offProject = fleet.nodes.find((node) => node.title === "Go read the spec.");
      assert.equal(offProject?.projectName, null);
      assert.equal(offProject?.botName, (yield* api.getBot(shared.botId)).bot.name);
      // Fleet-wide, both children are in scope.
      assert.equal(fleet.nodes.find((node) => node.id === parent.assignment.id)?.childCount, 2);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("narrows a missing project scope to project_not_found", () =>
    Effect.gen(function* () {
      const { api } = yield* setup;
      const error = yield* Effect.flip(
        api.getAssignmentGraph({ projectId: "nope" as AdeProjectId }),
      );
      assert.equal(error.reason, "project_not_found");
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("windows to the most recent N and says so", () =>
    Effect.gen(function* () {
      const { api, bootstrap, engine } = yield* setup;
      const project = yield* bootstrap.createProject({ name: "Demo" });

      for (let index = 0; index < 5; index += 1) {
        yield* engine.createAssignment({
          requester: { _tag: "captain" },
          recipientBotId: project.secondMate.botId,
          instruction: `Task ${index}`,
          idempotencyKey: `task-${index}`,
          projectId: project.projectId,
        });
      }

      const windowed = yield* api.getAssignmentGraph({ projectId: project.projectId, limit: 2 });
      assert.isTrue(windowed.truncated);
      // The *most recent* two, still oldest-first within the window.
      assert.deepEqual(
        windowed.nodes.map((node) => node.title),
        ["Task 3", "Task 4"],
      );

      const whole = yield* api.getAssignmentGraph({ projectId: project.projectId, limit: 50 });
      assert.isFalse(whole.truncated);
      assert.lengthOf(whole.nodes, 5);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("carries a bounded title instead of the whole instruction body", () =>
    Effect.gen(function* () {
      const { api, bootstrap, engine } = yield* setup;
      const project = yield* bootstrap.createProject({ name: "Demo" });
      // A realistic instruction: a one-line summary, then a wall of context.
      const body = "x".repeat(5_000);
      yield* engine.createAssignment({
        requester: { _tag: "captain" },
        recipientBotId: project.secondMate.botId,
        instruction: `Rewrite the panel\n\n${body}`,
        idempotencyKey: "long-1",
        projectId: project.projectId,
      });

      const graph = yield* api.getAssignmentGraph({ projectId: project.projectId });
      assert.equal(graph.nodes[0]?.title, "Rewrite the panel");
      // The body never reaches the wire: the node carries a title, not a
      // 5KB instruction, and nothing else on it smuggles the text through.
      assert.isBelow(graph.nodes[0]?.title.length ?? 0, 100);
      assert.equal(graph.nodes[0]?.resultLine, null);
    }).pipe(Effect.provide(makeLayer())),
  );

  it.effect("skips an undecodable row instead of failing the whole polled read", () =>
    Effect.gen(function* () {
      const { api, sql, bootstrap, engine } = yield* setup;
      const project = yield* bootstrap.createProject({ name: "Demo" });
      const good = yield* engine.createAssignment({
        requester: { _tag: "captain" },
        recipientBotId: project.secondMate.botId,
        instruction: "Readable.",
        idempotencyKey: "good-1",
        projectId: project.projectId,
      });
      const bad = yield* engine.createAssignment({
        requester: { _tag: "captain" },
        recipientBotId: project.secondMate.botId,
        instruction: "Corrupt.",
        idempotencyKey: "bad-1",
        projectId: project.projectId,
      });
      // Corrupt one row's JSON the way a partial write or a hand-edit would.
      yield* sql`
        UPDATE ade_assignments SET result_json = '{not json'
        WHERE assignment_id = ${bad.assignment.id}
      `;

      const graph = yield* api.getAssignmentGraph({ projectId: project.projectId });

      // The panel still renders, minus the row it could not read.
      assert.deepEqual(
        graph.nodes.map((node) => node.id),
        [good.assignment.id],
      );
      assert.equal(graph.unreadableRows, 1);
    }).pipe(Effect.provide(makeLayer())),
  );
});

// ---------------------------------------------------------------------------
// Screen tab + confirm-gated delete (spec §4.6, S15)
// ---------------------------------------------------------------------------

/** `setup`, but against a live mock Screenbox so desktops really exist. */
const screenSetup = Effect.gen(function* () {
  const mock = yield* Effect.acquireRelease(
    Effect.promise(() => startAdeScreenboxMock({})),
    (started) => Effect.promise(() => started.close()),
  );
  const context = yield* Layer.build(makeLayer({ screenboxBaseUrl: mock.baseUrl }));
  const sql = yield* Effect.service(SqlClient.SqlClient).pipe(Effect.provide(context));
  const api = yield* Effect.service(AdeCaptainApi).pipe(Effect.provide(context));
  const bootstrap = yield* Effect.service(AdeBootstrap).pipe(Effect.provide(context));
  yield* runMigrations().pipe(Effect.provide(context));
  yield* sql`PRAGMA foreign_keys = ON`;
  const seeded = yield* bootstrap.ensureSeeded();
  return { mock, sql, api, bootstrap, firstmateId: seeded.firstmateBotId };
});

const screenCase = <E>(name: string, body: Effect.Effect<void, E, Scope.Scope>) =>
  it.effect(name, () => Effect.scoped(body).pipe(Effect.orDie));

/** Creates a crew bot with computer use already enabled. */
const seedComputerUseBot = (
  api: AdeCaptainApi["Service"],
  bootstrap: AdeBootstrap["Service"],
) =>
  Effect.gen(function* () {
    const bot = yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });
    yield* api.setBotComputerUse({ botId: bot.botId, computerUse: true });
    return bot.botId;
  });

describe("AdeCaptainApi Screen tab", () => {
  screenCase(
    "reports a fresh bot as having no desktop and offers no viewer",
    Effect.gen(function* () {
      const { api, bootstrap, mock } = yield* screenSetup;
      const botId = yield* seedComputerUseBot(api, bootstrap);

      const screen = yield* api.getBotScreen(botId);
      assert.strictEqual(screen.status, "none");
      assert.isNull(screen.viewerPath);
      assert.isTrue(screen.screenboxConfigured);
      assert.strictEqual(screen.viewers, 0);
      // Reading the Screen tab must not provision anything.
      assert.strictEqual(mock.desktops.size, 0);
    }),
  );

  screenCase(
    "starts a desktop on request and only then offers a viewer path",
    Effect.gen(function* () {
      const { api, bootstrap, mock } = yield* screenSetup;
      const botId = yield* seedComputerUseBot(api, bootstrap);

      const started = yield* api.startBotDesktop(botId);
      assert.strictEqual(started.status, "running");
      assert.strictEqual(started.viewerPath, `/ade/screen/${botId}`);
      assert.isTrue(mock.desktops.has(botId));

      const stopped = yield* api.stopBotDesktop(botId);
      assert.strictEqual(stopped.status, "stopped");
      // No viewer path once stopped: the client must not be able to open a
      // socket the proxy would refuse.
      assert.isNull(stopped.viewerPath);
    }),
  );

  screenCase(
    "refuses to start a desktop for a bot whose computer use is off",
    Effect.gen(function* () {
      const { api, bootstrap, mock } = yield* screenSetup;
      const bot = yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });

      const outcome = yield* api.startBotDesktop(bot.botId).pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.strictEqual(outcome.failure.reason, "screenbox_unavailable");
      }
      // A bot nothing is allowed to drive must not get a desktop.
      assert.strictEqual(mock.desktops.size, 0);
    }),
  );

  screenCase(
    "reports an unknown bot as not found rather than as an empty screen",
    Effect.gen(function* () {
      const { api } = yield* screenSetup;
      const outcome = yield* api.getBotScreen("no-such-bot" as BotId).pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.strictEqual(outcome.failure.reason, "bot_not_found");
      }
    }),
  );
});

describe("AdeCaptainApi.deleteBot", () => {
  screenCase(
    "purges the desktop upstream before deleting the row that cascades its record",
    Effect.gen(function* () {
      const { api, bootstrap, mock, sql } = yield* screenSetup;
      const botId = yield* seedComputerUseBot(api, bootstrap);
      yield* api.startBotDesktop(botId);
      assert.isTrue(mock.desktops.has(botId));

      const deleted = yield* api.deleteBot(botId);
      assert.deepStrictEqual(deleted, { botId, desktopPurged: true });

      // Upstream saw both halves of the purge, in order, before the row went.
      const purge = mock.requests
        .map((request) => request.path)
        .filter((path) => path === "/api/desktop/destroy" || path === "/api/desktop/delete-data");
      assert.deepStrictEqual(purge, ["/api/desktop/destroy", "/api/desktop/delete-data"]);
      assert.isFalse(mock.desktops.has(botId));

      const bots = yield* sql<{ bot_id: string }>`
        SELECT bot_id FROM ade_bots WHERE bot_id = ${botId}
      `;
      assert.strictEqual(bots.length, 0);
      // 055's cascade graph takes the children with the row.
      const provisionings = yield* sql<{ bot_id: string }>`
        SELECT bot_id FROM ade_screenbox_provisionings WHERE bot_id = ${botId}
      `;
      assert.strictEqual(provisionings.length, 0);
      const personas = yield* sql<{ bot_id: string }>`
        SELECT bot_id FROM ade_persona_versions WHERE bot_id = ${botId}
      `;
      assert.strictEqual(personas.length, 0);
      const memory = yield* sql<{ bot_id: string }>`
        SELECT bot_id FROM ade_memory_documents WHERE bot_id = ${botId}
      `;
      assert.strictEqual(memory.length, 0);
    }),
  );

  screenCase(
    "deletes a bot that never had a desktop without calling upstream",
    Effect.gen(function* () {
      const { api, bootstrap, mock, sql } = yield* screenSetup;
      const bot = yield* bootstrap.instantiateTemplate({ templateId: "coder", projectId: null });

      const deleted = yield* api.deleteBot(bot.botId);
      assert.deepStrictEqual(deleted, { botId: bot.botId, desktopPurged: false });
      assert.deepStrictEqual(
        mock.requests
          .map((request) => request.path)
          .filter((path) => path.startsWith("/api/desktop/")),
        [],
      );

      const bots = yield* sql<{ bot_id: string }>`
        SELECT bot_id FROM ade_bots WHERE bot_id = ${bot.botId}
      `;
      assert.strictEqual(bots.length, 0);
    }),
  );

  screenCase(
    "refuses to delete the Firstmate and leaves its desktop alone",
    Effect.gen(function* () {
      const { api, mock, sql, firstmateId } = yield* screenSetup;
      yield* api.setBotComputerUse({ botId: firstmateId, computerUse: true });
      yield* api.startBotDesktop(firstmateId);

      const outcome = yield* api.deleteBot(firstmateId).pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.strictEqual(outcome.failure.reason, "firstmate_permanent");
      }
      // The refusal is total: neither the desktop nor the row is touched.
      assert.isTrue(mock.desktops.has(firstmateId));
      const bots = yield* sql<{ bot_id: string }>`
        SELECT bot_id FROM ade_bots WHERE bot_id = ${firstmateId}
      `;
      assert.strictEqual(bots.length, 1);
    }),
  );

  screenCase(
    "refuses an unknown bot",
    Effect.gen(function* () {
      const { api } = yield* screenSetup;
      const outcome = yield* api.deleteBot("no-such-bot" as BotId).pipe(Effect.result);
      assert.strictEqual(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.strictEqual(outcome.failure.reason, "bot_not_found");
      }
    }),
  );
});
