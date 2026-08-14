import * as NodeAssert from "node:assert/strict";

import { afterEach, describe, it } from "vite-plus/test";

import { createOpenCodeV2Client, type OpenCodeV2Event } from "./opencodeV2Client.ts";
import { type OpenCodeV2Mock, startOpenCodeV2Mock } from "./opencodeV2Mock.testSupport.ts";

describe("startOpenCodeV2Mock", () => {
  let mock: OpenCodeV2Mock | undefined;

  afterEach(async () => {
    await mock?.close();
    mock = undefined;
  });

  it("drives the real client through session, SSE, and form reply routes", async () => {
    mock = await startOpenCodeV2Mock();
    const client = createOpenCodeV2Client({
      baseUrl: mock.baseUrl,
      directory: "/tmp/mock-project",
    });
    const iterator = client.event.subscribe()[Symbol.asyncIterator]();
    const firstEvent = iterator.next();

    await mock.waitForSubscriber();
    const session = await client.session.create({ title: "Fixture integration" });
    NodeAssert.deepEqual(await client.model.list(), {
      data: [
        {
          id: "mock-model",
          providerID: "mock",
          name: "Mock Model",
          enabled: true,
          variants: [],
        },
      ],
    });
    NodeAssert.deepEqual(await client.agent.list(), {
      data: [{ id: "build", mode: "primary", hidden: false }],
    });
    await client.session.prompt(session.id, { text: "Run the script" });

    const events: OpenCodeV2Event[] = [];
    events.push((await firstEvent).value);
    while (events.length < 8) {
      const next = await iterator.next();
      NodeAssert.equal(next.done, false);
      events.push(next.value);
    }
    NodeAssert.deepEqual(
      events.map((event) => event.type),
      [
        "server.connected",
        "session.execution.started",
        "session.text.started",
        "session.text.delta",
        "session.text.ended",
        "session.tool.input.started",
        "session.tool.success",
        "form.created",
      ],
    );

    const forms = await client.form.list(session.id);
    const form = forms[0] as {
      readonly id: string;
      readonly fields: ReadonlyArray<{
        readonly key: string;
        readonly options: ReadonlyArray<{ readonly value: string; readonly label: string }>;
      }>;
    };
    NodeAssert.equal(form.id, "frm_mock_1");
    NodeAssert.deepEqual(form.fields[0]?.options, [{ value: "small", label: "Small change" }]);
    NodeAssert.deepEqual(form.fields[1]?.options, []);

    const answer = { scope: "small", custom: "fixture detail" };
    await client.form.reply(session.id, form.id, answer);
    const resolved = await iterator.next();
    const completed = await iterator.next();
    NodeAssert.equal(resolved.value.type, "form.replied");
    NodeAssert.equal(completed.value.type, "session.execution.succeeded");
    await iterator.return?.();
    NodeAssert.deepEqual(mock.formAnswers, [{ sessionID: session.id, formID: form.id, answer }]);
  }, 5_000);
});
