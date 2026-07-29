import { describe, expect, it } from "vite-plus/test";
import type { ChatMessage } from "../../types";
import { appendTerminalContextsToPrompt } from "../../lib/terminalContext";
import { appendElementContextsToPrompt } from "../../lib/elementContext";
import { appendPreviewAnnotationPrompt } from "../../lib/previewAnnotation";
import {
  appendReviewCommentsToPrompt,
  type ReviewCommentContext,
} from "../../reviewCommentContext";
import {
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
  isComposerPromptHistoryBlankHardEdge,
  isComposerPromptHistoryPositionValid,
  projectComposerPromptHistory,
  stepComposerPromptHistory,
} from "./composerPromptHistory";

function message(text: string, role: ChatMessage["role"] = "user"): ChatMessage {
  return {
    id: `message-${text}`,
    role,
    text,
    turnId: null,
    streaming: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as ChatMessage;
}

describe("projectComposerPromptHistory", () => {
  it("keeps plain and multiline authored text in timeline order", () => {
    expect(
      projectComposerPromptHistory([
        message("  first prompt  "),
        message("ignored", "assistant"),
        message("line one\n  line two\nline three"),
      ]),
    ).toEqual(["first prompt", "line one\n  line two\nline three"]);
  });

  it("strips terminal and element context payloads", () => {
    const withTerminal = appendTerminalContextsToPrompt("inspect terminal", [
      {
        terminalId: "terminal-1",
        terminalLabel: "Terminal 1",
        lineStart: 2,
        lineEnd: 2,
        text: "git status",
      },
    ]);
    const withElement = appendElementContextsToPrompt(withTerminal, [
      {
        pageUrl: "https://example.com",
        pageTitle: "Example",
        tagName: "button",
        selector: "button.save",
        htmlPreview: "<button>Save</button>",
        componentName: null,
        source: null,
        styles: "",
      },
    ]);

    expect(projectComposerPromptHistory([message(withElement)])).toEqual(["inspect terminal"]);
    expect(projectComposerPromptHistory([message(appendElementContextsToPrompt("", []))])).toEqual(
      [],
    );
  });

  it("repeatedly strips preview annotations", () => {
    const annotation = {
      id: "annotation-1",
      pageUrl: "https://example.com",
      pageTitle: "Example",
      comment: "Make this clearer",
      elements: [],
      regions: [],
      strokes: [],
      styleChanges: [],
      screenshot: null,
      createdAt: "2026-01-01T00:00:00.000Z",
    } as const;
    const prompt = appendPreviewAnnotationPrompt(
      appendPreviewAnnotationPrompt("authored", annotation),
      { ...annotation, id: "annotation-2" },
    );

    expect(projectComposerPromptHistory([message(prompt)])).toEqual(["authored"]);
    expect(
      projectComposerPromptHistory([message(appendPreviewAnnotationPrompt("", annotation))]),
    ).toEqual([]);
  });

  it("removes review comments while retaining ordinary text segments", () => {
    const comment: ReviewCommentContext = {
      id: "comment-1",
      sectionId: "file:src/app.ts",
      sectionTitle: "src/app.ts",
      filePath: "src/app.ts",
      startIndex: 0,
      endIndex: 0,
      rangeLabel: "L1",
      text: "Rename this.",
      diff: "const oldName = true;",
      fenceLanguage: "ts",
    };

    expect(
      projectComposerPromptHistory([
        message(appendReviewCommentsToPrompt("keep this text", [comment])),
        message(appendReviewCommentsToPrompt("", [comment])),
      ]),
    ).toEqual(["keep this text"]);
  });

  it("filters empty, context-only, and synthetic image-only entries", () => {
    const contextOnly = appendElementContextsToPrompt("", [
      {
        pageUrl: "https://example.com",
        pageTitle: "Example",
        tagName: "main",
        selector: "main",
        htmlPreview: "<main>Content</main>",
        componentName: null,
        source: null,
        styles: "",
      },
    ]);
    expect(
      projectComposerPromptHistory([
        message(" \n "),
        message(contextOnly),
        message(IMAGE_ONLY_BOOTSTRAP_PROMPT),
      ]),
    ).toEqual([]);
  });

  it("filters the exact Ultrathink image-only fallback only when attachments prove it", () => {
    const prefixedFallback = `Ultrathink:\n${IMAGE_ONLY_BOOTSTRAP_PROMPT}`;
    const attachedFallback = {
      ...message(prefixedFallback),
      attachments: [
        {
          type: "image" as const,
          id: "image-1",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 42,
        },
      ],
    };
    const authoredUltrathink = {
      ...message("Ultrathink:\nDescribe this image"),
      attachments: attachedFallback.attachments,
    };

    expect(
      projectComposerPromptHistory([
        attachedFallback,
        message(prefixedFallback),
        authoredUltrathink,
      ]),
    ).toEqual([prefixedFallback, "Ultrathink:\nDescribe this image"]);
  });

  it("includes optimistic input and collapses only consecutive duplicates", () => {
    const alreadyMergedTimeline = [
      message("one"),
      message("one"),
      message("two"),
      message("one"),
      message("optimistic prompt"),
    ];
    expect(projectComposerPromptHistory(alreadyMergedTimeline)).toEqual([
      "one",
      "two",
      "one",
      "optimistic prompt",
    ]);
  });
});

describe("isComposerPromptHistoryBlankHardEdge", () => {
  it("recognizes only blank leading and trailing hard lines", () => {
    expect(isComposerPromptHistoryBlankHardEdge("\ntext", 0, "older")).toBe(true);
    expect(isComposerPromptHistoryBlankHardEdge("text\n", 5, "newer")).toBe(true);
    expect(isComposerPromptHistoryBlankHardEdge("\ntext", 1, "older")).toBe(false);
    expect(isComposerPromptHistoryBlankHardEdge("text\n", 4, "newer")).toBe(false);
    expect(isComposerPromptHistoryBlankHardEdge("text", 0, "older")).toBe(false);
    expect(isComposerPromptHistoryBlankHardEdge("text", 4, "newer")).toBe(false);
  });
});

describe("stepComposerPromptHistory", () => {
  const entries = ["oldest", "middle", "newest"];

  it("walks older from the live draft and stops at the oldest entry", () => {
    expect(stepComposerPromptHistory(entries, null, "older")).toEqual({
      kind: "entry",
      index: 2,
    });
    expect(stepComposerPromptHistory(entries, 2, "older")).toEqual({ kind: "entry", index: 1 });
    expect(stepComposerPromptHistory(entries, 0, "older")).toEqual({ kind: "boundary" });
  });

  it("walks newer and signals a return to the captured draft", () => {
    expect(stepComposerPromptHistory(entries, 0, "newer")).toEqual({ kind: "entry", index: 1 });
    expect(stepComposerPromptHistory(entries, 2, "newer")).toEqual({ kind: "draft" });
    expect(stepComposerPromptHistory(entries, null, "newer")).toEqual({ kind: "boundary" });
  });

  it("signals invalid positions after a list shrink", () => {
    expect(isComposerPromptHistoryPositionValid(entries, 2, "newest")).toBe(true);
    expect(isComposerPromptHistoryPositionValid(entries.slice(0, 2), 2, "newest")).toBe(false);
    expect(isComposerPromptHistoryPositionValid(["oldest", "replacement"], 1, "middle")).toBe(
      false,
    );
  });

  it("restores the draft when the current index is out of range", () => {
    expect(stepComposerPromptHistory(entries.slice(0, 2), 2, "newer")).toEqual({ kind: "draft" });
    expect(stepComposerPromptHistory(entries.slice(0, 2), 2, "older")).toEqual({ kind: "draft" });
    expect(stepComposerPromptHistory(entries, -1, "newer")).toEqual({ kind: "draft" });
  });
});
