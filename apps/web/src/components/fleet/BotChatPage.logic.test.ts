import type { AdeBotChatSession, AdeBotDetail, BotId, ThreadId } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOT_CHAT_KERNEL_DOWN_NOTICE,
  BOT_CHAT_TOOLS_MISSING_NOTICE,
  botChatStartNotice,
  canAutoConnect,
  CHAT_SYNC_TIMEOUT_MS,
  getBotChatBody,
  getBotChatHeaderView,
  isBotChatComposerDisabled,
  resolveBotChatConnectState,
  resolveChatSyncOutcome,
  shouldAutoStartChat,
  shouldWarnToolsMissing,
  type BotChatBody,
  type ChatSyncOutcome,
} from "./BotChatPage.logic";

const chatSession = (toolsProbe: AdeBotChatSession["toolsProbe"]): AdeBotChatSession => ({
  botId: "bot_1" as AdeBotChatSession["botId"],
  threadId: "ade-bot-bot_1" as ThreadId,
  engine: "shuvcode",
  bindingId: "binding_1" as AdeBotChatSession["bindingId"],
  sessionId: "oc-1" as AdeBotChatSession["sessionId"],
  startedNow: false,
  toolsProbe,
  toolsAttached: toolsProbe !== "missing",
});

describe("shouldWarnToolsMissing", () => {
  it("warns only when the kernel answered and the catalog was not there", () => {
    expect(shouldWarnToolsMissing(chatSession("missing"))).toBe(true);
    expect(shouldWarnToolsMissing(chatSession("attached"))).toBe(false);
  });

  it("stays silent on an unanswerable probe (#199)", () => {
    // A restarted server cannot ask the kernel before it stands the session
    // back up. Claiming the fleet tools are gone there is a false negative
    // that never clears, because nothing re-checks it until the next start.
    expect(shouldWarnToolsMissing(chatSession("unknown"))).toBe(false);
  });
});

function detail(overrides: Partial<AdeBotDetail> = {}): AdeBotDetail {
  return {
    bot: {
      id: "bot_1",
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
      botId: "bot_1",
      content: "",
      updatedAt: "2026-08-24T00:00:00.000Z",
      updatedBy: "system",
    },
    personaVersions: [],
    bindings: [],
    assignments: [],
    ...overrides,
  } as unknown as AdeBotDetail;
}

const activeBinding = {
  id: "bnd_1",
  botId: "bot_1",
  engine: "shuvcode",
  sessionId: "ses_1",
  purpose: "primary-text",
  status: "active",
  rolloverSummary: null,
  createdAt: "2026-08-24T00:00:00.000Z",
  updatedAt: "2026-08-24T00:00:00.000Z",
};

describe("getBotChatBody", () => {
  it("connects rather than landing while the detail is loading", () => {
    expect(getBotChatBody({ detail: null, startedThreadId: null })).toEqual({
      kind: "connecting",
    });
  });

  it("has no interstitial arm at all: a bot with no binding still connects", () => {
    // #217 removed the landing page. There is no `welcome` kind left to
    // return, so a bot the captain has never chatted to is indistinguishable
    // from one that is mid-connect — which is the point.
    expect(getBotChatBody({ detail: detail(), startedThreadId: null }).kind).toBe("connecting");
  });

  it("does not fork on a warm primary binding", () => {
    // The "Start chatting" / "Resume chatting" fork is gone: both cases open
    // the conversation, so the binding no longer drives any rendering.
    const warm = getBotChatBody({
      detail: detail({ bindings: [activeBinding] as never }),
      startedThreadId: null,
    });
    const cold = getBotChatBody({ detail: detail(), startedThreadId: null });
    expect(warm).toEqual(cold);
  });

  it("renders the conversation once a thread has been handed back", () => {
    expect(
      getBotChatBody({
        detail: detail(),
        startedThreadId: "thr_1" as ThreadId,
      }),
    ).toEqual({ kind: "chat", threadId: "thr_1" });
  });
});

