import { describe, expect, it } from "vite-plus/test";

import {
  CAPTAIN_ICON_LEFT_RAIL_MEDIA_QUERY,
  CAPTAIN_RIGHT_OVERLAY_MEDIA_QUERY,
  CAPTAIN_SINGLE_COLUMN_MEDIA_QUERY,
  CAPTAIN_THREE_RAIL_MEDIA_QUERY,
  type CaptainLayoutMode,
  canToggleCaptainLeftRail,
  captainGridTemplateColumns,
  captainLeftRailToggleLabel,
  resolveCaptainLayoutMode,
  resolveCaptainShellRegions,
} from "./captainShell.logic";

function regions(
  overrides: {
    mode?: CaptainLayoutMode;
    leftRailCollapsed?: boolean;
    rightRailCollapsed?: boolean;
    hasConversation?: boolean;
  } = {},
) {
  return resolveCaptainShellRegions({
    mode: overrides.mode ?? "three-rails",
    leftRailCollapsed: overrides.leftRailCollapsed ?? false,
    rightRailCollapsed: overrides.rightRailCollapsed ?? false,
    hasConversation: overrides.hasConversation ?? true,
  });
}

describe("resolveCaptainLayoutMode", () => {
  it("puts all three rails inline at and above the reference width", () => {
    expect(resolveCaptainLayoutMode(1440)).toBe("three-rails");
    expect(resolveCaptainLayoutMode(2560)).toBe("three-rails");
  });

  it("overlays the right rail across the common laptop band", () => {
    expect(resolveCaptainLayoutMode(1439)).toBe("right-overlay");
    expect(resolveCaptainLayoutMode(1180)).toBe("right-overlay");
  });

  it("forces the icon left rail below 1180", () => {
    expect(resolveCaptainLayoutMode(1179)).toBe("icon-left-rail");
    expect(resolveCaptainLayoutMode(900)).toBe("icon-left-rail");
  });

  it("drops to a single column below 900", () => {
    expect(resolveCaptainLayoutMode(899)).toBe("single-column");
    expect(resolveCaptainLayoutMode(320)).toBe("single-column");
  });

  it("falls back to the reference layout when the width cannot be measured", () => {
    // Guessing "phone" on an unmeasured desktop is the expensive mistake.
    expect(resolveCaptainLayoutMode(Number.NaN)).toBe("three-rails");
  });
});

describe("captain media queries", () => {
  it("tile the width axis without a gap or an overlap", () => {
    expect(CAPTAIN_THREE_RAIL_MEDIA_QUERY).toBe("(min-width: 1440px)");
    expect(CAPTAIN_RIGHT_OVERLAY_MEDIA_QUERY).toBe("(min-width: 1180px) and (max-width: 1439px)");
    expect(CAPTAIN_ICON_LEFT_RAIL_MEDIA_QUERY).toBe("(min-width: 900px) and (max-width: 1179px)");
    expect(CAPTAIN_SINGLE_COLUMN_MEDIA_QUERY).toBe("(max-width: 899px)");
  });

  it("is not the workspace right-panel query", () => {
    // §2 resolved flaw #2: sharing `(max-width: 980px)` with workspace mode is
    // what hid the third rail at laptop widths.
    for (const query of [
      CAPTAIN_THREE_RAIL_MEDIA_QUERY,
      CAPTAIN_RIGHT_OVERLAY_MEDIA_QUERY,
      CAPTAIN_ICON_LEFT_RAIL_MEDIA_QUERY,
      CAPTAIN_SINGLE_COLUMN_MEDIA_QUERY,
    ]) {
      expect(query).not.toBe("(max-width: 980px)");
    }
  });
});

