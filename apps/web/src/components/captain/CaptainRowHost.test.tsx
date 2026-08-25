import { EnvironmentId, ThreadId } from "@shuv2code/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeAll, describe, expect, it, vi } from "vite-plus/test";

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: () => null,
}));

// `MessagesTimeline` imports both of these at module scope; neither is on the
// path this test exercises, and LegendList touches `document` on import.
vi.mock("@legendapp/list/react", () => ({ LegendList: () => null }));

let CaptainRowHost: typeof import("./CaptainRowHost").CaptainRowHost;
let buildCaptainRowSharedState: typeof import("./CaptainRowHost").buildCaptainRowSharedState;
let buildCaptainRowActivityState: typeof import("./CaptainRowHost").buildCaptainRowActivityState;

beforeAll(async () => {
  // `MessagesTimeline` reaches for browser globals at import time; the same
  // stubs `MessagesTimeline.test.tsx` uses keep this a pure markup render.
  const classList = { add: () => {}, remove: () => {}, toggle: () => {}, contains: () => false };
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
    clear: () => {},
  });
  vi.stubGlobal("window", {
    matchMedia: () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    },
    cancelAnimationFrame: () => {},
    desktopBridge: undefined,
  });
  vi.stubGlobal("document", { documentElement: { classList, offsetHeight: 0 } });

  ({ CaptainRowHost, buildCaptainRowSharedState, buildCaptainRowActivityState } =
    await import("./CaptainRowHost"));
}, 30_000);

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const THREAD_ID = ThreadId.make("ade-bot-bot_7");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

function display() {
  return {
    timestampFormat: "locale" as const,
    routeThreadKey: `${ENVIRONMENT_ID}:${THREAD_ID}`,
    threadRef: { environmentId: ENVIRONMENT_ID, threadId: THREAD_ID },
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    resolvedTheme: "light" as const,
    markdownCwd: undefined,
    workspaceRoot: undefined,
  };
}

const WORK_ROW = {
  kind: "work" as const,
  id: "work-row-1",
  createdAt: CREATED_AT,
  groupedEntries: [
    {
      id: "work-1",
      createdAt: CREATED_AT,
      turnId: "turn-1" as never,
      label: "Ran command",
      command: "pnpm test",
      tone: "tool" as const,
    },
  ],
};

describe("CaptainRowHost", () => {
  /**
   * The load-bearing assertion for resolved flaw #1: a `work` row — the row
   * kind that reads the most fields off the shared context — renders outside
   * `MessagesTimeline`, with no `ChatView` anywhere in the tree. If the two
   * `createContext(null!)` contexts were not both supplied, this throws rather
   * than failing an expectation.
   */
  it("mounts a work row outside ChatView", () => {
    const markup = renderToStaticMarkup(<CaptainRowHost display={display()} row={WORK_ROW} />);

    expect(markup).toContain('data-timeline-row-kind="work"');
    expect(markup).toContain('data-timeline-row-id="work-row-1"');
    expect(markup).toContain("Ran command");
  });

  it("renders a captain message row without the workspace revert affordance", () => {
    const markup = renderToStaticMarkup(
      <CaptainRowHost
        display={display()}
        row={{
          kind: "message",
          id: "user-1",
          createdAt: CREATED_AT,
          message: {
            id: "user-1" as never,
            role: "user",
            text: "Fix the retry path",
            turnId: null,
            createdAt: CREATED_AT,
            updatedAt: CREATED_AT,
            streaming: false,
          },
          durationStart: CREATED_AT,
          showAssistantMeta: false,
          showAssistantCopyButton: false,
          assistantCopyStreaming: false,
        }}
      />,
    );

    expect(markup).toContain("Fix the retry path");
    // `revertTurnCount` is absent, so the checkpoint control the workspace
    // would offer never renders — the stub is never exercised as a live button.
    expect(markup.toLowerCase()).not.toContain("restore checkpoint");
  });

  it("enumerates the synthesized shared state: every field, real or stubbed", () => {
    const shared = buildCaptainRowSharedState(display());

    // The contract, spelled out. A new field on `TimelineRowSharedState` fails
    // typecheck in `buildCaptainRowSharedState`; this pins the *classification*
    // so a workspace callback cannot be quietly wired to something live.
    expect(Object.keys(shared).sort()).toEqual(
      [
        "activeThreadEnvironmentId",
        "agentPanelModel",
        "markdownCwd",
        "onImageExpand",
        "onOpenAgents",
        "onOpenTurnDiff",
        "onRevertUserMessage",
        "onToggleAssistantSpeech",
        "onToggleTurnFold",
        "onToggleWorkGroup",
        "resolvedTheme",
        "routeThreadKey",
        "skills",
        "speechPlaybackState",
        "threadRef",
        "timestampFormat",
        "workspaceRoot",
      ].sort(),
    );

    // Real display values.
    expect(shared.routeThreadKey).toBe(`${ENVIRONMENT_ID}:${THREAD_ID}`);
    expect(shared.threadRef).toEqual({ environmentId: ENVIRONMENT_ID, threadId: THREAD_ID });
    expect(shared.activeThreadEnvironmentId).toBe(ENVIRONMENT_ID);
    expect(shared.resolvedTheme).toBe("light");
    expect(shared.timestampFormat).toBe("locale");
    expect(shared.markdownCwd).toBeUndefined();
    expect(shared.workspaceRoot).toBeUndefined();
    expect(shared.skills).toEqual([]);

    // Enumerated stubs: inert, and provably so.
    expect(shared.speechPlaybackState).toEqual({ status: "idle", messageId: null });
    expect(shared.agentPanelModel.hasAgents).toBe(false);
    expect(shared.agentPanelModel.workflows).toEqual([]);
    expect(shared.agentPanelModel.directAgents).toEqual([]);
    expect(shared.onOpenTurnDiff("turn-1" as never)).toBeUndefined();
    expect(shared.onOpenAgents()).toBeUndefined();
    expect(shared.onRevertUserMessage("message-1" as never)).toBeUndefined();
    expect(shared.onToggleAssistantSpeech("message-1" as never, "hi")).toBeUndefined();
  });

  it("never claims to be reverting a checkpoint", () => {
    expect(buildCaptainRowActivityState({ isWorking: true })).toEqual({
      isWorking: true,
      isRevertingCheckpoint: false,
      activeTurnInProgress: false,
      latestTurnId: null,
      workingStepLabel: null,
    });
  });
});
