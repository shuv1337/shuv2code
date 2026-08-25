import { describe, expect, it } from "vite-plus/test";

import {
  CAPTAIN_CENTER_MIN_WIDTH_PX,
  CAPTAIN_ICON_LEFT_RAIL_MEDIA_QUERY,
  CAPTAIN_RIGHT_OVERLAY_MEDIA_QUERY,
  CAPTAIN_RIGHT_RAIL_MAX_WIDTH_PX,
  CAPTAIN_RIGHT_RAIL_MIN_WIDTH_PX,
  CAPTAIN_THREE_RAIL_MEDIA_QUERY,
  type CaptainLayoutMode,
  canToggleCaptainLeftRail,
  captainGridTemplateColumns,
  captainLeftRailToggleLabel,
  captainLeftRailWidth,
  captainRightRailMaxWidth,
  resolveCaptainLayoutMode,
  resolveCaptainLayoutModeFromMediaMatches,
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

/** Evaluate a `(min-width: Npx)` query the way a browser would. */
function matchesMinWidth(query: string, viewportWidth: number): boolean {
  const match = /^\(min-width: ([\d.]+)px\)$/u.exec(query);
  if (match === null) {
    throw new Error(`not a bare min-width query: ${query}`);
  }
  return viewportWidth >= Number(match[1]);
}

describe("captain media queries", () => {
  it("is not the workspace right-panel query", () => {
    // §2 resolved flaw #2: sharing `(max-width: 980px)` with workspace mode is
    // what hid the third rail at laptop widths.
    for (const query of [
      CAPTAIN_THREE_RAIL_MEDIA_QUERY,
      CAPTAIN_RIGHT_OVERLAY_MEDIA_QUERY,
      CAPTAIN_ICON_LEFT_RAIL_MEDIA_QUERY,
    ]) {
      expect(query).not.toBe("(max-width: 980px)");
    }
  });

  it("carries no upper bound, so no width can fall between two bands", () => {
    // Pairing each lower bound with `max-width: n - 1px` leaves 899.0…900.0
    // uncovered. A boundary is one number, named once, as a lower bound only.
    for (const query of [
      CAPTAIN_THREE_RAIL_MEDIA_QUERY,
      CAPTAIN_RIGHT_OVERLAY_MEDIA_QUERY,
      CAPTAIN_ICON_LEFT_RAIL_MEDIA_QUERY,
    ]) {
      expect(query).not.toContain("max-width");
      expect(() => matchesMinWidth(query, 1000)).not.toThrow();
    }
  });

  it("resolves the same band as the numeric function at every width, fractions included", () => {
    // The fractional widths are the regression: a fractional-DPR display or a
    // zoomed window reports 899.5px, and the previous query set matched none of
    // them, so the shell fell through to the three-rail layout inside 900px.
    const widths = [
      320, 599.5, 899, 899.01, 899.5, 899.99, 900, 900.5, 1179, 1179.5, 1179.99, 1180, 1180.5, 1439,
      1439.5, 1439.99, 1440, 1440.5, 2560, 3839.5,
    ];
    for (const width of widths) {
      const fromQueries = resolveCaptainLayoutModeFromMediaMatches({
        hasMediaSupport: true,
        threeRails: matchesMinWidth(CAPTAIN_THREE_RAIL_MEDIA_QUERY, width),
        rightOverlay: matchesMinWidth(CAPTAIN_RIGHT_OVERLAY_MEDIA_QUERY, width),
        iconLeftRail: matchesMinWidth(CAPTAIN_ICON_LEFT_RAIL_MEDIA_QUERY, width),
      });
      expect({ width, mode: fromQueries }).toEqual({
        width,
        mode: resolveCaptainLayoutMode(width),
      });
    }
  });
});

describe("resolveCaptainLayoutModeFromMediaMatches", () => {
  it("falls back to the reference layout when nothing can be measured", () => {
    expect(
      resolveCaptainLayoutModeFromMediaMatches({
        hasMediaSupport: false,
        threeRails: false,
        rightOverlay: false,
        iconLeftRail: false,
      }),
    ).toBe("three-rails");
  });

  it("reads no match as genuinely narrow once media queries do work", () => {
    expect(
      resolveCaptainLayoutModeFromMediaMatches({
        hasMediaSupport: true,
        threeRails: false,
        rightOverlay: false,
        iconLeftRail: false,
      }),
    ).toBe("single-column");
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
    // Full-bleed both ways. A fixed 380px rail on a 375px phone is a
    // horizontal scrollbar, not a layout.
    for (const hasConversation of [true, false]) {
      for (const leftRailCollapsed of [true, false]) {
        expect(
          captainGridTemplateColumns(
            regions({ mode: "single-column", hasConversation, leftRailCollapsed }),
          ),
        ).toBe("minmax(0, 1fr)");
      }
    }
  });
});

describe("right rail resize (M6)", () => {
  it("draws the rail at the width it was dragged to", () => {
    expect(captainGridTemplateColumns(regions(), 600)).toBe("380px minmax(520px, 1fr) 600px");
  });

  it("keeps the 470px default when nobody has dragged it", () => {
    expect(captainGridTemplateColumns(regions())).toBe("380px minmax(520px, 1fr) 470px");
  });

  it("leaves the conversation its minimum however wide the rail was persisted", () => {
    // The failure this prevents: a rail dragged to 720px on a 2560px monitor,
    // then reopened on a 1440px one, squeezing the centre column under the
    // 520px it is designed around.
    const max = captainRightRailMaxWidth({ viewportWidth: 1440, leftRailWidth: 380 });
    expect(max).toBe(1440 - 380 - CAPTAIN_CENTER_MIN_WIDTH_PX);
    expect(380 + CAPTAIN_CENTER_MIN_WIDTH_PX + max).toBeLessThanOrEqual(1440);
  });

  it("never clamps below the width at which the rail stops showing anything", () => {
    // A 40px rail is not a narrow rail, it is a wasted column. Below the
    // minimum the answer is to collapse, which the toggle already does.
    expect(captainRightRailMaxWidth({ viewportWidth: 900, leftRailWidth: 380 })).toBe(
      CAPTAIN_RIGHT_RAIL_MIN_WIDTH_PX,
    );
  });

  it("treats an unmeasurable viewport as unconstrained, matching the band resolver", () => {
    expect(
      captainRightRailMaxWidth({ viewportWidth: Number.POSITIVE_INFINITY, leftRailWidth: 380 }),
    ).toBe(CAPTAIN_RIGHT_RAIL_MAX_WIDTH_PX);
  });

  it("gives back the width the left rail actually occupies, so the clamp is not a guess", () => {
    expect(captainLeftRailWidth(regions())).toBe(380);
    expect(captainLeftRailWidth(regions({ leftRailCollapsed: true }))).toBe(64);
    expect(captainLeftRailWidth(regions({ mode: "single-column", hasConversation: true }))).toBe(0);
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
