import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  mapOpenCodeV2FormToQuestions,
  openCodeV2EventSessionId,
  toOpenCodeV2FormAnswer,
} from "./OpenCodeV2Adapter.ts";

describe("OpenCodeV2Adapter form mapping", () => {
  const form = {
    id: "frm_1",
    sessionID: "ses_live",
    title: "Questions",
    metadata: { kind: "question" },
    fields: [
      {
        key: "q0",
        type: "string",
        title: "Scope",
        description: "What scope?",
        options: [{ value: "small", label: "Small", description: "Small change" }],
      },
      {
        key: "q1",
        type: "multiselect",
        title: "Areas",
        options: [
          { value: "server", label: "Server" },
          { value: "web", label: "Web" },
        ],
      },
      { key: "ignored", type: "boolean", title: "Unsupported" },
    ],
  } as const;

  it("finds a nested form session id in live SSE envelopes", () => {
    NodeAssert.equal(
      openCodeV2EventSessionId({
        type: "form.created",
        data: { form: { id: "frm_1", sessionID: "ses_live", fields: [] } },
      }),
      "ses_live",
    );
  });

  it("uses stable field keys and preserves custom-only string questions", () => {
    NodeAssert.deepEqual(mapOpenCodeV2FormToQuestions(form), [
      {
        id: "q0",
        header: "Scope",
        question: "What scope?",
        options: [{ label: "Small", description: "Small change" }],
        multiSelect: false,
      },
      {
        id: "q1",
        header: "Areas",
        question: "Areas",
        options: [
          { label: "Server", description: "Server" },
          { label: "Web", description: "Web" },
        ],
        multiSelect: true,
      },
    ]);
  });

  it("submits mapped fields only", () => {
    NodeAssert.deepEqual(
      toOpenCodeV2FormAnswer(form, {
        q0: "custom scope",
        q1: ["Server", "Web"],
        stale: "do not submit",
      }),
      {
        q0: "custom scope",
        q1: ["Server", "Web"],
      },
    );
  });
});
