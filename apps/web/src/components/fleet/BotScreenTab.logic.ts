/**
 * Pure view mapping for the bot detail Screen tab (spec §4.6).
 *
 * The rule this file exists to enforce: **viewing never spawns a desktop.**
 * The viewer connects only when the server has already said a desktop is
 * running and handed back a `viewerPath`; every other state renders an
 * explanation and, where it makes sense, a Start button the captain must press.
 */
import type { AdeBotScreen } from "@shuv2code/contracts";

/**
 * Operator workaround for a known upstream defect, surfaced in the delete
 * confirmation rather than buried in a server log.
 *
 * Screenbox's `delete-data` answers `{"deleted": true}` even when removing the
 * desktop's home volume failed: its docker-proxy whitelist has no
 * `DELETE /volumes` route. shuv2code deliberately makes no docker calls of its
 * own, so a captain who needs the disk back has to run this on the Screenbox
 * host. Telling them at the moment they confirm is the only honest place —
 * afterwards there is no bot left to hang the warning on.
 */
export const deleteVolumeWorkaroundFor = (botId: string): string =>
  `docker volume rm -f screenbox-${botId}-home`;

export const DELETE_VOLUME_WORKAROUND_NOTE =
  "Screenbox reports success even when it cannot remove the desktop's home volume. If you need the disk space back, run this on the Screenbox host afterwards:";

/** Endpoint that mints the short-lived ticket a WebSocket upgrade carries. */
export const WEBSOCKET_TICKET_PATH = "/api/auth/websocket-ticket";

/**
 * Turns the server-issued viewer path into the WebSocket URL noVNC opens.
 *
 * Same-origin by construction: ADE is a primary-environment-only surface and
 * the primary environment is the server that served this page. Building the URL
 * from an origin the server did not name is what this signature is shaped to
 * prevent — the path always comes from `AdeBotScreen.viewerPath`, never from
 * the client.
 *
 * The `wsTicket` is not optional. A browser cannot set an `Authorization`
 * header on a WebSocket, so header-bearing clients (the desktop app, anything
 * on a bearer or DPoP token) have no way to authenticate an upgrade *except*
 * this query parameter — the RPC socket at `/ws` carries one for exactly that
 * reason. Relying on the session cookie alone works only in a plain browser
 * tab and fails silently with a 401 everywhere else.
 */
export function viewerSocketUrl(input: {
  readonly pageOrigin: string;
  readonly viewerPath: string;
  readonly wsTicket: string;
}): string {
  const url = new URL(input.viewerPath, input.pageOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", input.wsTicket);
  return url.toString();
}

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

const PHASE_COPY: Record<BotScreenPhase, { headline: string; detail: string }> = {
  unavailable: {
    headline: "Screenbox is not configured",
    detail: "This server has no Screenbox host, so bots cannot have desktops.",
  },
  disabled: {
    headline: "Computer use is off",
    detail: "Turn on computer use for this bot to give it a desktop.",
  },
  "not-started": {
    headline: "No desktop running",
    detail: "Start a desktop to watch this bot work. Opening this tab never starts one.",
  },
  starting: {
    headline: "Starting a desktop",
    detail: "Waiting for Screenbox to bring the container up.",
  },
  live: {
    headline: "Desktop running",
    detail: "You are watching this bot's live desktop.",
  },
  stopped: {
    headline: "Desktop stopped",
    detail: "The desktop is stopped. Its files are kept, so starting it again resumes the data.",
  },
  failed: {
    headline: "Desktop failed to start",
    detail: "Screenbox could not provide a desktop for this bot. Check Needs You for details.",
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
