/**
 * The rail-top app switcher (#216).
 *
 * With the workspace sidebar no longer rendering on the captain routes, this
 * control is the only way back to the coding interface — so a wrong `to`, a
 * missing label, or a tooltip that opens into the rail it is attached to are
 * all "the captain is stuck in the messenger", not cosmetic slips.
 *
 * Called rather than rendered: the switcher's whole payload is a `Link`, and
 * rendering one needs a router the assertion does not.
 */
import type { ReactElement } from "react";
import { describe, expect, it } from "vite-plus/test";

import { WorkspaceSwitcher } from "./ContactRail";

type Props = Record<string, unknown>;

const propsOf = (element: unknown): Props => (element as ReactElement<Props>).props;

const switcherParts = (collapsed: boolean) => {
  const tooltip = WorkspaceSwitcher({ collapsed }) as ReactElement<{
    readonly children: ReadonlyArray<unknown>;
  }>;
  const [trigger, popup] = tooltip.props.children;
  const button = propsOf(trigger).render;
  const link = propsOf(button).render;
  return {
    button: propsOf(button),
    link: propsOf(link),
    popup: propsOf(popup),
  };
};

describe("WorkspaceSwitcher", () => {
  it("returns to the workspace threads view", () => {
    expect(switcherParts(false).link.to).toBe("/");
  });

  it("names itself for screen readers and for the tooltip", () => {
    const { button, popup } = switcherParts(false);
    expect(button["aria-label"]).toBe("Back to workspace threads");
    expect(popup.children).toBe("Back to workspace threads");
  });

  it("carries the app mark, so the two surfaces switch through one control", () => {
    const { button } = switcherParts(false);
    expect(propsOf(button.children).src).toBe("/brand/shuv2code-mark.svg");
  });

  it("opens the tooltip away from the rail at every rail width", () => {
    // Below the icon-strip breakpoint the rail is 64px wide; a tooltip opening
    // downward there would cover the new-bot control directly beneath it.
    expect(switcherParts(true).popup.side).toBe("right");
    expect(switcherParts(false).popup.side).toBe("bottom");
  });
});
