import type { AdeBotScreen } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { botScreenPanelTitle, getBotScreenPanelView } from "./botScreenPanel.logic";

const screen = (overrides: Partial<AdeBotScreen> = {}): AdeBotScreen =>
  ({
    botId: "bot-1",
    status: "none",
    computerUse: true,
    viewers: 0,
    lastNeededAt: null,
    viewerPath: null,
    screenboxConfigured: true,
    ...overrides,
  }) as AdeBotScreen;

const view = (overrides: Partial<AdeBotScreen> = {}, botName = "Ada") =>
  getBotScreenPanelView({ screen: screen(overrides), botName });

describe("botScreenPanelTitle", () => {
  it("names the bot", () => {
    expect(botScreenPanelTitle("Ada")).toBe("Ada's screen");
  });

  it("degrades a blank name rather than rendering a dangling possessive", () => {
    // A roster entry mid-rename can hand the rail an empty string; "'s screen"
    // is not a heading.
    expect(botScreenPanelTitle("   ")).toBe("Bot screen");
  });
});

describe("getBotScreenPanelView", () => {
  it("shows the idle poster and an explicit Start when nothing is provisioned", () => {
    const result = view();
    expect(result.phase).toBe("not-started");
    expect(result.showPoster).toBe(true);
    expect(result.viewerPath).toBe(null);
    expect(result.startLabel).toBe("Start desktop");
    expect(result.stopLabel).toBe(null);
  });

  it("never hands the rail a viewer path unless the server says the desktop is live", () => {
    // The rule the whole feature exists to protect: mounting the rail must not
    // be able to bring a container up, so the only input that produces a canvas
    // is a server-issued path on a running desktop.
    for (const status of ["none", "provisioning", "stopped", "failed"] as const) {
      const result = view({ status, viewerPath: "/ade/screen/bot-1" });
      expect(result.viewerPath).toBe(null);
      expect(result.canExpand).toBe(false);
      expect(result.showPoster).toBe(true);
    }
  });

  it("scales a live canvas and offers fullscreen and Stop", () => {
    const result = view({ status: "running", viewerPath: "/ade/screen/bot-1" });
    expect(result.phase).toBe("live");
    expect(result.showPoster).toBe(false);
    expect(result.viewerPath).toBe("/ade/screen/bot-1");
    expect(result.canExpand).toBe(true);
    expect(result.expandLabel).toBe("Open Ada's screen fullscreen");
    expect(result.fullscreenTitle).toBe("Ada's screen");
    expect(result.startLabel).toBe(null);
    expect(result.stopLabel).toBe("Stop desktop");
  });

  it("refuses to expand a running desktop the server declined to route", () => {
    // Upstream lost the desktop between two reads: there is no canvas, so
    // there is nothing to enlarge and no socket to open.
    const result = view({ status: "running", viewerPath: null });
    expect(result.phase).toBe("live");
    expect(result.canExpand).toBe(false);
    expect(result.showPoster).toBe(true);
  });

  it("names the verb the phase actually calls for", () => {
    expect(view({ status: "stopped" }).startLabel).toBe("Resume desktop");
    expect(view({ status: "failed" }).startLabel).toBe("Try again");
  });

  it("keeps Stop reachable while a container is still coming up", () => {
    const result = view({ status: "provisioning" });
    expect(result.phase).toBe("starting");
    expect(result.stopLabel).toBe("Stop desktop");
    expect(result.startLabel).toBe(null);
  });

  it("offers no action at all where the host cannot provide desktops", () => {
    const result = view({ screenboxConfigured: false });
    expect(result.phase).toBe("unavailable");
    expect(result.startLabel).toBe(null);
    expect(result.stopLabel).toBe(null);
    expect(result.canExpand).toBe(false);
  });

  it("keeps Stop reachable for a running desktop whose computer use was turned off", () => {
    // Otherwise turning the toggle off orphans a live container with no way to
    // shut it down. This mirrors `getBotScreenView`'s rule; asserted here so
    // the rail cannot lose it by re-deriving its own buttons.
    const result = view({ status: "running", computerUse: false, viewerPath: "/ade/screen/bot-1" });
    expect(result.stopLabel).toBe("Stop desktop");
  });

  it("reports viewer presence, which is what holds a desktop against the idle stop", () => {
    expect(view().viewersLabel).toBe(null);
    expect(view({ viewers: 1 }).viewersLabel).toBe("1 viewer");
    expect(view({ viewers: 3 }).viewersLabel).toBe("3 viewers");
  });
});
