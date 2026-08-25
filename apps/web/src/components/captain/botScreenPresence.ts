/**
 * When the right rail's screen thumbnail may hold a viewer socket open
 * (`docs/ade/MESSENGER-PIVOT.md` §2, M6).
 *
 * This exists because presence and rendering are the same act. The server
 * counts attached viewers by relayed-socket lifetime and those viewers hold a
 * desktop against the idle stop, so *mounting the viewer is what keeps a
 * Screenbox slot alive*. The rail mounts wherever a conversation is open, which
 * made the first cut of this panel quietly defeat the idle policy: leave a chat
 * open overnight and the bot's desktop never stops, whether or not anyone was
 * looking at it. At a fleet's slot cap that is someone else's Start failing.
 *
 * So the rail attaches only while the thumbnail is genuinely being looked at.
 * The Screen tab is a *destination* — opening it is the act of looking — and
 * its semantics are deliberately untouched; the rail is ambient, and ambient
 * surfaces have to earn their socket.
 */

export interface BotScreenPresenceInput {
  /** The server said a desktop is live and gave us somewhere to connect. */
  readonly hasViewerPath: boolean;
  /** The panel is within (or near) the rail's scroll viewport. */
  readonly intersecting: boolean;
  /** `document.visibilityState === "hidden"` — backgrounded tab, locked screen. */
  readonly documentHidden: boolean;
  /**
   * The fullscreen dialog is open. It mounts its own viewer, so the thumbnail
   * suspends rather than doubling one human into two counted viewers.
   */
  readonly fullscreenOpen: boolean;
}

export function shouldAttachBotScreenViewer(input: BotScreenPresenceInput): boolean {
  if (!input.hasViewerPath) return false;
  if (input.documentHidden) return false;
  if (input.fullscreenOpen) return false;
  return input.intersecting;
}

/**
 * What the thumbnail shows while it is not attached.
 *
 * A detached-but-live desktop is not the same as no desktop: the poster must
 * not say "No desktop running" at a container that is running perfectly well
 * and simply is not being watched. Nor should it look broken — nothing is
 * wrong, the rail is just being a good citizen.
 */
export function botScreenDetachedNote(input: {
  readonly hasViewerPath: boolean;
  readonly fullscreenOpen: boolean;
}): string | null {
  if (!input.hasViewerPath) return null;
  if (input.fullscreenOpen) return "Showing fullscreen.";
  return "Paused while off-screen. Scroll back to watch.";
}
