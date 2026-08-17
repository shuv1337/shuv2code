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
  canBrowseComposerPromptHistory,
  IMAGE_ONLY_BOOTSTRAP_PROMPT,
  FILE_ONLY_BOOTSTRAP_PROMPT,
  isComposerPromptHistoryBlankHardEdge,
  isComposerPromptHistoryPositionValid,
  projectComposerPromptHistory,
  reconcileComposerPromptHistoryBrowse,
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
        message(FILE_ONLY_BOOTSTRAP_PROMPT),
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

describe("canBrowseComposerPromptHistory", () => {
  const eligibility = {
    direction: "older" as const,
    value: "draft",
    cursor: 0,
    isVisualEdge: true,
    isMobileViewport: false,
    hasModifier: false,
    isComposing: false,
    keyCode: 38,
    isBlocked: false,
    hasTerminalContexts: false,
    hasActiveTrigger: false,
    hasActiveBrowse: false,
    isSelectionCollapsed: true,
  };

  it("accepts unmodified desktop arrows only at the matching visual and logical edge", () => {
    expect(canBrowseComposerPromptHistory(eligibility)).toBe(true);
    expect(
      canBrowseComposerPromptHistory({
        ...eligibility,
        direction: "newer",
        cursor: eligibility.value.length,
        keyCode: 40,
      }),
    ).toBe(true);
    expect(canBrowseComposerPromptHistory({ ...eligibility, isVisualEdge: false })).toBe(false);
  });

  it("keeps multiline navigation inside the editor until the caret reaches the outer line", () => {
    const value = "top line\nbottom line";

    expect(canBrowseComposerPromptHistory({ ...eligibility, value, cursor: 4 })).toBe(true);
    expect(canBrowseComposerPromptHistory({ ...eligibility, value, cursor: 12 })).toBe(false);
    expect(
      canBrowseComposerPromptHistory({
        ...eligibility,
        direction: "newer",
        value,
        cursor: 4,
        keyCode: 40,
      }),
    ).toBe(false);
    expect(
      canBrowseComposerPromptHistory({
        ...eligibility,
        direction: "newer",
        value,
        cursor: value.length,
        keyCode: 40,
      }),
    ).toBe(true);
  });

  it("leaves mobile, modified, composing, selected, and blocked arrows to the editor", () => {
    const rejectedOverrides = [
      { isMobileViewport: true },
      { hasModifier: true },
      { isComposing: true },
      { keyCode: 229 },
      { isBlocked: true },
      { hasTerminalContexts: true },
      { isSelectionCollapsed: false },
      { hasActiveTrigger: true },
    ];

    for (const override of rejectedOverrides) {
      expect(canBrowseComposerPromptHistory({ ...eligibility, ...override })).toBe(false);
    }
    expect(
      canBrowseComposerPromptHistory({
        ...eligibility,
        hasActiveTrigger: true,
        hasActiveBrowse: true,
      }),
    ).toBe(true);
  });
});

describe("reconcileComposerPromptHistoryBrowse", () => {
  const target = "environment:thread-1";
  const browse = {
    target,
    index: 1,
    draft: "unfinished draft",
    recalledValue: "newest prompt",
  };
  const entries = ["oldest prompt", "newest prompt"];

  it("keeps an unchanged recalled prompt active", () => {
    expect(reconcileComposerPromptHistoryBrowse(browse, target, "newest prompt", entries)).toBe(
      "keep",
    );
  });

  it("discards the captured draft once the recalled prompt is edited", () => {
    expect(
      reconcileComposerPromptHistoryBrowse(browse, target, "newest prompt, edited", entries),
    ).toBe("discard");
  });

  it("restores the captured draft when the composer switches threads", () => {
    expect(
      reconcileComposerPromptHistoryBrowse(
        browse,
        "environment:thread-2",
        "other thread draft",
        entries,
      ),
    ).toBe("restore");
  });

  it("restores the captured draft if the recalled timeline entry disappears", () => {
    expect(
      reconcileComposerPromptHistoryBrowse(browse, target, "newest prompt", ["oldest prompt"]),
    ).toBe("restore");
  });

  it("returns from the newest recalled prompt to the original draft on ArrowDown", () => {
    expect(stepComposerPromptHistory(entries, browse.index, "newer")).toEqual({ kind: "draft" });
    expect(browse.draft).toBe("unfinished draft");
  });
});
