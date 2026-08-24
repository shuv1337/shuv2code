import { describe, expect, it } from "vite-plus/test";

import { getFleetEntryView, isFleetPath, needsYouBadgeLabel } from "./SidebarFleetEntry.logic";

describe("isFleetPath", () => {
  it("matches the roster and everything under it", () => {
    expect(isFleetPath("/fleet")).toBe(true);
    expect(isFleetPath("/fleet/bot_1")).toBe(true);
    expect(isFleetPath("/fleet/bot_1/chat")).toBe(true);
  });

  it("does not match a sibling route that merely starts with the same letters", () => {
    expect(isFleetPath("/fleetwood")).toBe(false);
    expect(isFleetPath("/")).toBe(false);
  });
});

describe("needsYouBadgeLabel", () => {
  it("renders nothing before the count arrives", () => {
    expect(needsYouBadgeLabel(null)).toBeNull();
  });

  it("renders nothing at zero so a quiet fleet stays quiet", () => {
    expect(needsYouBadgeLabel({ open: 0 })).toBeNull();
  });

  it("counts up to the cap and gestures past it", () => {
    expect(needsYouBadgeLabel({ open: 1 })).toBe("1");
    expect(needsYouBadgeLabel({ open: 99 })).toBe("99");
    expect(needsYouBadgeLabel({ open: 100 })).toBe("99+");
  });
});

describe("getFleetEntryView", () => {
  it("marks the row active on a fleet path and labels the badge", () => {
    expect(getFleetEntryView({ pathname: "/fleet/bot_1", needsYouCount: { open: 2 } })).toEqual({
      isActive: true,
      badgeLabel: "2",
      badgeAriaLabel: "2 items need you",
    });
  });

  it("uses the singular for one waiting item", () => {
    expect(getFleetEntryView({ pathname: "/", needsYouCount: { open: 1 } })).toEqual({
      isActive: false,
      badgeLabel: "1",
      badgeAriaLabel: "1 item needs you",
    });
  });

  it("drops the badge entirely when nothing is waiting", () => {
    expect(getFleetEntryView({ pathname: "/fleet", needsYouCount: null })).toEqual({
      isActive: true,
      badgeLabel: null,
      badgeAriaLabel: null,
    });
  });
});
