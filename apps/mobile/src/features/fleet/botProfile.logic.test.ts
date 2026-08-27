import type { AdeBotDetail, AdeBotScreen } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  BOT_SCREEN_MOBILE_DETAIL,
  getBotModelRowView,
  getBotScreenMobileView,
  getPersonaHistoryView,
} from "./botProfile.logic";

const modelOptions = [
  { slug: "anthropic/opus", label: "Opus", agentCapable: true, isKernelDefault: false },
  { slug: "free/xml", label: "Free XML", agentCapable: false, isKernelDefault: false },
];

const detail = (input: {
  readonly modelSlug?: string | null;
  readonly versions?: ReadonlyArray<{ readonly id: string; readonly activatedAt: string | null }>;
  readonly activeVersionId?: string | null;
}): AdeBotDetail =>
  ({
    bot: { activePersonaVersionId: input.activeVersionId ?? null },
    personaVersions: (input.versions ?? []).map((version) => ({
      id: version.id,
      content: `persona ${version.id}`,
      createdAt: "2026-08-24T00:00:00.000Z",
      activatedAt: version.activatedAt,
    })),
    bindings: [],
    ...(input.modelSlug === undefined ? {} : { modelSlug: input.modelSlug }),
  }) as unknown as AdeBotDetail;

const screen = (overrides: Partial<AdeBotScreen>): AdeBotScreen =>
  ({
    screenboxConfigured: true,
    computerUse: true,
    status: "none",
    viewerPath: null,
    viewers: 0,
    ...overrides,
  }) as unknown as AdeBotScreen;

describe("getBotModelRowView", () => {
  it("reads an unpinned bot as the kernel default rather than as blank", () => {
    expect(getBotModelRowView(detail({}), modelOptions)).toEqual({
      label: "Kernel default",
      warning: null,
    });
  });

  it("warns beside a model the kernel reported as unable to run an agent", () => {
    const view = getBotModelRowView(detail({ modelSlug: "free/xml" }), modelOptions);
    expect(view.label).toBe("Free XML");
    expect(view.warning).toBe("May not support tools");
  });

  it("does not warn about a model the picker has never heard of", () => {
    const view = getBotModelRowView(detail({ modelSlug: "custom/local" }), modelOptions);
    expect(view.label).toBe("custom/local");
    expect(view.warning).toBeNull();
  });

  it("survives a profile whose detail has not loaded", () => {
    expect(getBotModelRowView(null, modelOptions).label).toBe("Kernel default");
  });
});

describe("getPersonaHistoryView", () => {
  it("shows the head and its two predecessors, and counts the rest", () => {
    const view = getPersonaHistoryView(
      detail({
        versions: [
          { id: "v5", activatedAt: null },
          { id: "v4", activatedAt: "2026-08-24T00:00:00.000Z" },
          { id: "v3", activatedAt: "2026-08-23T00:00:00.000Z" },
          { id: "v2", activatedAt: "2026-08-22T00:00:00.000Z" },
          { id: "v1", activatedAt: "2026-08-21T00:00:00.000Z" },
        ],
        activeVersionId: "v4",
      }),
    );
    expect(view.versions.map((version) => version.id)).toEqual(["v5", "v4", "v3"]);
    expect(view.hiddenLabel).toBe("2 older versions");
  });

  it("labels a single withheld version in the singular", () => {
    const view = getPersonaHistoryView(
      detail({
        versions: [
          { id: "v4", activatedAt: null },
          { id: "v3", activatedAt: null },
          { id: "v2", activatedAt: null },
          { id: "v1", activatedAt: null },
        ],
      }),
    );
    expect(view.hiddenLabel).toBe("1 older version");
  });

  it("keeps the pending/active distinction the server drew", () => {
    const view = getPersonaHistoryView(
      detail({
        versions: [
          { id: "v2", activatedAt: null },
          { id: "v1", activatedAt: "2026-08-23T00:00:00.000Z" },
        ],
        activeVersionId: "v1",
      }),
    );
    expect(view.versions.map((version) => version.stateLabel)).toEqual(["Pending", "Active"]);
    expect(view.hiddenLabel).toBeNull();
  });

  it("has nothing to show before the detail loads", () => {
    expect(getPersonaHistoryView(null)).toEqual({ versions: [], hiddenLabel: null });
  });
});

describe("getBotScreenMobileView", () => {
  it("explains where the picture is when the desktop is actually running", () => {
    const view = getBotScreenMobileView({
      screen: screen({ status: "running", viewerPath: "/api/ade/screen/bot-1", viewers: 2 }),
      botName: "Bosun",
    });
    expect(view?.liveElsewhere).toBe(true);
    expect(view?.headline).toBe("Desktop running");
    expect(view?.detail).toBe(BOT_SCREEN_MOBILE_DETAIL);
    expect(view?.viewersLabel).toBe("2 viewers");
    expect(view?.title).toBe("Bosun's screen");
  });

  it("keeps the shared phase copy for every state that is not a live desktop", () => {
    const view = getBotScreenMobileView({
      screen: screen({ status: "stopped" }),
      botName: "Bosun",
    });
    expect(view?.liveElsewhere).toBe(false);
    expect(view?.headline).toBe("Desktop stopped");
    expect(view?.detail).toBe("Files are kept — resuming picks up where it left off.");
  });

  it("does not offer the viewer explanation when there is no desktop at all", () => {
    const view = getBotScreenMobileView({ screen: screen({}), botName: "Bosun" });
    expect(view?.headline).toBe("No desktop running");
    expect(view?.detail).toBe("");
  });

  it("says nothing before the desktop status has been read", () => {
    expect(getBotScreenMobileView({ screen: null, botName: "Bosun" })).toBeNull();
  });
});
