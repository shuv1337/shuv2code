import { describe, expect, it } from "vite-plus/test";

import chatComposerSource from "./ChatComposer.tsx?raw";
import chatViewSource from "../ChatView.tsx?raw";

describe("composer prompt history integration", () => {
  it("projects the active timeline into the composer", () => {
    expect(chatViewSource).toContain("promptHistoryMessages={timelineMessages}");
    expect(chatComposerSource).toContain("promptHistoryMessages: ReadonlyArray<ChatMessage>");
    expect(chatComposerSource).toContain("projectComposerPromptHistory(promptHistoryMessages)");
  });

  it("routes unmodified desktop arrow keys through draft-safe history browsing", () => {
    expect(chatComposerSource).toContain('if (key === "ArrowDown" || key === "ArrowUp")');
    expect(chatComposerSource).toContain("isDomCaretAtVisualEdge(editor, direction)");
    expect(chatComposerSource).toContain("stepComposerPromptHistory(");
    expect(chatComposerSource).toContain("activeBrowse?.draft ?? snapshot.value");
    expect(chatComposerSource).toContain("leavePromptHistory(true)");
  });
});
