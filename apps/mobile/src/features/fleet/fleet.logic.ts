/**
 * Pure view logic for mobile bot mode (PASS 1).
 *
 * Everything the phone shares with the web captain surface — the contact row
 * model, unread copy, the connect state machine, read-mark timing — lives in
 * `@shuv2code/client-runtime/ade/*` and is imported, not restated. What is left
 * here is genuinely mobile-shaped: which environment the fleet is read from
 * (web keys that on a `PrimaryConnectionTarget` mobile never mints), how a
 * grouped roster flattens into one `LegendList` of keyed rows, and how an
 * avatar token becomes something React Native can paint.
 */
import type { EnvironmentId } from "@shuv2code/contracts";
import {
  getContactGroupSections,
  type ContactRowView,
} from "@shuv2code/client-runtime/ade/contact-rail";
import { BOT_AVATAR_COLORS, isBotAvatarColor } from "@shuv2code/client-runtime/ade/bot-identity";
import type { BotAvatarColorToken } from "@shuv2code/contracts";

/* ─── Which environment is the fleet ─────────────────────────────────── */

export interface AdeEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  /** `EnvironmentConnectionPhase`, kept structural so this stays test-cheap. */
  readonly connectionState: string;
}

/**
 * The environment mobile reads the fleet from.
 *
 * The ADE fleet is server-local — bots, assignments and memory are rows on one
 * server — so a fleet surface pointed at a second environment is reading a
 * different fleet entirely. Web settles this with `PrimaryConnectionTarget`,
 * which mobile has no equivalent of.
 *
 * The mobile rule, in order:
 *
 * 1. **The captain's explicit choice**, when it is still a known environment.
 *    This is Home's environment filter, shared through `HomeListOptions`, so
 *    "which server am I looking at" is answered once for the whole workspace
 *    rather than twice with two different answers.
 * 2. **The connected environment.** A roster read against a disconnected
 *    server produces a spinner and nothing else.
 * 3. **The first environment at all**, so a phone that is mid-reconnect shows
 *    the fleet it is about to have rather than an empty state that implies
 *    there is none.
 */
export function resolveAdeEnvironmentId(input: {
  readonly environments: ReadonlyArray<AdeEnvironmentCandidate>;
  readonly preferredEnvironmentId: EnvironmentId | null;
}): EnvironmentId | null {
  const preferred =
    input.preferredEnvironmentId === null
      ? null
      : (input.environments.find(
          (environment) => environment.environmentId === input.preferredEnvironmentId,
        ) ?? null);
  if (preferred !== null) {
    return preferred.environmentId;
  }
  const connected = input.environments.find(
    (environment) => environment.connectionState === "connected",
  );
  return connected?.environmentId ?? input.environments[0]?.environmentId ?? null;
}

/* ─── The list ───────────────────────────────────────────────────────── */

export type FleetListItem =
  | { readonly kind: "group"; readonly key: string; readonly name: string }
  | { readonly kind: "contact"; readonly key: string; readonly row: ContactRowView };

/**
 * Flatten the grouped roster into the single keyed array a `LegendList` wants,
 * exactly as `HomeScreen` flattens projects and threads.
 *
 * Group headers are dropped when the whole roster is one implicit bucket: a
 * lone "Ungrouped" header over every contact the captain has is a label that
 * distinguishes nothing, and on a 390pt screen a row of chrome has to earn its
 * place. Two or more sections and the headers come back, because then they are
 * telling the captain something.
 */
export function buildFleetListItems(input: {
  readonly rows: ReadonlyArray<ContactRowView>;
  readonly groups: ReadonlyArray<{ readonly id: string; readonly name: string }>;
}): ReadonlyArray<FleetListItem> {
  const sections = getContactGroupSections(
    input.rows,
    // `getContactGroupSections` only reads `id` and `name`; the roster's group
    // records carry more, and this keeps the mobile caller from having to
    // rebuild them.
    input.groups as Parameters<typeof getContactGroupSections>[1],
  );
  if (sections.length <= 1) {
    return input.rows.map(contactItem);
  }
  const items: Array<FleetListItem> = [];
  for (const section of sections) {
    items.push({ kind: "group", key: `group:${section.groupId}`, name: section.name });
    for (const row of section.rows) {
      items.push(contactItem(row));
    }
  }
  return items;
}

