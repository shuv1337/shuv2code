/**
 * The bot-desktop ("Screen") phase machine and its poster copy, shared by every
 * client (spec §4.6, MESSENGER-PIVOT §2 M6).
 *
 * The rule this file exists to enforce: **viewing never spawns a desktop.** A
 * viewer path only appears once the server has said a desktop is running, so no
 * surface — the web Screen tab, the right rail thumbnail, a phone — can start a
 * container by rendering.
 *
 * It lives in `client-runtime` rather than in `apps/web` because mobile needs
 * the same answer for the opposite reason: it has no viewer at all (noVNC has
 * no React Native port, and the viewer socket is what holds a desktop open
 * against the idle stop), so the phone renders this phase text and says plainly
 * where the live picture can be watched. Sharing the machine is what keeps
 * "there is no desktop" and "there is a desktop you cannot see here" from
 * becoming two different vocabularies.
 */
import type { AdeBotScreen } from "@shuv2code/contracts";
export type BotScreenPhase =
  /** No Screenbox on this host at all. */
  | "unavailable"
  /** Computer use is off, so this bot may not have a desktop. */
  | "disabled"
  /** Eligible, but nothing has ever been provisioned. */
  | "not-started"
  /** Upstream is bringing a container up. */
  | "starting"
  /** Running and viewable. */
  | "live"
  /** Provisioned once, currently stopped; its data is still on disk. */
  | "stopped"
  /** The last provision attempt failed. */
  | "failed";

export interface BotScreenView {
  readonly phase: BotScreenPhase;
  readonly headline: string;
  readonly detail: string;
  /**
   * Non-null only when a viewer should connect. The client never builds this
   * path itself — a desktop that is not running has no port behind it.
   */
  readonly viewerPath: string | null;
  readonly canStart: boolean;
  readonly canStop: boolean;
  readonly viewers: number;
}

/**
 * Poster copy for every phase the panel and the full Screen tab share.
 *
 * De-narrated in #217. The headline states the state; the detail is the one
 * next action, or empty when the affordance beside it already is the action.
 * Three rules the earlier copy broke:
 *
 *  - Never describe this UI's own behaviour. "Opening this tab never starts
 *    one" and "You are watching this bot's live desktop" both told a captain
 *    what the screen they are looking at is doing.
 *  - Never restate the headline. "The desktop is stopped." under "Desktop
 *    stopped" is the same fact with more words.
 *  - Keep system vocabulary out of primary copy. "Waiting for Screenbox to
 *    bring the container up" names a container runtime at a captain who wants
 *    to know whether to keep waiting.
 *
 * `detail: ""` is a deliberate value, not a gap: the phases whose next action
 * is the Start/Resume button beside them say nothing rather than narrating it.
 */
const PHASE_COPY: Record<BotScreenPhase, { headline: string; detail: string }> = {
  unavailable: {
    headline: "Screenbox is not configured",
    detail: "Configure a Screenbox host to give bots desktops.",
  },
  disabled: {
    headline: "Computer use is off",
    detail: "Turn on computer use for this bot.",
  },
  "not-started": {
    headline: "No desktop running",
    detail: "",
  },
  starting: {
    headline: "Starting a desktop",
    detail: "",
  },
  live: {
    headline: "Desktop running",
    detail: "",
  },
  stopped: {
    headline: "Desktop stopped",
    detail: "Files are kept — resuming picks up where it left off.",
  },
  failed: {
    headline: "Desktop failed to start",
    detail: "Check Needs You for the reason.",
  },
};

const phaseOf = (screen: AdeBotScreen): BotScreenPhase => {
  if (!screen.screenboxConfigured) return "unavailable";
  // Computer use gates whether this bot may have a desktop at all — but only
  // when there is no desktop yet. Turning the toggle off with a container still
  // running must keep Stop reachable, or the captain would have no way to shut
  // down the desktop they just orphaned.
  if (!screen.computerUse && (screen.status === "none" || screen.status === "failed")) {
    return "disabled";
  }
  switch (screen.status) {
    case "provisioning":
      return "starting";
    case "running":
      return "live";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
    default:
      return "not-started";
  }
};

export function getBotScreenView(screen: AdeBotScreen): BotScreenView {
  const phase = phaseOf(screen);
  const copy = PHASE_COPY[phase];
  return {
    phase,
    headline: copy.headline,
    detail: copy.detail,
    // Even in the `live` phase the server has the last word: if it declined to
    // hand back a path (upstream lost the desktop between the two reads) the
    // viewer must not try to connect anyway.
    viewerPath: phase === "live" ? screen.viewerPath : null,
    canStart: phase === "not-started" || phase === "stopped" || phase === "failed",
    canStop: phase === "live" || phase === "starting",
    viewers: screen.viewers,
  };
}

/* ─── Panel presentation ─────────────────────────────────────────────── */

/**
 * Presentation on top of the phase answer: what the poster says when there is
 * nothing to show, which buttons a narrow surface can afford, and whether there
 * is a canvas worth opening fullscreen. Still no provisioning — every field
 * below is derived from `getBotScreenView`, which the server's status alone
 * decides.
 */
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
