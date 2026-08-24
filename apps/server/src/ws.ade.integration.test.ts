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
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSessionId,
  type AdeBotDetail,
  type AdeRoster,
  type BotId,
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

const emptyRoster: AdeRoster = { entries: [], projects: [], templates: [] };

const botDetail = {
  bot: {
    id: BOT_ID,
    name: "Firstmate",
    displayMeta: null,
    structuralRole: "firstmate",
    roleTag: "Coordinator",
    projectId: null,
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
    getNeedsYouCount: () => note("getNeedsYouCount", { open: 3 }),
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
      ];

      for (const denial of denials) {
        assert.strictEqual(denial._tag, "EnvironmentAuthorizationError");
        if (denial._tag !== "EnvironmentAuthorizationError") continue;
        assert.strictEqual(denial.requiredScope, AuthOrchestrationOperateScope);
      }

      // Refusal happens before the service, not inside it.
      assert.deepStrictEqual(yield* Ref.get(calls), ["getRoster", "getNeedsYouCount", "getBot"]);
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

      assert.strictEqual(chat.threadId, `ade-bot-${BOT_ID}`);
      assert.deepStrictEqual(yield* Ref.get(calls), [
        "createBotFromTemplate",
        "writeBotMemory",
        "editBotPersona",
        "setBotComputerUse",
        "startBotChat",
      ]);
    }),
  );
});
