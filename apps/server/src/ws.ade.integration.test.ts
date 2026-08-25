/**
 * Authorization boundary for the ADE captain RPCs (spec §5, §7).
 *
 * The point of this test is not the payloads — `AdeCaptainApi.test.ts` covers
 * those — but the seam between the wire and the service: a read-scoped client
 * may look at the fleet and must not be able to change it. Reading the roster
 * and *starting a chat* land on opposite sides of that line, because starting
 * a chat mints a kernel session.
 */
import {
  AuthAdeApproveScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AdeBotDetail,
  type AdeBotScreen,
  type AdeBotGroupId,
  type AdeProjectId,
  type AdeNeedsYouEntry,
  type AdeRoster,
  type BotId,
  type NeedsYouItemId,
  WS_METHODS,
} from "@shuv2code/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import { RpcTest } from "effect/unstable/rpc";

import { AdeCaptainApi } from "./ade/AdeCaptainApi.ts";
import type { AuthenticatedSession } from "./auth/EnvironmentAuth.ts";
import { AdeWsRpcGroup, makeAdeWsRpcLayer } from "./ws.ts";

const authenticatedSession = (
  suffix: string,
  scopes: AuthenticatedSession["scopes"],
): AuthenticatedSession => ({
  sessionId: AuthSessionId.make(`ade-rpc-${suffix}`),
  subject: `ade-rpc-${suffix}`,
  method: "bearer-access-token",
  scopes,
});

const BOT_ID = "bot-1" as BotId;
const PROJECT_ID = "project-1" as AdeProjectId;

const emptyRoster: AdeRoster = { entries: [], projects: [], templates: [], groups: [] };

const botDetail = {
  bot: {
    id: BOT_ID,
    name: "Firstmate",
    displayMeta: null,
    structuralRole: "firstmate",
    roleTag: "Coordinator",
    projectId: null,
    groupId: null,
    activePersonaVersionId: null,
    computerUse: false,
    createdAt: "2026-08-24T00:00:00.000Z",
    archivedAt: null,
  },
  projectName: null,
  memory: {
    botId: BOT_ID,
    content: "",
    updatedAt: "2026-08-24T00:00:00.000Z",
    updatedBy: "system",
  },
  personaVersions: [],
  bindings: [],
  assignments: [],
} as unknown as AdeBotDetail;

const NEEDS_YOU_ITEM_ID = "needs-you-1" as NeedsYouItemId;

const needsYouEntry: AdeNeedsYouEntry = {
  item: {
    id: NEEDS_YOU_ITEM_ID,
    kind: "approval",
    subjectRefs: [],
    status: "open",
    createdAt: "2026-08-24T00:00:00.000Z",
    updatedAt: "2026-08-24T00:00:00.000Z",
    resolvedAt: null,
  },
  title: "A change is waiting for your approval",
  detail: "Approving integrates it.",
  actionable: true,
  action: "approve-deny",
  botId: null,
  projectId: null,
  assignmentId: null,
  integrationCandidateId: null,
  kernelEngine: null,
};

const botScreen = {
  botId: BOT_ID,
  status: "none",
  computerUse: false,
  viewers: 0,
  lastNeededAt: null,
  viewerPath: null,
  screenboxConfigured: true,
} as unknown as AdeBotScreen;