describe("resolveCaptainShellRegions", () => {
  it("shows three inline rails at the reference width", () => {
    const view = regions();
    expect(view.leftRail).toBe("expanded");
    expect(view.showCenter).toBe(true);
    expect(view.rightRail).toBe("inline");
    expect(view.rightRailInline).toBe(true);
    expect(view.showGroupHeaders).toBe(true);
    expect(view.showBackChevron).toBe(false);
  });

  it("honours a collapsed left rail preference where the rail can expand", () => {
    expect(regions({ leftRailCollapsed: true }).leftRail).toBe("icon");
    expect(regions({ mode: "right-overlay", leftRailCollapsed: true }).leftRail).toBe("icon");
  });

  it("collapses the right rail to an overlay across the laptop band", () => {
    const view = regions({ mode: "right-overlay" });
    expect(view.leftRail).toBe("expanded");
    expect(view.rightRail).toBe("overlay");
    expect(view.rightRailInline).toBe(false);
  });

  it("forces the icon rail at 900-1179 whatever the preference says", () => {
    const view = regions({ mode: "icon-left-rail", leftRailCollapsed: false });
    expect(view.leftRail).toBe("icon");
    // Group headers become dividers once there is no room for a header.
    expect(view.showGroupHeaders).toBe(false);
    expect(view.rightRail).toBe("overlay");
  });

  it("keeps a collapsed right-rail preference collapsed at the reference width", () => {
    const view = regions({ rightRailCollapsed: true });
    expect(view.rightRail).toBe("overlay");
    expect(view.rightRailInline).toBe(false);
  });

  it("is route-driven below 900: the list at the index", () => {
    const view = regions({ mode: "single-column", hasConversation: false });
    expect(view.leftRail).toBe("expanded");
    expect(view.showCenter).toBe(false);
    expect(view.showBackChevron).toBe(false);
    expect(view.rightRail).toBe("sheet");
  });

  it("is route-driven below 900: the conversation, with a way back", () => {
    const view = regions({ mode: "single-column", hasConversation: true });
    expect(view.leftRail).toBe("hidden");
    expect(view.showCenter).toBe(true);
    expect(view.showBackChevron).toBe(true);
    expect(view.rightRailInline).toBe(false);
  });

  it("never hides both the list and the conversation", () => {
    for (const mode of [
      "three-rails",
      "right-overlay",
      "icon-left-rail",
      "single-column",
    ] as const) {
      for (const hasConversation of [true, false]) {
        for (const leftRailCollapsed of [true, false]) {
          const view = regions({ mode, hasConversation, leftRailCollapsed });
          expect(view.leftRail !== "hidden" || view.showCenter).toBe(true);
        }
      }
    }
  });
});

describe("captainGridTemplateColumns", () => {
  it("lays out 380 / center / 470 at the reference width", () => {
    expect(captainGridTemplateColumns(regions())).toBe("380px minmax(520px, 1fr) 470px");
  });

  it("swaps the left rail for the 64px strip when collapsed", () => {
    expect(captainGridTemplateColumns(regions({ leftRailCollapsed: true }))).toBe(
      "64px minmax(520px, 1fr) 470px",
    );
  });

  it("drops the center minimum below the reference width so nothing scrolls sideways", () => {
    expect(captainGridTemplateColumns(regions({ mode: "right-overlay" }))).toBe(
      "380px minmax(0, 1fr)",
    );
    expect(captainGridTemplateColumns(regions({ mode: "icon-left-rail" }))).toBe(
      "64px minmax(0, 1fr)",
    );
  });

  it("gives the single visible column the whole width below 900", () => {
    expect(
      captainGridTemplateColumns(regions({ mode: "single-column", hasConversation: false })),
    ).toBe("380px");
    expect(
      captainGridTemplateColumns(regions({ mode: "single-column", hasConversation: true })),
    ).toBe("minmax(0, 1fr)");
  });
});

describe("left rail toggle", () => {
  it("names the action, not the state", () => {
    expect(captainLeftRailToggleLabel(regions())).toBe("Collapse contacts");
    expect(captainLeftRailToggleLabel(regions({ leftRailCollapsed: true }))).toBe(
      "Expand contacts",
    );
  });

  it("is not offered where the width already decides", () => {
    expect(canToggleCaptainLeftRail("three-rails")).toBe(true);
    expect(canToggleCaptainLeftRail("right-overlay")).toBe(true);
    expect(canToggleCaptainLeftRail("icon-left-rail")).toBe(false);
    expect(canToggleCaptainLeftRail("single-column")).toBe(false);
  });
});
