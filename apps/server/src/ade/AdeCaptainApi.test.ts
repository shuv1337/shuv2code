import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import type { AdeBotChatSession, BotId } from "@shuv2code/contracts";

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
