/**
 * The `sidebar_state` cookie was write-only for as long as `SidebarProvider`
 * outlived every navigation. #216 gave the captain surface its own frame, so
 * the provider now unmounts and remounts on a fleet round trip and `defaultOpen`
 * is consulted again — which is the difference between a collapsed sidebar
 * staying collapsed and springing open after every visit to `/fleet`.
 */
import { describe, expect, it } from "vite-plus/test";

import { resolveSidebarDefaultOpen, SIDEBAR_STATE_COOKIE_NAME } from "./sidebarState";

describe("resolveSidebarDefaultOpen", () => {
  it("honours both persisted values", () => {
    expect(resolveSidebarDefaultOpen(`${SIDEBAR_STATE_COOKIE_NAME}=false`)).toBe(false);
    expect(resolveSidebarDefaultOpen(`${SIDEBAR_STATE_COOKIE_NAME}=true`)).toBe(true);
  });

  it("finds the cookie among others, in any position", () => {
    expect(resolveSidebarDefaultOpen(`theme=dark; ${SIDEBAR_STATE_COOKIE_NAME}=false; tz=PT`)).toBe(
      false,
    );
    expect(resolveSidebarDefaultOpen(`${SIDEBAR_STATE_COOKIE_NAME}=false; theme=dark`)).toBe(false);
    expect(resolveSidebarDefaultOpen(`theme=dark; ${SIDEBAR_STATE_COOKIE_NAME}=true`)).toBe(true);
  });

  it("is not fooled by a cookie whose name merely ends the same way", () => {
    expect(resolveSidebarDefaultOpen(`legacy_${SIDEBAR_STATE_COOKIE_NAME}=false`)).toBe(true);
  });

  it("opens when nothing was recorded", () => {
    // The failure modes are not symmetric: an unwanted open sidebar is one
    // click to correct, a wrongly-collapsed one is an app with no navigation.
    expect(resolveSidebarDefaultOpen("")).toBe(true);
    expect(resolveSidebarDefaultOpen(null)).toBe(true);
    expect(resolveSidebarDefaultOpen(undefined)).toBe(true);
    expect(resolveSidebarDefaultOpen("theme=dark")).toBe(true);
    expect(resolveSidebarDefaultOpen(SIDEBAR_STATE_COOKIE_NAME)).toBe(true);
    expect(resolveSidebarDefaultOpen(`${SIDEBAR_STATE_COOKIE_NAME}=maybe`)).toBe(true);
  });
});