function contactItem(row: ContactRowView): FleetListItem {
  return { kind: "contact", key: `bot:${row.botId}`, row };
}

/* ─── Avatars ────────────────────────────────────────────────────────── */

export interface BotAvatarTint {
  /**
   * A Uniwind background class for a palette token, or null. Tokens resolve to
   * a theme class rather than to a literal so a bot's blob is the same colour
   * the rest of the app calls "amber", in both schemes.
   */
  readonly className: string | null;
  /** A literal React Native colour, used when there is no token to name. */
  readonly color: string | null;
}

/**
 * What to paint behind a bot's initials.
 *
 * Web's `resolveBotAvatarBackground` answers this with a CSS string —
 * `var(--color-amber-500)`, `color-mix(...)` — none of which React Native can
 * parse, which is why this is a mobile function rather than a shared one. The
 * *token vocabulary* is still shared (`isBotAvatarColor`), so the picker and
 * the blob cannot disagree about which colours exist; only the way a token
 * becomes pixels differs.
 *
 * The fallback is the same deterministic hue web uses, emitted in the
 * comma-separated `hsl()` form React Native accepts.
 */
export function resolveBotAvatarTint(avatar: {
  readonly color: string | null;
  readonly hue: number;
}): BotAvatarTint {
  if (avatar.color !== null && isBotAvatarColor(avatar.color)) {
    return { className: BOT_AVATAR_TINT_CLASS[avatar.color], color: null };
  }
  return { className: null, color: `hsl(${avatar.hue}, 62%, 42%)` };
}

/**
 * Spelled out rather than interpolated. Uniwind, like Tailwind, only emits the
 * class names it can find as literals in the source, so a `bg-${token}-500`
 * template compiles to a blob with no background at all — the exact failure
 * `resolveBotAvatarColor` exists on web to prevent, arriving through a
 * different door. The `Record<BotAvatarColorToken, …>` annotation is what keeps
 * this table and the contract's palette from drifting: adding a token to the
 * schema without adding it here fails to typecheck.
 */
const BOT_AVATAR_TINT_CLASS: Record<BotAvatarColorToken, string> = {
  blue: "bg-blue-500",
  teal: "bg-teal-500",
  emerald: "bg-emerald-500",
  lime: "bg-lime-500",
  amber: "bg-amber-500",
  orange: "bg-orange-500",
  rose: "bg-rose-500",
  fuchsia: "bg-fuchsia-500",
  violet: "bg-violet-500",
  indigo: "bg-indigo-500",
};

/** Every palette token has a class. Exported so a test can assert it too. */
export function botAvatarTintClassNames(): ReadonlyArray<string> {
  return BOT_AVATAR_COLORS.map((token) => BOT_AVATAR_TINT_CLASS[token]);
}

/* ─── "Is the captain reading this?" ─────────────────────────────────── */

/**
 * The mobile substitute for web's `document.hasFocus()` /
 * `document.visibilityState` pair.
 *
 * A phone has two independent ways to stop being read — the screen can be
 * pushed under another route, and the whole app can go to the background — and
 * both have to count, because the server's read mark is monotonic. Marking a
 * conversation read while the captain is in another app is irreversible and
 * wrong; leaving a dot on a conversation they are staring at is recoverable by
 * doing nothing.
 *
 * `"inactive"` is deliberately *not* readable: on iOS it is the app-switcher
 * and notification-shade state, which is precisely someone looking away.
 */
export function isBotChatReadable(input: {
  readonly chatReady: boolean;
  readonly screenFocused: boolean;
  /** React Native's `AppStateStatus`, kept structural to stay test-cheap. */
  readonly appState: string;
}): boolean {
  return input.chatReady && input.screenFocused && input.appState === "active";
}