describe("shouldAutoStartChat", () => {
  const botId = "bot_1" as BotId;
  const healthy = { environmentReady: true, kernelHealth: "healthy" } as const;

  it("starts once on mount", () => {
    expect(shouldAutoStartChat({ botId, ...healthy, startedFor: null })).toBe(true);
  });

  it("is safe under a StrictMode-style double-invoked mount effect", () => {
    // The effect writes the ref synchronously before awaiting, so the second
    // invocation of the same mount sees the bot the first one recorded.
    let startedFor: BotId | null = null;
    let starts = 0;
    const runEffect = () => {
      if (!shouldAutoStartChat({ botId, ...healthy, startedFor })) return;
      startedFor = botId;
      starts += 1;
    };
    runEffect();
    runEffect();
    expect(starts).toBe(1);
  });

  it("never burns the mount's one attempt before the environment resolves", () => {
    expect(
      shouldAutoStartChat({
        botId,
        environmentReady: false,
        kernelHealth: "healthy",
        startedFor: null,
      }),
    ).toBe(false);
  });

  it("reconnects when the shell swaps the conversation under the same mount", () => {
    expect(shouldAutoStartChat({ botId: "bot_2" as BotId, ...healthy, startedFor: botId })).toBe(
      true,
    );
  });

  it("does not let navigation alone touch the server when the kernel is down", () => {
    // `startPrimaryChat` creates the durable thread *before* it attempts the
    // session, so a rail sweep with the kernel down would materialise one
    // permanent thread per bot passed over, every visit.
    for (const kernelHealth of ["down", "unknown", "not-provisioned", null] as const) {
      expect(
        shouldAutoStartChat({ botId, environmentReady: true, kernelHealth, startedFor: null }),
      ).toBe(false);
    }
  });
});

describe("canAutoConnect", () => {
  it("auto-connects only on a positively healthy kernel", () => {
    expect(canAutoConnect("healthy")).toBe(true);
  });

  it("treats an unknown or absent snapshot as do-not-connect", () => {
    // Guessing wrong here costs one button press; guessing wrong the other way
    // writes durable rows.
    for (const state of ["down", "unknown", "not-provisioned", null] as const) {
      expect(canAutoConnect(state)).toBe(false);
    }
  });
});

