import type { AdeBotDetail, ThreadId } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { getBotChatBody, getBotChatHeaderView, getBotChatWelcomeCopy } from "./BotChatPage.logic";

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
  it("waits rather than guessing while the detail is loading", () => {
    expect(getBotChatBody({ detail: null, startedThreadId: null, hasProjects: true })).toEqual({
      kind: "loading",
    });
  });

  it("never starts a session on mount: no binding means the canned welcome", () => {
    const body = getBotChatBody({ detail: detail(), startedThreadId: null, hasProjects: true });
    expect(body.kind).toBe("welcome");
    if (body.kind !== "welcome") return;
    expect(body.copy.startLabel).toBe("Start chatting");
    expect(body.copy.projectCta).toBeNull();
    // The hint has to name the two things a fresh install is actually
    // missing, not just say "kernels".
    expect(body.copy.kernelHint).toContain("shuvcode service start");
    expect(body.copy.kernelHint).toContain("Settings → Providers");
  });

  it("adds the first-project CTA when the workspace has no project", () => {
    const body = getBotChatBody({ detail: detail(), startedThreadId: null, hasProjects: false });
    expect(body.kind === "welcome" && body.copy.projectCta).toContain("first project");
  });

  it("offers to resume rather than to start when a primary session is warm", () => {
    const body = getBotChatBody({
      detail: detail({ bindings: [activeBinding] as never }),
      startedThreadId: null,
      hasProjects: true,
    });
    expect(body.kind === "welcome" && body.copy.startLabel).toBe("Resume chatting");
  });

  it("ignores a binding that is not the primary text session", () => {
    const body = getBotChatBody({
      detail: detail({ bindings: [{ ...activeBinding, purpose: "voice" }] as never }),
      startedThreadId: null,
      hasProjects: true,
    });
    expect(body.kind === "welcome" && body.copy.startLabel).toBe("Start chatting");
  });

  it("ignores a primary binding that is no longer active", () => {
    const body = getBotChatBody({
      detail: detail({ bindings: [{ ...activeBinding, status: "lost" }] as never }),
      startedThreadId: null,
      hasProjects: true,
    });
    expect(body.kind === "welcome" && body.copy.startLabel).toBe("Start chatting");
  });

  it("renders the conversation once a thread has been handed back", () => {
    expect(
      getBotChatBody({
        detail: detail(),
        startedThreadId: "thr_1" as ThreadId,
        hasProjects: true,
      }),
    ).toEqual({ kind: "chat", threadId: "thr_1" });
  });
});

describe("getBotChatWelcomeCopy", () => {
  it("greets by name and says nothing is running", () => {
    const copy = getBotChatWelcomeCopy({ botName: "Scout", hasProjects: true });
    expect(copy.greeting).toContain("Scout");
    expect(copy.greeting).toContain("no session starts until you say so");
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
      hasProjects: true,
      loadError: {
        _tag: "AdeCaptainError",
        reason: "bot_not_found",
        message: "ADE bot 'bot_1' does not exist.",
      },
    });
    expect(body.kind).toBe("error");
    if (body.kind !== "error") return;
    expect(body.message).toContain("does not exist");
  });

  it("still shows the loading state while nothing has failed", () => {
    expect(getBotChatBody({ detail: null, startedThreadId: null, hasProjects: true }).kind).toBe(
      "loading",
    );
    expect(
      getBotChatBody({ detail: null, startedThreadId: null, hasProjects: true, loadError: null })
        .kind,
    ).toBe("loading");
  });
});
