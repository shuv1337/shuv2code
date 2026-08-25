import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { AdeBotChatSession, AdeProjectId, BotId } from "@shuv2code/contracts";

import { runMigrations } from "../persistence/Migrations.ts";
import * as NodeSqliteClient from "../persistence/NodeSqliteClient.ts";
import { AdeAssignmentEngine, AdeAssignmentKernelPort } from "./AdeAssignmentEngine.ts";
import { AdeBootstrap } from "./AdeBootstrap.ts";
import { AdeCaptainApi } from "./AdeCaptainApi.ts";
import { AdeChatSessionPort } from "./AdeChatSessionPort.ts";
import { AdePersonaMemory } from "./AdePersonaMemory.ts";
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

const makeLayer = (chatPort: Layer.Layer<AdeChatSessionPort> = chatPortOk) =>
  AdeCaptainApi.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        AdeBootstrap.layer,
        AdePersonaMemory.layer,
        AdeSessionRollover.layer,
        AdeAssignmentEngine.layer,
        chatPort,
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
    }).pipe(Effect.provide(makeLayer(AdeChatSessionPort.layerUnavailable))),
  );
});

// ---------------------------------------------------------------------------
// Project view + work graph (spec §7 slices 3, 4 — issue #166)
// ---------------------------------------------------------------------------

type Sql = SqlClient.SqlClient;

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
    readonly bounce?: { reason: string; detail: string; at: string } | null;
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
    ${row.bounce == null ? 0 : 1}, ${row.bounce == null ? null : JSON.stringify(row.bounce)},
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
        bounce: {
          reason: "checks-failed",
          detail: "vp check exited 1",
          at: "2026-08-24T00:01:00.000Z",
        },
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

      const parked = yield* api.listProjectCandidates({
        projectId: project.projectId,
        statuses: ["awaiting-approval"],
      });
      assert.deepEqual(
        parked.candidates.map((candidate) => candidate.id),
        ["cand-awaiting"],
      );

      // An empty filter means "no narrowing", not "match nothing".
      const unfiltered = yield* api.listProjectCandidates({
        projectId: project.projectId,
        statuses: [],
      });
      assert.lengthOf(unfiltered.candidates, 2);
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
        scoped.nodes.map((node) => node.assignment.instruction),
        ["Land the feature.", "Write the panel."],
      );
      const root = scoped.nodes[0];
      assert.equal(root?.assignment.parentAssignmentId, null);
      // Two children exist; only one is inside this scope.
      assert.equal(root?.childCount, 2);
      assert.equal(root?.projectName, "Demo");
      assert.equal(scoped.nodes[1]?.assignment.parentAssignmentId, parent.assignment.id);
      assert.equal(scoped.nodes[1]?.botName, (yield* api.getBot(coder.botId)).bot.name);
      assert.deepEqual(
        scoped.bots.map((bot) => bot.id).toSorted(),
        [coder.botId, project.secondMate.botId].toSorted(),
      );

      // Fleet-wide sees all three, and a fleet-shared bot has no project name.
      const fleet = yield* api.getAssignmentGraph({ projectId: null });
      assert.lengthOf(fleet.nodes, 3);
      const offProject = fleet.nodes.find(
        (node) => node.assignment.instruction === "Go read the spec.",
      );
      assert.equal(offProject?.projectName, null);
      assert.equal(offProject?.botName, (yield* api.getBot(shared.botId)).bot.name);
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
});