/** Records which methods actually reached the service. */
const stubApi = (calls: Ref.Ref<ReadonlyArray<string>>): AdeCaptainApi["Service"] => {
  const note = <A>(method: string, value: A) =>
    Ref.update(calls, (seen) => [...seen, method]).pipe(Effect.as(value));
  return {
    getRoster: () => note("getRoster", emptyRoster),
    getBot: () => note("getBot", botDetail),
    createBotFromTemplate: () => note("createBotFromTemplate", botDetail),
    createProject: () =>
      note("createProject", {
        project: { id: "project-1", name: "Demo" },
        secondMateBotId: BOT_ID,
      } as unknown as never),
    writeBotMemory: () => note("writeBotMemory", botDetail.memory),
    editBotPersona: () =>
      note("editBotPersona", {
        id: "persona-1",
        botId: BOT_ID,
        content: "Be terse.",
        createdAt: "2026-08-24T00:00:00.000Z",
        activatedAt: null,
      } as unknown as never),
    setBotComputerUse: () => note("setBotComputerUse", botDetail.bot),
    updateBotIdentity: () => note("updateBotIdentity", botDetail.bot),
    upsertBotGroup: () =>
      note("upsertBotGroup", {
        id: "group-1",
        name: "Backend",
        orderIndex: 0,
        createdAt: "2026-08-24T00:00:00.000Z",
      } as unknown as never),
    deleteBotGroup: () =>
      note("deleteBotGroup", { groupId: "group-1", ungroupedBotIds: [BOT_ID] } as unknown as never),
    getBotScreen: () => note("getBotScreen", botScreen),
    startBotDesktop: () =>
      note("startBotDesktop", {
        ...botScreen,
        status: "running",
        viewerPath: `/ade/screen/${BOT_ID}`,
      }),
    stopBotDesktop: () => note("stopBotDesktop", { ...botScreen, status: "stopped" }),
    deleteBot: () => note("deleteBot", { botId: BOT_ID, desktopPurged: true }),
    getNeedsYouCount: () => note("getNeedsYouCount", { open: 3 }),
    listNeedsYou: () =>
      note("listNeedsYou", { entries: [needsYouEntry], open: 1 } as unknown as never),
    getNeedsYouItem: () => note("getNeedsYouItem", needsYouEntry),
    submitNeedsYouDecision: () =>
      note("submitNeedsYouDecision", {
        ...needsYouEntry,
        actionable: false,
        item: { ...needsYouEntry.item, status: "resolved" },
      } as unknown as never),
    getProject: () =>
      note("getProject", {
        project: {
          id: PROJECT_ID,
          name: "Demo",
          secondMateBotId: BOT_ID,
          repoBinding: null,
          integrationPolicyDefault: "agent-review",
          checkCommands: [],
          sharedSpecialistAllowList: "all",
          limitsOverrides: null,
          createdAt: "2026-08-24T00:00:00.000Z",
          updatedAt: "2026-08-24T00:00:00.000Z",
        },
        crew: [],
      } as unknown as never),
    listProjectCandidates: () =>
      note("listProjectCandidates", { candidates: [], unreadableRows: 0 }),
    getProjectPublicationStack: () => note("getProjectPublicationStack", null),
    getAssignmentGraph: () =>
      note("getAssignmentGraph", { nodes: [], bots: [], truncated: false, unreadableRows: 0 }),
    startBotChat: () =>
      note("startBotChat", {
        botId: BOT_ID,
        threadId: `ade-bot-${BOT_ID}`,
        engine: "shuvcode",
        bindingId: "binding-1",
        sessionId: "oc-1",
        startedNow: true,
      } as unknown as never),
  };
};

