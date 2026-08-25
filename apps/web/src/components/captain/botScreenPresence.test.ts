import { describe, expect, it } from "vite-plus/test";

import { botScreenDetachedNote, shouldAttachBotScreenViewer } from "./botScreenPresence";

const input = (overrides: Partial<Parameters<typeof shouldAttachBotScreenViewer>[0]> = {}) => ({
  hasViewerPath: true,
  intersecting: true,
  documentHidden: false,
  fullscreenOpen: false,
  ...overrides,
});

describe("shouldAttachBotScreenViewer", () => {
  it("attaches for a live desktop the captain is actually looking at", () => {
    expect(shouldAttachBotScreenViewer(input())).toBe(true);
  });

  it("never attaches without a server-issued viewer path", () => {
    // The rail must not synthesise a connection: a desktop that is not running
    // has no port behind it, and viewing must never provision one.
    expect(shouldAttachBotScreenViewer(input({ hasViewerPath: false }))).toBe(false);
  });

  it("detaches when the thumbnail scrolls out of the rail", () => {
    // D5. Presence *is* the socket — attached viewers hold a desktop against
    // the idle stop — so a thumbnail that stayed attached for as long as a
    // conversation was open would pin a Screenbox slot all night for nobody,
    // and at the fleet's cap that is someone else's Start failing.
    expect(shouldAttachBotScreenViewer(input({ intersecting: false }))).toBe(false);
  });

  it("detaches when the tab is backgrounded even though the geometry says visible", () => {
    // A hidden tab's elements keep intersecting, so this is not covered by the
    // observer and has to be asked separately.
    expect(shouldAttachBotScreenViewer(input({ documentHidden: true }))).toBe(false);
    expect(shouldAttachBotScreenViewer(input({ documentHidden: true, intersecting: true }))).toBe(
      false,
    );
  });

  it("suspends the thumbnail while the fullscreen dialog holds its own viewer", () => {
    // One human, one counted viewer. The dialog mounts a second viewer for the
    // same desktop, and leaving the thumbnail attached would double it.
    expect(shouldAttachBotScreenViewer(input({ fullscreenOpen: true }))).toBe(false);
  });
});

describe("botScreenDetachedNote", () => {
  it("says nothing when there is no desktop — the phase copy already does", () => {
    expect(botScreenDetachedNote({ hasViewerPath: false, fullscreenOpen: false })).toBe(null);
  });

  it("does not claim a running desktop is absent merely because nobody is watching", () => {
    // The poster stands in whenever the viewer is detached, so it must not
    // reuse "No desktop running" for a container that is running perfectly
    // well and is simply unwatched.
    const note = botScreenDetachedNote({ hasViewerPath: true, fullscreenOpen: false });
    expect(note).not.toBe(null);
    expect(note?.toLowerCase()).not.toContain("no desktop");
    expect(note).toContain("scroll back");
  });

  it("names where the desktop is while fullscreen is open", () => {
    expect(botScreenDetachedNote({ hasViewerPath: true, fullscreenOpen: true })).toBe(
      "Open fullscreen",
    );
  });

  it("states the desktop's state, not this component's (#217)", () => {
    // "Showing fullscreen." / "Paused while off-screen." both described the
    // app's own rendering and socket handling to a captain who asked about a
    // desktop.
    for (const fullscreenOpen of [true, false]) {
      const note = botScreenDetachedNote({ hasViewerPath: true, fullscreenOpen }) ?? "";
      expect(note).not.toContain("Showing");
      expect(note).not.toContain("Paused");
    }
  });
});
