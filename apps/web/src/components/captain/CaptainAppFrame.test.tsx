/**
 * The frame that stands in for `SidebarProvider` on the captain routes (#216).
 *
 * Called rather than rendered (the `AppRoot.test.tsx` idiom): what matters here
 * is the exact set of props the frame publishes, because the point of the
 * ticket is that the app sidebar's machinery does **not** come along —
 * `--sidebar-width`, `--workspace-titlebar-content-left` and
 * `data-sidebar-state` are the leak, and "absent" is not something markup
 * assertions state as clearly as this does.
 */
import type { ReactElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import { RAIL_TITLEBAR_INSET_ATTRIBUTE } from "../../workspaceTitlebar";
import { CaptainAppFrame } from "./CaptainAppFrame";

const frameProps = (macosTrafficLights: boolean): Record<string, unknown> =>
  (
    CaptainAppFrame({
      children: "conversation",
      macosTrafficLights,
    }) as ReactElement<Record<string, unknown>>
  ).props;

describe("CaptainAppFrame", () => {
  it("brings none of the app sidebar's machinery with it", () => {
    const props = frameProps(false);
    const serialised = JSON.stringify(props);

    expect(serialised).not.toContain("--sidebar-width");
    expect(serialised).not.toContain("--workspace-titlebar-content-left");
    expect(serialised).not.toContain("data-sidebar-state");
    expect(props["data-captain-app-frame"]).toBe("");
  });

  it("gives the rail full viewport height to lay its regions out in", () => {
    expect(frameProps(false).className).toBe("flex h-dvh min-h-0 w-full");
  });

  it("passes the route's content straight through", () => {
    expect(frameProps(true).children).toBe("conversation");
  });

  describe("macOS traffic lights", () => {
    /*
     * The rail is the leftmost surface on these routes now, so the clearance
     * the app sidebar used to provide has to come from here or the lights land
     * on the rail header's controls.
     */
    it("publishes the inset contract and the lights' width when they are showing", () => {
      const props = frameProps(true);
      expect(props[RAIL_TITLEBAR_INSET_ATTRIBUTE]).toBe("");
      expect(props.style).toEqual({ "--workspace-controls-left": "90px" });
    });

    it("publishes neither in the browser, or in fullscreen, where there are none", () => {
      const props = frameProps(false);
      expect(RAIL_TITLEBAR_INSET_ATTRIBUTE in props).toBe(false);
      expect(props.style).toBeUndefined();
    });
  });
});