describe("authenticated ADE captain RPCs", () => {
  it.effect("serves reads to a read-only client and refuses every mutation", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const api = stubApi(calls);

      const readClient = yield* RpcTest.makeClient(AdeWsRpcGroup).pipe(
        Effect.provide(
          makeAdeWsRpcLayer(authenticatedSession("read", [AuthOrchestrationReadScope]), api),
        ),
      );

      assert.deepStrictEqual(yield* readClient[WS_METHODS.adeGetRoster]({}), emptyRoster);
      assert.deepStrictEqual(yield* readClient[WS_METHODS.adeGetNeedsYouCount]({}), { open: 3 });
      assert.strictEqual(
        (yield* readClient[WS_METHODS.adeGetBot]({ botId: BOT_ID })).bot.id,
        BOT_ID,
      );

      // The project view and work graph are projections over ADE tables, so a
      // read-only client must reach all four without an operate scope (S12).
      assert.deepStrictEqual(
        (yield* readClient[WS_METHODS.adeGetProject]({ projectId: PROJECT_ID })).crew,
        [],
      );
      assert.deepStrictEqual(
        yield* readClient[WS_METHODS.adeListProjectCandidates]({ projectId: PROJECT_ID }),
        { candidates: [], unreadableRows: 0 },
      );
      assert.strictEqual(
        yield* readClient[WS_METHODS.adeGetProjectPublicationStack]({ projectId: PROJECT_ID }),
        null,
      );
      assert.deepStrictEqual(
        yield* readClient[WS_METHODS.adeGetAssignmentGraph]({ projectId: null }),
        { nodes: [], bots: [], truncated: false, unreadableRows: 0 },
      );

      const denials = [
        yield* Effect.flip(
          readClient[WS_METHODS.adeCreateBotFromTemplate]({
            templateId: "coder",
            projectId: null,
          }),
        ),
        yield* Effect.flip(
          readClient[WS_METHODS.adeWriteBotMemory]({ botId: BOT_ID, content: "nope" }),
        ),
        yield* Effect.flip(
          readClient[WS_METHODS.adeEditBotPersona]({ botId: BOT_ID, content: "nope" }),
        ),
        yield* Effect.flip(
          readClient[WS_METHODS.adeSetBotComputerUse]({ botId: BOT_ID, computerUse: true }),
        ),
        // Starting a chat mints a kernel session — a write, not a look.
        yield* Effect.flip(readClient[WS_METHODS.adeStartBotChat]({ botId: BOT_ID })),
        // Relabelling and filing bots is organizing the fleet (#197): a
        // read-only client sees the rail and cannot rearrange it.
        yield* Effect.flip(
          readClient[WS_METHODS.adeUpdateBotIdentity]({ botId: BOT_ID, name: "Nope" }),
        ),
        yield* Effect.flip(readClient[WS_METHODS.adeUpsertBotGroup]({ name: "Nope" })),
        yield* Effect.flip(
          readClient[WS_METHODS.adeDeleteBotGroup]({ groupId: "group-1" as AdeBotGroupId }),
        ),
      ];

      for (const denial of denials) {
        assert.strictEqual(denial._tag, "EnvironmentAuthorizationError");
        if (denial._tag !== "EnvironmentAuthorizationError") continue;
        assert.strictEqual(denial.requiredScope, AuthOrchestrationOperateScope);
      }

      // Refusal happens before the service, not inside it.
      assert.deepStrictEqual(yield* Ref.get(calls), [
        "getRoster",
        "getNeedsYouCount",
        "getBot",
        "getProject",
        "listProjectCandidates",
        "getProjectPublicationStack",
        "getAssignmentGraph",
      ]);
    }),
  );

  it.effect("serves every method to an operate-scoped client", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const fullClient = yield* RpcTest.makeClient(AdeWsRpcGroup).pipe(
        Effect.provide(
          makeAdeWsRpcLayer(
            authenticatedSession("full", [
              AuthOrchestrationReadScope,
              AuthOrchestrationOperateScope,
            ]),
            stubApi(calls),
          ),
        ),
      );

      yield* fullClient[WS_METHODS.adeCreateBotFromTemplate]({
        templateId: "coder",
        projectId: null,
      });
      yield* fullClient[WS_METHODS.adeWriteBotMemory]({ botId: BOT_ID, content: "ok" });
      yield* fullClient[WS_METHODS.adeEditBotPersona]({ botId: BOT_ID, content: "Be terse." });
      yield* fullClient[WS_METHODS.adeSetBotComputerUse]({ botId: BOT_ID, computerUse: true });
      const chat = yield* fullClient[WS_METHODS.adeStartBotChat]({ botId: BOT_ID });
      // Rename + decorate + re-tag + re-group in one payload, which is the
      // whole point of there being one identity RPC rather than four.
      yield* fullClient[WS_METHODS.adeUpdateBotIdentity]({
        botId: BOT_ID,
        name: "Number One",
        roleTag: "Coordinator",
        displayMeta: { emoji: "⚓", color: "blue" },
        groupId: "group-1" as AdeBotGroupId,
      });
      const group = yield* fullClient[WS_METHODS.adeUpsertBotGroup]({ name: "Backend" });
      const removed = yield* fullClient[WS_METHODS.adeDeleteBotGroup]({ groupId: group.id });

      assert.strictEqual(chat.threadId, `ade-bot-${BOT_ID}`);
      // Deleting a bucket hands its members back, never deletes them.
      assert.deepStrictEqual(removed.ungroupedBotIds, [BOT_ID]);
      assert.deepStrictEqual(yield* Ref.get(calls), [
        "createBotFromTemplate",
        "writeBotMemory",
        "editBotPersona",
        "setBotComputerUse",
        "startBotChat",
        "updateBotIdentity",
        "upsertBotGroup",
        "deleteBotGroup",
      ]);
    }),
  );
});

