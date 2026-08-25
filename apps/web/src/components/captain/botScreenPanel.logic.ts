/**
 * Pure view mapping for the right rail's screen thumbnail (MESSENGER-PIVOT §2,
 * M6).
 *
 * This is deliberately a *second consumer* of `fleet/BotScreenTab.logic`, not a
 * second copy of it. `getBotScreenView` still owns the whole phase machine and
 * the rule the whole feature exists to protect — **viewing never provisions a
 * desktop**: a viewer path only appears once the server has said a desktop is
 * running, so mounting the rail can no more start a container than opening the
 * Screen tab could. Everything below is presentation on top of that answer:
 * what the poster says when there is nothing to show, which buttons the 470px
 * rail can afford, and whether there is a canvas worth opening fullscreen.
 */
import type { AdeBotScreen } from "@shuv2code/contracts";

import { getBotScreenView, type BotScreenPhase } from "../fleet/BotScreenTab.logic";

export interface BotScreenPanelView {
  readonly phase: BotScreenPhase;
  /** Section title: "⟨Bot⟩'s screen" (§2). */
  readonly title: string;
  readonly headline: string;
  readonly detail: string;
  /**
   * Non-null only when the server has already handed back a live desktop. The
   * rail never synthesises one.
   */
  readonly viewerPath: string | null;
  /** The idle poster shows whenever there is no live canvas. */
  readonly showPoster: boolean;
  readonly startLabel: string | null;
  readonly stopLabel: string | null;
  /** Whether the thumbnail opens the fullscreen dialog. */
  readonly canExpand: boolean;
  readonly expandLabel: string;
  readonly fullscreenTitle: string;
  readonly viewers: number;
  readonly viewersLabel: string | null;
}

/**
 * The rail's own label for the section and for the fullscreen dialog. Kept
 * here rather than inlined in JSX so the dialog and the thumbnail cannot drift
 * apart, and so an empty/whitespace bot name degrades to something sayable
 * instead of "'s screen".
 */
export function botScreenPanelTitle(botName: string): string {
  const trimmed = botName.trim();
  return trimmed.length === 0 ? "Bot screen" : `${trimmed}'s screen`;
}

/**
 * Start is offered exactly where `getBotScreenView` says a start is legal, and
 * the wording names what pressing it will do to *this* phase. A stopped
 * desktop keeps its disk, so "Resume" is the honest verb; a failed one has
 * already been tried once, so "Try again" is.
 */
function startLabelFor(phase: BotScreenPhase): string {
  switch (phase) {
    case "stopped":
      return "Resume desktop";
    case "failed":
      return "Try again";
    default:
      return "Start desktop";
  }
}

export function getBotScreenPanelView(input: {
  readonly screen: AdeBotScreen;
  readonly botName: string;
}): BotScreenPanelView {
  const view = getBotScreenView(input.screen);
  const title = botScreenPanelTitle(input.botName);
  const hasCanvas = view.viewerPath !== null;
  return {
    phase: view.phase,
    title,
    headline: view.headline,
    detail: view.detail,
    viewerPath: view.viewerPath,
    showPoster: !hasCanvas,
    startLabel: view.canStart ? startLabelFor(view.phase) : null,
    stopLabel: view.canStop ? "Stop desktop" : null,
    // Nothing to enlarge without a canvas: an expandable poster would open a
    // fullscreen dialog onto the same "no desktop running" sentence.
    canExpand: hasCanvas,
    expandLabel: `Open ${title} fullscreen`,
    fullscreenTitle: title,
    viewers: view.viewers,
    viewersLabel:
      view.viewers <= 0 ? null : view.viewers === 1 ? "1 viewer" : `${view.viewers} viewers`,
  };
}
