/**
 * Mobile-shaped view logic for a bot's profile.
 *
 * The facts are all shared: `@shuv2code/client-runtime/ade/bot-detail` owns the
 * header, bindings and persona history, `…/bot-model` owns the model list and
 * its capability flag, `…/bot-screen` owns the desktop phase machine. What is
 * here is what the phone has to answer for itself — how many persona versions a
 * scrolling profile shows before it stops, and the one genuinely mobile-only
 * question: what to say about a desktop this device can watch the *state* of
 * but not the picture.
 */
import {
  getBotScreenPanelView,
  type BotScreenPanelView,
} from "@shuv2code/client-runtime/ade/bot-screen";
import {
  getBotModelLabel,
  isFlaggedBotModel,
  BOT_MODEL_UNSUPPORTED_HINT,
  type BotModelOption,
} from "@shuv2code/client-runtime/ade/bot-model";
import {
  getPersonaVersionViews,
  type PersonaVersionView,
} from "@shuv2code/client-runtime/ade/bot-detail";
import type { AdeBotDetail, AdeBotScreen } from "@shuv2code/contracts";

/* ─── The model row ──────────────────────────────────────────────────── */

export interface BotModelRowView {
  readonly label: string;
  /** Shown under the label when the kernel reported this model as unfit. */
  readonly warning: string | null;
}

/**
 * What the profile's Model row reads, collapsed to the one line a settings row
 * has. A bot with no pin is not broken — it runs whatever the resolution ladder
 * picks — so `getBotModelLabel` answers "Kernel default" rather than blank.
 */
export function getBotModelRowView(
  detail: AdeBotDetail | null,
  options: ReadonlyArray<BotModelOption>,
): BotModelRowView {
  const slug = detail?.modelSlug ?? null;
  return {
    label: getBotModelLabel(options, slug),
    warning: isFlaggedBotModel(options, slug) ? BOT_MODEL_UNSUPPORTED_HINT : null,
  };
}

/* ─── Persona history ────────────────────────────────────────────────── */

/**
 * How many persona versions a phone profile lists before it stops.
 *
 * The head is what the bot will actually adopt next; everything under it is
 * provenance. Three is enough to see "the current one, the one before it, and
 * that there is a before that" without turning a profile into a changelog on a
 * screen with no room to scroll past it.
 */
export const MOBILE_PERSONA_VERSION_LIMIT = 3;

export interface PersonaHistoryView {
  readonly versions: ReadonlyArray<PersonaVersionView>;
  /** "2 older versions", or null when nothing was withheld. */
  readonly hiddenLabel: string | null;
}

export function getPersonaHistoryView(detail: AdeBotDetail | null): PersonaHistoryView {
  if (detail === null) return { versions: [], hiddenLabel: null };
  const all = getPersonaVersionViews(detail.personaVersions, detail.bot.activePersonaVersionId);
  const hidden = all.length - MOBILE_PERSONA_VERSION_LIMIT;
  return {
    versions: all.slice(0, MOBILE_PERSONA_VERSION_LIMIT),
    hiddenLabel: hidden <= 0 ? null : hidden === 1 ? "1 older version" : `${hidden} older versions`,
  };
}

/* ─── The screen this phone cannot show ──────────────────────────────── */

export interface BotScreenMobileView {
  readonly title: string;
  readonly headline: string;
  /** The shared phase detail, or the mobile explanation for a live desktop. */
  readonly detail: string;
  readonly viewersLabel: string | null;
  /**
   * True when a desktop is running and this device simply has no way to draw
   * it. Distinct from "there is no desktop", which is what every other phase
   * means — a captain deciding whether to walk to their machine needs to know
   * which of the two they are looking at.
   */
  readonly liveElsewhere: boolean;
}

/**
 * Why a phone has no viewer, said once, where the viewer would have been.
 *
 * noVNC has no React Native port, and porting one is not merely missing work:
 * the viewer's WebSocket *is* the presence signal the server brackets
 * `viewerAttached`/`viewerDetached` on, and those attached viewers are what
 * hold a desktop open against the idle stop. A half-built RN viewer would
 * either fail to hold presence or hold it wrongly, silently changing how long
 * desktops live. So the phone reports the phase honestly and points at the
 * surface that can watch it, rather than offering a control that would lie.
 */
export const BOT_SCREEN_MOBILE_DETAIL =
  "Open this bot on your captain machine to watch the screen. Phones show the desktop's state, not its picture.";

export function getBotScreenMobileView(input: {
  readonly screen: AdeBotScreen | null;
  readonly botName: string;
}): BotScreenMobileView | null {
  if (input.screen === null) return null;
  const panel: BotScreenPanelView = getBotScreenPanelView({
    screen: input.screen,
    botName: input.botName,
  });
  const liveElsewhere = panel.phase === "live";
  return {
    title: panel.title,
    headline: panel.headline,
    // Every non-live phase already has copy that names its own next action, and
    // three of them have none on purpose (the action is the button beside it on
    // web). An empty detail is left empty rather than filled with the viewer
    // explanation, which would be answering a question nobody asked about a
    // desktop that does not exist.
    detail: liveElsewhere ? BOT_SCREEN_MOBILE_DETAIL : panel.detail,
    viewersLabel: panel.viewersLabel,
    liveElsewhere,
  };
}
