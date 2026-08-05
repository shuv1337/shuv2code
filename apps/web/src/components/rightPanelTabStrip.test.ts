import { describe, expect, it } from "vite-plus/test";

import { resolveHorizontalWheelScroll, resolveTabNavigationIndex } from "./rightPanelTabStrip";

describe("right panel tab strip", () => {
  it("maps a dominant vertical wheel gesture onto horizontal overflow", () => {
    expect(
      resolveHorizontalWheelScroll({
        scrollLeft: 100,
        scrollWidth: 1_000,
        clientWidth: 400,
        deltaX: 0,
        deltaY: 50,
        deltaMode: 0,
      }),
    ).toBe(150);
  });

  it("leaves horizontal gestures native and releases wheel input at an edge", () => {
    expect(
      resolveHorizontalWheelScroll({
        scrollLeft: 100,
        scrollWidth: 1_000,
        clientWidth: 400,
        deltaX: 60,
        deltaY: 20,
        deltaMode: 0,
      }),
    ).toBeNull();
    expect(
      resolveHorizontalWheelScroll({
        scrollLeft: 0,
        scrollWidth: 1_000,
        clientWidth: 400,
        deltaX: 0,
        deltaY: -50,
        deltaMode: 0,
      }),
    ).toBeNull();
  });

  it("scales line and page wheel deltas", () => {
    expect(
      resolveHorizontalWheelScroll({
        scrollLeft: 0,
        scrollWidth: 2_000,
        clientWidth: 400,
        deltaX: 0,
        deltaY: 2,
        deltaMode: 1,
      }),
    ).toBe(48);
    expect(
      resolveHorizontalWheelScroll({
        scrollLeft: 0,
        scrollWidth: 2_000,
        clientWidth: 400,
        deltaX: 0,
        deltaY: 1,
        deltaMode: 2,
      }),
    ).toBe(400);
  });

  it("navigates with wrapping arrows and absolute Home/End targets", () => {
    expect(resolveTabNavigationIndex("ArrowLeft", 0, 3)).toBe(2);
    expect(resolveTabNavigationIndex("ArrowRight", 2, 3)).toBe(0);
    expect(resolveTabNavigationIndex("Home", 2, 3)).toBe(0);
    expect(resolveTabNavigationIndex("End", 0, 3)).toBe(2);
  });
});