describe("resolveBotChatConnectState", () => {
  const connecting: BotChatBody = { kind: "connecting" };
  const waiting: ChatSyncOutcome = { kind: "waiting" };

  it("connects while the thread is on its way, and the composer stays shut", () => {
    const state = resolveBotChatConnectState({
      body: connecting,
      syncOutcome: waiting,
      startError: null,
      chatReady: false,
      autoConnectBlocked: false,
    });
    expect(state.kind).toBe("connecting");
    expect(isBotChatComposerDisabled(state)).toBe(true);
  });

  it("opens the composer only once the thread is safe to mount", () => {
    const state = resolveBotChatConnectState({
      body: { kind: "chat", threadId: "thr_1" as ThreadId },
      syncOutcome: { kind: "ready" },
      startError: null,
      chatReady: true,
      autoConnectBlocked: false,
    });
    expect(state.kind).toBe("ready");
    expect(isBotChatComposerDisabled(state)).toBe(false);
  });

  it("fails with a headline and keeps remediation behind the disclosure", () => {
    const state = resolveBotChatConnectState({
      body: connecting,
      syncOutcome: waiting,
      startError: botChatStartNotice({
        _tag: "AdeCaptainError",
        reason: "session_unavailable",
        message: "No 'opencode2' provider instance is configured. Add one in Settings → Providers.",
      }),
      chatReady: false,
      autoConnectBlocked: false,
    });
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") return;
    /*
     * Cause-neutral. `session_unavailable` is a bucket covering a missing
     * project, an unbound repo, a failed workspace create, a down kernel and a
     * model-less provider instance, so the headline may not assert any one of
     * them — an earlier cut said "check its provider settings" and was
     * confidently wrong for most causes.
     */
    expect(state.notice.message).toBe("This bot isn't connected.");
    expect(state.notice.message).not.toContain("provider");
    expect(state.notice.message).not.toContain("opencode2");
    // The server already names the real remedy; it rides in the disclosure.
    expect(state.notice.details).toContain("Settings → Providers");
    expect(isBotChatComposerDisabled(state)).toBe(true);
  });

  it("shows the kernel-down notice without having asked the server", () => {
    const state = resolveBotChatConnectState({
      body: connecting,
      syncOutcome: waiting,
      startError: null,
      chatReady: false,
      autoConnectBlocked: true,
    });
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") return;
    expect(state.notice).toBe(BOT_CHAT_KERNEL_DOWN_NOTICE);
    // Retry is still offered, and the disclosure says so.
    expect(state.notice.details).toContain("Retry");
  });

  it("waits rather than claiming a failure before health has been read", () => {
    /*
     * A pre-first-frame `null` snapshot must not raise the kernel-down notice:
     * the caller passes `autoConnectBlocked: false` for it precisely so a cold
     * load does not flash a failure and then silently connect. It still does
     * not auto-start — that is `canAutoConnect(null) === false`, tested above.
     */
    const state = resolveBotChatConnectState({
      body: connecting,
      syncOutcome: waiting,
      startError: null,
      chatReady: false,
      autoConnectBlocked: false,
    });
    expect(state.kind).toBe("connecting");
  });

  it("never throws a live conversation away over a health snapshot", () => {
    // A session that outlived the kernel going down, or a Retry that beat the
    // pill, keeps its conversation.
    const state = resolveBotChatConnectState({
      body: { kind: "chat", threadId: "thr_1" as ThreadId },
      syncOutcome: { kind: "ready" },
      startError: null,
      chatReady: true,
      autoConnectBlocked: true,
    });
    expect(state.kind).toBe("ready");
  });

  it("lets a real start failure outrank the blocked-connect notice", () => {
    const state = resolveBotChatConnectState({
      body: connecting,
      syncOutcome: waiting,
      startError: { message: "That bot no longer exists.", details: null },
      chatReady: false,
      autoConnectBlocked: true,
    });
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") return;
    expect(state.notice.message).toBe("That bot no longer exists.");
  });

  it("reports a failed read of the bot ahead of any session state", () => {
    const state = resolveBotChatConnectState({
      body: { kind: "error", message: "That bot no longer exists.", details: null },
      syncOutcome: waiting,
      startError: null,
      chatReady: true,
      autoConnectBlocked: false,
    });
    expect(state.kind).toBe("failed");
  });

  it("surfaces a terminal sync outcome as the notice", () => {
    const state = resolveBotChatConnectState({
      body: { kind: "chat", threadId: "thr_1" as ThreadId },
      syncOutcome: {
        kind: "retry",
        message: "This conversation didn't finish loading.",
        details: null,
      },
      startError: null,
      chatReady: false,
      autoConnectBlocked: false,
    });
    expect(state.kind).toBe("failed");
    if (state.kind !== "failed") return;
    expect(state.notice.message).toBe("This conversation didn't finish loading.");
  });
});

describe("captain-surface copy tone (#217)", () => {
  /**
   * The captain's critique was that the UI narrated itself. These are the
   * phrasings that earned it; none of them may come back through this module.
   */
  const BANNED = [
    "standing by",
    "already has a session open",
    "no session starts until you say so",
    "Nothing is running yet",
    "it will tell you what is missing",
    "Start chatting",
    "Resume chatting",
  ];

  it("keeps narration out of every string this module can produce", () => {
    // Every entry must be read *out of* the module. An earlier cut wrote the
    // expected sentence inline and asserted it against itself, which passes
    // however the module is reworded.
    const missing = resolveChatSyncOutcome({
      renderState: "missing",
      threadShellExists: false,
      elapsedMs: 0,
    });
    const timedOut = resolveChatSyncOutcome({
      renderState: "loading",
      threadShellExists: false,
      elapsedMs: CHAT_SYNC_TIMEOUT_MS,
    });
    const strings = [
      BOT_CHAT_TOOLS_MISSING_NOTICE.message,
      BOT_CHAT_TOOLS_MISSING_NOTICE.details ?? "",
      BOT_CHAT_KERNEL_DOWN_NOTICE.message,
      BOT_CHAT_KERNEL_DOWN_NOTICE.details ?? "",
      botChatStartNotice(new Error("boom")).message,
      missing.kind === "retry" ? missing.message : "",
      timedOut.kind === "retry" ? timedOut.message : "",
    ];
    // Guards against the list silently becoming empty strings.
    expect(strings.every((value) => value.length > 0)).toBe(true);
    for (const value of strings) {
      for (const banned of BANNED) {
        expect(value).not.toContain(banned);
      }
    }
  });

  it("puts the kernel remediation in the disclosure, not the headline", () => {
    expect(BOT_CHAT_TOOLS_MISSING_NOTICE.message).not.toContain("kernel");
    expect(BOT_CHAT_TOOLS_MISSING_NOTICE.message.split(".").length).toBeLessThanOrEqual(2);
    expect(BOT_CHAT_TOOLS_MISSING_NOTICE.details).toContain("shuvcode service");
  });
});

