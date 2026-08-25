/**
 * The conversation header is the only mount point for the identity controls
 * (§2, M2 / #197), so these cover the failure that neither a component test of
 * the actions nor a logic test of the regions can see: the shell being handed
 * `conversationHeaderActions` at some width and quietly rendering no header to
 * put them in.
 *
 * The predicate is asserted across every band; the header itself is rendered
 * to markup so "the actions land inside it" is checked against real output
 * rather than inferred from the gate in front of it.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { ConversationHeader } from "./CaptainShell";
import {
  resolveCaptainShellRegions,
  shouldRenderConversationHeader,
  type CaptainLayoutMode,
} from "./captainShell.logic";

const ALL_MODES: ReadonlyArray<CaptainLayoutMode> = [
  "three-rails",
  "right-overlay",
  "icon-left-rail",
  "single-column",
];

const regionsFor = (mode: CaptainLayoutMode) =>
  resolveCaptainShellRegions({
    mode,
    leftRailCollapsed: false,
    rightRailCollapsed: false,
    hasConversation: true,
  });

describe("shouldRenderConversationHeader", () => {
  /**
   * The regression this file exists for. At the reference width there is no
   * back chevron and — until M6 — no right rail, so a header gated only on
   * those would never appear on the widest, most-used layout, taking the
   * rename and the identity gear with it.
   */
  it("renders the header at every width once actions are supplied", () => {
    for (const mode of ALL_MODES) {
      expect(
        shouldRenderConversationHeader({
          regions: regionsFor(mode),
          hasActions: true,
          hasRightRail: false,
        }),
      ).toBe(true);
    }
  });

  it("still renders it for the chevron or the rail toggle without actions", () => {
    // Single column: the back chevron is the whole reason for the header.
    expect(
      shouldRenderConversationHeader({
        regions: regionsFor("single-column"),
        hasActions: false,
        hasRightRail: false,
      }),
    ).toBe(true);
    // Three rails: nothing to show until a right rail exists to toggle.
    expect(
      shouldRenderConversationHeader({
        regions: regionsFor("three-rails"),
        hasActions: false,
        hasRightRail: false,
      }),
    ).toBe(false);
    expect(
      shouldRenderConversationHeader({
        regions: regionsFor("three-rails"),
        hasActions: false,
        hasRightRail: true,
      }),
    ).toBe(true);
  });

  it("never renders a header for a region that is not on screen", () => {
    const indexRegions = resolveCaptainShellRegions({
      mode: "single-column",
      leftRailCollapsed: false,
      rightRailCollapsed: false,
      hasConversation: false,
    });
    expect(
      shouldRenderConversationHeader({
        regions: indexRegions,
        hasActions: true,
        hasRightRail: true,
      }),
    ).toBe(false);
  });
});

describe("ConversationHeader", () => {
  const render = (actions: React.ReactNode) =>
    renderToStaticMarkup(
      <ConversationHeader
        actions={actions}
        insetForTitlebar={false}
        onToggleRightRail={() => {}}
        rightRailShown={false}
        rightRailToggleRef={{ current: null }}
        // False at three-rails, which is also what keeps this render free of a
        // router: the chevron is the header's only `Link`.
        showBackChevron={false}
        showRightRailToggle={false}
      />,
    );

  it("mounts the identity affordances it is given", () => {
    const markup = render(
      <>
        <button aria-label="Bot identity" type="button">
          gear
        </button>
        <button title="Rename" type="button">
          Second Mate
        </button>
      </>,
    );

    expect(markup).toContain('aria-label="Bot identity"');
    expect(markup).toContain('title="Rename"');
    expect(markup).toContain("Second Mate");
  });

  it("keeps the design's fixed-height header rather than collapsing to its content", () => {
    const markup = render(null);
    expect(markup).toContain("h-[var(--workspace-topbar-height)]");
  });
});
