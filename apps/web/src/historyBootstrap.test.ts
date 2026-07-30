import { MessageId } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildBootstrapInput } from "./historyBootstrap";

const messageId = (value: string) => MessageId.make(value);

describe("buildBootstrapInput", () => {
  it("includes full transcript when under budget", () => {
    const result = buildBootstrapInput(
      [
        {
          id: messageId("u-1"),
          role: "user",
          text: "hello",
          createdAt: "2026-02-09T00:00:00.000Z",
          turnId: null,
          updatedAt: "2026-02-09T00:00:00.000Z",
          streaming: false,
        },
        {
          id: messageId("a-1"),
          role: "assistant",
          text: "world",
          createdAt: "2026-02-09T00:00:01.000Z",
          turnId: null,
          updatedAt: "2026-02-09T00:00:01.000Z",
          streaming: false,
        },
      ],
      "what's next?",
      1_500,
    );

    expect(result.includedCount).toBe(2);
    expect(result.omittedCount).toBe(0);
    expect(result.truncated).toBe(false);
    expect(result.text).toContain("USER:\nhello");
    expect(result.text).toContain("ASSISTANT:\nworld");
    expect(result.text).toContain("Latest user request (answer this now):");
    expect(result.text).toContain("what's next?");
  });

  it("truncates older transcript messages when over budget", () => {
    const result = buildBootstrapInput(
      [
        {
          id: messageId("u-1"),
          role: "user",
          text: "first question with details",
          createdAt: "2026-02-09T00:00:00.000Z",
          turnId: null,
          updatedAt: "2026-02-09T00:00:00.000Z",
          streaming: false,
        },
        {
          id: messageId("a-1"),
          role: "assistant",
          text: "first answer with details",
          createdAt: "2026-02-09T00:00:01.000Z",
          turnId: null,
          updatedAt: "2026-02-09T00:00:01.000Z",
          streaming: false,
        },
        {
          id: messageId("u-2"),
          role: "user",
          text: "second question with details",
          createdAt: "2026-02-09T00:00:02.000Z",
          turnId: null,
          updatedAt: "2026-02-09T00:00:02.000Z",
          streaming: false,
        },
      ],
      "final request",
      320,
    );

    expect(result.truncated).toBe(true);
    expect(result.omittedCount).toBeGreaterThan(0);
    expect(result.includedCount).toBeLessThan(3);
    expect(result.text).toContain("omitted to stay within input limits");
    expect(result.text.length).toBeLessThanOrEqual(320);
  });

  it("preserves the latest prompt when prompt-only fallback is required", () => {
    const latestPrompt = "Please keep this exact latest prompt.";
    const result = buildBootstrapInput(
      [
        {
          id: messageId("u-1"),
          role: "user",
          text: "old context",
          createdAt: "2026-02-09T00:00:00.000Z",
          turnId: null,
          updatedAt: "2026-02-09T00:00:00.000Z",
          streaming: false,
        },
      ],
      latestPrompt,
      latestPrompt.length + 3,
    );

    expect(result.text).toBe(latestPrompt);
    expect(result.includedCount).toBe(0);
    expect(result.omittedCount).toBe(1);
    expect(result.truncated).toBe(true);
  });

  it("captures user image attachment context in transcript blocks", () => {
    const result = buildBootstrapInput(
      [
        {
          id: messageId("u-image"),
          role: "user",
          text: "",
          attachments: [
            {
              type: "image",
              id: "img-1",
              name: "screenshot.png",
              mimeType: "image/png",
              sizeBytes: 2_048,
            },
          ],
          createdAt: "2026-02-09T00:00:00.000Z",
          turnId: null,
          updatedAt: "2026-02-09T00:00:00.000Z",
          streaming: false,
        },
      ],
      "What does this error mean?",
      1_500,
    );

    expect(result.text).toContain("Attached image");
    expect(result.text).toContain("screenshot.png");
  });

  it("stops materializing a 50k-message history once the character budget is full", () => {
    const messages = Array.from({ length: 50_000 }, (_, index) => ({
      id: messageId(`message-${index}`),
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      text: `history-${index}-${"x".repeat(120)}`,
      createdAt: "2026-02-09T00:00:00.000Z",
      turnId: null,
      updatedAt: "2026-02-09T00:00:00.000Z",
      streaming: false,
    }));
    let blockBuilds = 0;

    const result = buildBootstrapInput(messages, "latest request", 4_000, {
      onMessageBlockBuilt: () => {
        blockBuilds += 1;
      },
    });

    expect(result.text.length).toBeLessThanOrEqual(4_000);
    expect(result.text).toContain("history-49999");
    expect(result.omittedCount).toBeGreaterThan(49_900);
    expect(blockBuilds).toBeLessThan(30);
  });
});