describe("getBotChatHeaderView", () => {
  it("counts open work and names the running instruction", () => {
    const view = getBotChatHeaderView(
      detail({
        projectName: "shuv2code",
        assignments: [
          { status: "queued", instruction: "Wait your turn." },
          { status: "running", instruction: "Audit the retry path." },
          { status: "completed", instruction: "Already done." },
        ] as never,
      }),
    );
    expect(view.projectLabel).toBe("shuv2code");
    expect(view.roleLabel).toBe("Firstmate");
    expect(view.openAssignmentLabel).toBe("2 open assignments");
    expect(view.runningInstruction).toBe("Audit the retry path.");
  });

  it("says nothing about assignments when there are none open", () => {
    const view = getBotChatHeaderView(
      detail({ assignments: [{ status: "completed", instruction: "Done." }] as never }),
    );
    expect(view.openAssignmentLabel).toBeNull();
    expect(view.runningInstruction).toBeNull();
    expect(view.projectLabel).toBe("Fleet-wide");
  });
});

describe("getBotChatBody load failures", () => {
  it("reports a failed read instead of spinning on skeletons forever", () => {
    const body = getBotChatBody({
      detail: null,
      startedThreadId: null,
      loadError: {
        _tag: "AdeCaptainError",
        reason: "bot_not_found",
        message: "ADE bot 'bot_1' does not exist.",
      },
    });
    expect(body.kind).toBe("error");
    if (body.kind !== "error") return;
    // Headline is the closed-reason sentence; the server's own words are the
    // disclosure. Concatenating them is what produced the wall of text #217
    // removed.
    expect(body.message).toBe("That bot no longer exists.");
    expect(body.details).toContain("does not exist");
  });

  it("still connects while nothing has failed", () => {
    expect(getBotChatBody({ detail: null, startedThreadId: null }).kind).toBe("connecting");
    expect(getBotChatBody({ detail: null, startedThreadId: null, loadError: null }).kind).toBe(
      "connecting",
    );
  });
});

describe("resolveChatSyncOutcome", () => {
  const base = { threadShellExists: false, elapsedMs: 0 } as const;

  it("waits while the thread is still on its way", () => {
    expect(resolveChatSyncOutcome({ ...base, renderState: "loading" }).kind).toBe("waiting");
  });

  it("is ready once the detail lands, or once a shell exists", () => {
    expect(resolveChatSyncOutcome({ ...base, renderState: "ready" }).kind).toBe("ready");
    expect(
      resolveChatSyncOutcome({ ...base, renderState: "loading", threadShellExists: true }).kind,
    ).toBe("ready");
  });

  it("offers a way out when the thread is missing after bootstrap", () => {
    const outcome = resolveChatSyncOutcome({ ...base, renderState: "missing" });
    expect(outcome.kind).toBe("retry");
    if (outcome.kind !== "retry") return;
    expect(outcome.message).toContain("no longer on the server");
  });

  it("offers a way out when the shell query itself failed", () => {
    const outcome = resolveChatSyncOutcome({
      ...base,
      renderState: "loading",
      shellError: "connection lost",
    });
    expect(outcome.kind).toBe("retry");
  });

  it("stops waiting forever: a bounded fallback ends in retry", () => {
    expect(
      resolveChatSyncOutcome({
        ...base,
        renderState: "loading",
        elapsedMs: CHAT_SYNC_TIMEOUT_MS - 1,
      }).kind,
    ).toBe("waiting");
    const timedOut = resolveChatSyncOutcome({
      ...base,
      renderState: "loading",
      elapsedMs: CHAT_SYNC_TIMEOUT_MS,
    });
    expect(timedOut.kind).toBe("retry");
    if (timedOut.kind !== "retry") return;
    // The way out is the Retry affordance beside the notice, so the sentence
    // states the state instead of instructing the captain to press it.
    expect(timedOut.message).toBe("This conversation didn't finish loading.");
  });
});
