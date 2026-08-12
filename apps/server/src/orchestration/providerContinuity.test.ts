import * as NodeAssert from "node:assert/strict";

import type { OrchestrationMessage } from "@shuv2code/contracts";
import { MessageId, TurnId } from "@shuv2code/contracts";
import { describe, it } from "vite-plus/test";

import { buildProviderContinuityInput } from "./providerContinuity.ts";

const message = (
  id: string,
  role: OrchestrationMessage["role"],
  text: string,
  options?: Partial<OrchestrationMessage>,
): OrchestrationMessage => ({
  id: MessageId.make(id),
  role,
  text,
  turnId: options?.turnId ?? TurnId.make(`turn-${id}`),
  streaming: options?.streaming ?? false,
  createdAt: options?.createdAt ?? "2026-08-12T12:00:00.000Z",
  updatedAt: options?.updatedAt ?? "2026-08-12T12:00:00.000Z",
  ...(options?.attachments === undefined ? {} : { attachments: options.attachments }),
});

describe("buildProviderContinuityInput", () => {
  it("seeds a replacement provider with bounded canonical thread history", () => {
    const result = buildProviderContinuityInput({
      messages: [
        message("user-1", "user", "Investigate the startup delay."),
        message("assistant-1", "assistant", "I traced it to provider resume."),
      ],
      latestUserRequest: "Fix it without replacing this shuv2code thread.",
      maxChars: 2_000,
    });

    NodeAssert.equal(result.includedCount, 2);
    NodeAssert.equal(result.omittedCount, 0);
    NodeAssert.equal(result.truncated, false);
    NodeAssert.match(result.text, /USER:\nInvestigate the startup delay\./);
    NodeAssert.match(result.text, /ASSISTANT:\nI traced it to provider resume\./);
    NodeAssert.match(
      result.text,
      /Latest user request \(answer this now\):\nFix it without replacing this shuv2code thread\./,
    );
  });

  it("summarizes attachments without embedding their contents", () => {
    const result = buildProviderContinuityInput({
      messages: [
        message("user-attachment", "user", "Inspect these.", {
          attachments: [
            {
              type: "image",
              id: "image-1",
              name: "trace.png",
              mimeType: "image/png",
              sizeBytes: 42,
            },
            {
              type: "file",
              id: "file-1",
              name: "report.pdf",
              mimeType: "application/pdf",
              sizeBytes: 84,
            },
          ],
        }),
      ],
      latestUserRequest: "Continue.",
      maxChars: 2_000,
    });

    NodeAssert.match(result.text, /\[Attached files: trace\.png, report\.pdf\]/);
  });

  it("excludes system and incomplete streaming messages from the handoff", () => {
    const result = buildProviderContinuityInput({
      messages: [
        message("system-1", "system", "Internal lifecycle detail."),
        message("assistant-streaming", "assistant", "Partial answer", { streaming: true }),
        message("user-1", "user", "Stable context."),
      ],
      latestUserRequest: "Continue.",
      maxChars: 2_000,
    });

    NodeAssert.equal(result.includedCount, 1);
    NodeAssert.equal(result.omittedCount, 0);
    NodeAssert.doesNotMatch(result.text, /Internal lifecycle detail/);
    NodeAssert.doesNotMatch(result.text, /Partial answer/);
    NodeAssert.match(result.text, /Stable context/);
  });

  it("keeps the newest contiguous suffix and reports omitted history", () => {
    const result = buildProviderContinuityInput({
      messages: [
        message("user-old", "user", `old-${"x".repeat(180)}`),
        message("assistant-old", "assistant", `old-answer-${"y".repeat(180)}`),
        message("user-new", "user", "newest relevant context"),
      ],
      latestUserRequest: "answer this now",
      maxChars: 450,
    });

    NodeAssert.equal(result.truncated, true);
    NodeAssert.ok(result.omittedCount > 0);
    NodeAssert.match(result.text, /earlier message\(s\) omitted/);
    NodeAssert.match(result.text, /newest relevant context/);
    NodeAssert.doesNotMatch(result.text, /old-answer/);
    NodeAssert.ok(result.text.length <= 450);
  });

  it("preserves the latest request as the final fallback", () => {
    const latestUserRequest = "Keep this exact latest request.";
    const result = buildProviderContinuityInput({
      messages: [message("user-old", "user", "Old context")],
      latestUserRequest,
      maxChars: latestUserRequest.length,
    });

    NodeAssert.equal(result.text, latestUserRequest);
    NodeAssert.equal(result.includedCount, 0);
    NodeAssert.equal(result.omittedCount, 1);
    NodeAssert.equal(result.truncated, true);
  });
});