/**
 * The `ade:approve` boundary (spec §5, ADR §10.4). Reading what is waiting is
 * a read; *deciding* it is captain authority, and it is deliberately not
 * reachable from `orchestration:operate` — that is what makes a paired phone
 * safe to hand out.
 */
describe("ADE Needs You approval scope", () => {
  it.effect("lets a fully operate-scoped client read the inbox but not decide it", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const client = yield* RpcTest.makeClient(AdeWsRpcGroup).pipe(
        Effect.provide(
          makeAdeWsRpcLayer(
            authenticatedSession("operate", [
              AuthOrchestrationReadScope,
              AuthOrchestrationOperateScope,
            ]),
            stubApi(calls),
          ),
        ),
      );

      const list = yield* client[WS_METHODS.adeListNeedsYou]({ includeResolved: false });
      assert.strictEqual(list.open, 1);
      const detail = yield* client[WS_METHODS.adeGetNeedsYouItem]({
        needsYouItemId: NEEDS_YOU_ITEM_ID,
      });
      assert.strictEqual(detail.actionable, true);

      const denial = yield* Effect.flip(
        client[WS_METHODS.adeSubmitNeedsYouDecision]({
          needsYouItemId: NEEDS_YOU_ITEM_ID,
          decision: "approve",
        }),
      );
      assert.strictEqual(denial._tag, "EnvironmentAuthorizationError");
      if (denial._tag === "EnvironmentAuthorizationError") {
        assert.strictEqual(denial.requiredScope, AuthAdeApproveScope);
      }
      // Refused at the wire: the decision never reached the service.
      assert.deepStrictEqual(yield* Ref.get(calls), ["listNeedsYou", "getNeedsYouItem"]);
    }),
  );

  it.effect("serves approve and deny to an `ade:approve` client", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const client = yield* RpcTest.makeClient(AdeWsRpcGroup).pipe(
        Effect.provide(
          makeAdeWsRpcLayer(
            authenticatedSession("captain", [
              AuthOrchestrationReadScope,
              AuthOrchestrationOperateScope,
              AuthAdeApproveScope,
            ]),
            stubApi(calls),
          ),
        ),
      );

      const approved = yield* client[WS_METHODS.adeSubmitNeedsYouDecision]({
        needsYouItemId: NEEDS_YOU_ITEM_ID,
        decision: "approve",
      });
      assert.strictEqual(approved.item.status, "resolved");
      yield* client[WS_METHODS.adeSubmitNeedsYouDecision]({
        needsYouItemId: NEEDS_YOU_ITEM_ID,
        decision: "deny",
        note: "not yet",
      });

      assert.deepStrictEqual(yield* Ref.get(calls), [
        "submitNeedsYouDecision",
        "submitNeedsYouDecision",
      ]);
    }),
  );

  it.effect("refuses a read-only client the decision as well", () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);
      const client = yield* RpcTest.makeClient(AdeWsRpcGroup).pipe(
        Effect.provide(
          makeAdeWsRpcLayer(
            authenticatedSession("read", [AuthOrchestrationReadScope]),
            stubApi(calls),
          ),
        ),
      );
      const denial = yield* Effect.flip(
        client[WS_METHODS.adeSubmitNeedsYouDecision]({
          needsYouItemId: NEEDS_YOU_ITEM_ID,
          decision: "deny",
        }),
      );
      assert.strictEqual(denial._tag, "EnvironmentAuthorizationError");
      assert.deepStrictEqual(yield* Ref.get(calls), []);
    }),
  );
});
