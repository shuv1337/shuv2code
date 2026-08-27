/**
 * Pure view mapping for the captain's contact rail (MESSENGER-PIVOT §3, M1).
 *
 * This absorbs `fleet/FleetRosterPage.logic.ts` wholesale — the server owns the
 * order (Firstmate, then the other coordinators, then crew), so nothing here
 * re-sorts; it only decides what each row says — and adds the rail's own
 * concerns: the avatar model, search, and group bucketing.
 *
 * Groups are an M2 (#197) delivery, and they have landed: `getContactGroupSections`
 * buckets by `Bot.groupId` against the roster's captain-defined groups. The
 * trailing "Ungrouped" section stays implicit — it is the absence of a group,
 * not a row the server stores — which is what keeps deleting a group a pure
 * ungrouping rather than something that could reach a bot.
 *
 * M3 (#196) adds liveness: what each contact last said, how much of it the
 * captain has not read, and what is waiting on a decision. Note what is *not*
 * here — preview precedence and the wording of the amber line are settled on
 * the server (`ade/adeRosterLiveness.ts`), so a mobile rail and this one cannot
 * disagree about which message a row is quoting. What is left here is the last
 * term of that precedence (no message to quote → describe the bot), the
 * captain's "You: " prefix, and the `?filter=attention` view that retires the
 * standalone needs-you inbox.
 */
import type {
  AdeBotGroup,
  AdeBotGroupId,
  AdeBotTemplateSummary,
  AdeNeedsYouEntry,
  AdeRoster,
  AdeRosterEntry,
  BotDisplayMeta,
  BotId,
} from "@shuv2code/contracts";

import { structuralRoleLabel } from "./logic.ts";
import { formatRelativeTimeLabel } from "./relativeTime.ts";
import { resolveBotAvatarColor } from "./botIdentity.ts";

/** The implicit trailing bucket every ungrouped bot falls into (§2). */
export const UNGROUPED_SECTION_ID = "__ungrouped__";
export const UNGROUPED_SECTION_NAME = "Ungrouped";

export interface BotAvatarView {
  /** Captain-chosen glyph from `BotDisplayMeta`, when set. */
  readonly emoji: string | null;
  /** Captain-chosen colour from `BotDisplayMeta`, when set. */
  readonly color: string | null;
  /** Fallback glyph: up to two initials taken from the name. */
  readonly initials: string;
  /** Deterministic fallback hue in [0, 360). Same bot, same colour, forever. */
  readonly hue: number;
}

export interface ContactRowView {
  readonly botId: BotId;
  readonly name: string;
  readonly roleLabel: string;
  readonly roleTag: string;
  readonly projectLabel: string;
  /** The Firstmate is pinned at the top and marked; it is never archivable. */
  readonly isFirstmate: boolean;
  readonly openAssignmentLabel: string | null;
  /** A warm session is resumed rather than started (spec §4.1 lazy sessions). */
  readonly chatLabel: string;
  /**
   * Whether a `primary-text` binding is already live. The rail shows this as a
   * presence dot: "is this bot awake" is the first thing a messenger contact
   * list answers, and burying it in a `title` attribute answers it for nobody.
   */
  readonly isOnline: boolean;
  /** What the presence dot announces, since the dot itself is decoration. */
  readonly presenceLabel: string;
  /**
   * The dim one-line under the name: the tail of the conversation when there
   * is one, the bot's home and open assignments when there is not.
   */
  readonly secondaryLine: string;
  /**
   * Whether `secondaryLine` is quoting the conversation. The row renders a
   * quoted line differently from a description of the bot — the first is what
   * happened, the second is what the bot *is* — and only a quote gets the
   * "You: " prefix.
   */
  readonly secondaryKind: "preview" | "description";
  /**
   * The amber line, when something is waiting on the captain. Present *as well
   * as* `secondaryLine` rather than instead of it, so the row can decide: the
   * rail swaps the preview for this (§2), but a mobile row or a tooltip may
   * want both without re-deriving either.
   */
  readonly attentionLine: string | null;
  /** Right-aligned relative time for the tail message; null when there is none. */
  readonly timeLabel: string | null;
  /** Machine-readable instant behind `timeLabel`, for `<time dateTime>`. */
  readonly timeIso: string | null;
  /** Bot messages the captain has not seen. Zero renders no dot. */
  readonly unreadCount: number;
  /** What the unread dot announces, since a dot alone announces nothing. */
  readonly unreadLabel: string | null;
  readonly avatar: BotAvatarView;
  /** Captain-defined group membership; null is the implicit Ungrouped bucket. */
  readonly groupId: AdeBotGroupId | null;
}

export interface ContactGroupSectionView {
  readonly groupId: string;
  readonly name: string;
  readonly rows: ReadonlyArray<ContactRowView>;
}

/**
 * A stable hue from the bot id. FNV-1a rather than a sum of char codes: ids
 * that differ only in their last character must not land on the same colour,
 * which is exactly the case a roster produces (`bot_1`, `bot_2`, …).
 */
export function botAvatarHue(botId: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < botId.length; index += 1) {
    hash ^= botId.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

/**
 * Up to two initials. Words are whatever whitespace separates, so "Second
 * Mate" reads "SM" and "Firstmate" reads "F"; a name with no letters at all
 * still yields something printable rather than an empty blob.
 */
export function botAvatarInitials(name: string): string {
  const words = name.trim().split(/\s+/u).filter(Boolean);
  if (words.length === 0) {
    return "?";
  }
  const first = [...words[0]!][0] ?? "";
  const second = words.length > 1 ? ([...words[words.length - 1]!][0] ?? "") : "";
  const initials = `${first}${second}`.toLocaleUpperCase();
  return initials.length === 0 ? "?" : initials;
}

export function getBotAvatarView(input: {
  readonly botId: string;
  readonly name: string;
  readonly displayMeta: BotDisplayMeta | null;
}): BotAvatarView {
  const emoji = input.displayMeta?.emoji?.trim();
  const color = input.displayMeta?.color?.trim();
  return {
    emoji: emoji ? emoji : null,
    color: color ? color : null,
    initials: botAvatarInitials(input.name),
    hue: botAvatarHue(input.botId),
  };
}

/** A CSS colour this file is willing to hand straight to `background-color`. */
const CSS_COLOUR_LITERAL =
  /^(?:#[0-9a-f]{3,8}|(?:rgba?|hsla?|okla[bc]|la[bc]|lch|color|color-mix|var)\()/iu;

/**
 * The blob's background. Resolved through one function so there is exactly one
 * place to teach about colour, and so an unusable value degrades to the
 * deterministic hue instead of to `background-color: amber` — which no browser
 * understands and which paints a transparent blob.
 *
 * M2 (#197) constrains `BotDisplayMeta.color` to a theme-token union
 * ("amber", "emerald", …) and exports `resolveBotAvatarColor(token)` from
 * `captain/botIdentity.logic.ts`. That is what the token branch below
 * delegates to, so the picker's swatch and the blob it paints cannot disagree.
 * The literal branch stays for a value stored before the union landed, and the
 * hue stays as the answer for unset and for anything neither recognises.
 */
export function resolveBotAvatarBackground(avatar: BotAvatarView): string {
  const token = avatar.color === null ? null : resolveBotAvatarColor(avatar.color);
  if (token !== null) {
    return token;
  }
  if (avatar.color !== null && CSS_COLOUR_LITERAL.test(avatar.color)) {
    return avatar.color;
  }
  return `hsl(${avatar.hue} 62% 42%)`;
}

/** Ported from `FleetRosterPage.logic.ts`; the wording is unchanged. */
export function openAssignmentLabel(openAssignmentCount: number): string | null {
  if (openAssignmentCount <= 0) {
    return null;
  }
  return openAssignmentCount === 1
    ? "1 open assignment"
    : `${openAssignmentCount} open assignments`;
}

/**
 * The unread badge's ceiling, mirroring the server's own cap. The server never
 * reports more than 99, so this is a rendering rule rather than a second
 * truncation: it decides how "99" is *printed* when it is really "at least 99".
 */
export const UNREAD_DISPLAY_CAP = 99;

export function unreadBadgeLabel(count: number): string {
  return count >= UNREAD_DISPLAY_CAP ? `${UNREAD_DISPLAY_CAP}+` : String(count);
}

/**
 * What the unread dot says out loud. The dot itself is decoration — a captain
 * using a screen reader gets a count and a subject, not a coloured circle.
 */
export function unreadAnnouncement(count: number): string | null {
  if (count <= 0) return null;
  return count === 1 ? "1 unread message" : `${unreadBadgeLabel(count)} unread messages`;
}

/**
 * The row's dim line, and what kind of thing it is.
 *
 * Preview precedence (§4) is settled on the server — it decides *which*
 * message, and withholds one entirely for a bot mid-secure-request. What is
 * left here is the last term of that precedence: with no message to quote, the
 * row falls back to describing the bot rather than printing an empty line. A
 * blank second line under a name reads as a rendering bug, not as silence.
 *
 * The captain's own last message is prefixed rather than attributed in full.
 * "You: shipped it" is how every messenger says this, and the alternative —
 * printing the captain's own name — spends the row's scarcest resource
 * (horizontal space at 380px) on the one participant who is never in doubt.
 */
export function resolveSecondaryLine(input: {
  readonly lastMessage: AdeRosterEntry["lastMessage"];
  readonly fallback: string;
}): { readonly line: string; readonly kind: "preview" | "description" } {
  // Nullish rather than `=== null`: the contract defaults this on decode, but
  // the rail also renders payloads that never went through a decoder (tests,
  // and any future in-memory roster), and an absent field must read the same
  // as an explicitly empty one rather than throwing on `.preview`.
  const message = input.lastMessage ?? null;
  if (message === null || message.preview.length === 0) {
    return { line: input.fallback, kind: "description" };
  }
  return {
    line: message.author === "captain" ? `You: ${message.preview}` : message.preview,
    kind: "preview",
  };
}

export function getContactRowView(entry: AdeRosterEntry): ContactRowView {
  const projectLabel = entry.projectName ?? "Fleet-wide";
  const assignments = openAssignmentLabel(entry.openAssignmentCount);
  const description = assignments === null ? projectLabel : `${projectLabel} · ${assignments}`;
  const secondary = resolveSecondaryLine({
    lastMessage: entry.lastMessage,
    fallback: description,
  });
  return {
    botId: entry.bot.id,
    name: entry.bot.name,
    roleLabel: structuralRoleLabel(entry.bot.structuralRole),
    roleTag: entry.bot.roleTag,
    projectLabel,
    isFirstmate: entry.bot.structuralRole === "firstmate",
    openAssignmentLabel: assignments,
    chatLabel: entry.hasActivePrimarySession ? "Resume chat" : "Chat",
    isOnline: entry.hasActivePrimarySession,
    presenceLabel: entry.hasActivePrimarySession ? "Session active" : "No session",
    secondaryLine: secondary.line,
    secondaryKind: secondary.kind,
    attentionLine: entry.attention?.line ?? null,
    timeLabel: entry.lastMessage == null ? null : formatRelativeTimeLabel(entry.lastMessage.at),
    timeIso: entry.lastMessage?.at ?? null,
    unreadCount: entry.unreadCount ?? 0,
    unreadLabel: unreadAnnouncement(entry.unreadCount ?? 0),
    avatar: getBotAvatarView({
      botId: entry.bot.id,
      name: entry.bot.name,
      displayMeta: entry.bot.displayMeta,
    }),
    groupId: entry.bot.groupId,
  };
}

export function getContactRowViews(roster: AdeRoster | null): ReadonlyArray<ContactRowView> {
  return roster === null ? [] : roster.entries.map(getContactRowView);
}

/**
 * Rail search. Matches the bot's name, its role tag, and — since M3 — the last
 * message the row is quoting (§2), case- and accent-insensitively, so "coder"
 * finds Coder whatever the captain renamed it to and "deploy" finds whichever
 * bot just mentioned one. An all-whitespace query is not a filter — it returns
 * the roster intact rather than nothing.
 *
 * Only a *preview* line is searchable. The description fallback restates the
 * project name and assignment count, which are not things a captain searches a
 * contact list for, and matching them would make "shuv2code" return the whole
 * fleet.
 */
export function filterContactRows(
  rows: ReadonlyArray<ContactRowView>,
  query: string,
): ReadonlyArray<ContactRowView> {
  const needle = normalizeSearchText(query);
  if (needle.length === 0) {
    return rows;
  }
  return rows.filter(
    (row) =>
      normalizeSearchText(row.name).includes(needle) ||
      normalizeSearchText(row.roleTag).includes(needle) ||
      (row.secondaryKind === "preview" && normalizeSearchText(row.secondaryLine).includes(needle)),
  );
}

/** The rail's two views (§5 step 4): everything, or only what needs the captain. */
export const CONTACT_RAIL_FILTERS = ["all", "attention"] as const;
export type ContactRailFilter = (typeof CONTACT_RAIL_FILTERS)[number];

/**
 * Narrow an unvalidated `?filter=` to one the rail understands.
 *
 * Anything else is `all`, not an error: the needs-you route redirects into this
 * parameter, and a deep link that arrives with a typo should show the captain
 * their fleet rather than an empty page about a query string.
 */
export function parseContactRailFilter(raw: unknown): ContactRailFilter {
  return raw === "attention" ? "attention" : "all";
}

/**
 * Open items with no bot to sit under.
 *
 * A `kernel-down` names an engine and a bounced change whose author is gone
 * names only an integration candidate, so neither can appear on a contact row —
 * but both are counted by the sidebar badge. With the standalone inbox retired,
 * the Attention view has to show them or the badge points at a page that cannot
 * display what it counts: "1" on the sidebar, "Nothing needs you" underneath.
 *
 * Resolved items are filtered out here as well as by the query, because this
 * feeds the *attention* view specifically: the inbox had a "done" tab and this
 * does not.
 */
export function fleetLevelNeedsYouEntries(
  entries: ReadonlyArray<AdeNeedsYouEntry> | undefined,
): ReadonlyArray<AdeNeedsYouEntry> {
  return (entries ?? []).filter((entry) => entry.botId === null && entry.item.status === "open");
}

/**
 * The Attention view. A row qualifies on its server-decided attention line, not
 * on its unread count: unread is "you have not looked", attention is "something
 * is waiting on a decision", and folding the two would bury one approval under
 * nine chatty bots — which is the exact failure the needs-you inbox existed to
 * prevent, and which this filter is inheriting the job of preventing.
 */
export function applyContactRailFilter(
  rows: ReadonlyArray<ContactRowView>,
  filter: ContactRailFilter,
): ReadonlyArray<ContactRowView> {
  return filter === "attention" ? rows.filter((row) => row.attentionLine !== null) : rows;
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .trim()
    .toLocaleLowerCase();
}

/**
 * Bucket rows into rendered sections, preserving the server's order inside each
 * one — the roster is already Firstmate-first, so nothing here re-sorts.
 *
 * Group headers come out in the captain's order; "Ungrouped" always trails,
 * because it is where a bot lands by *not* being filed rather than by being
 * filed last. Sections with no rows are dropped: while a search is running,
 * printing a header over nothing describes the group rather than the results.
 * A bot whose `groupId` names a group the roster does not carry falls to
 * Ungrouped rather than vanishing — the rail is where a captain would notice a
 * bot is missing, so it must never be the thing that hides one.
 */
export function getContactGroupSections(
  rows: ReadonlyArray<ContactRowView>,
  groups: ReadonlyArray<AdeBotGroup> = [],
): ReadonlyArray<ContactGroupSectionView> {
  if (rows.length === 0) {
    return [];
  }
  const known = new Set(groups.map((group) => group.id));
  const sections = groups.map((group) => ({
    groupId: group.id as string,
    name: group.name,
    rows: rows.filter((row) => row.groupId === group.id),
  }));
  const ungrouped = rows.filter((row) => row.groupId === null || !known.has(row.groupId));
  if (ungrouped.length > 0) {
    sections.push({
      groupId: UNGROUPED_SECTION_ID,
      name: UNGROUPED_SECTION_NAME,
      rows: ungrouped,
    });
  }
  return sections.filter((section) => section.rows.length > 0);
}

/**
 * Whether to show the #141 first-run CTA. Only once the roster has actually
 * answered: telling a captain to create a project they already have is the one
 * wrong thing an empty state can say.
 */
export function rosterNeedsFirstProject(roster: AdeRoster | null): boolean {
  return roster !== null && roster.projects.length === 0;
}

/**
 * Whether the rail itself has to carry the first-project CTA (#141).
 *
 * Normally the CTA lives in the conversation region via `CaptainIndexPane`.
 * Below 900px that region does not exist at the index route, so the rail is the
 * only surface left and the CTA moves into it — otherwise a captain on a phone
 * is told to pick a bot they cannot usefully create. A 64px icon strip has no
 * room for a form, but the icon strip only exists at ≥900px, where the
 * conversation region is showing the CTA anyway.
 */
export function shouldShowFirstProjectCtaInRail(input: {
  readonly needsFirstProject: boolean;
  readonly showCenter: boolean;
  readonly railCollapsed: boolean;
}): boolean {
  return input.needsFirstProject && !input.showCenter && !input.railCollapsed;
}

export function templateOptionLabel(template: AdeBotTemplateSummary): string {
  return template.defaultName === template.roleTag
    ? template.defaultName
    : `${template.defaultName} · ${template.roleTag}`;
}

/**
 * What the rail says when it has nothing to list. A search that matched nothing
 * is a different answer from a fleet with no bots, and saying "No bots yet" to
 * a captain with nine bots and a typo is the wrong one.
 */
export function contactRailEmptyCopy(input: {
  readonly totalRows: number;
  readonly query: string;
  readonly filter?: ContactRailFilter;
}): { readonly title: string; readonly description: string } {
  // An empty Attention view is the good outcome, and the one the retired
  // needs-you inbox used to report. It must never read as "no bots".
  if (input.filter === "attention" && normalizeSearchText(input.query).length === 0) {
    // #217: states the state rather than narrating the transient absence of
    // one. "No bot is waiting on a decision right now" restated the title and
    // hedged it; every consumer renders this description, so it stays a
    // sentence rather than becoming empty.
    return { title: "Nothing needs you", description: "Every decision is answered." };
  }
  if (input.totalRows > 0) {
    return {
      title: "No matches",
      description: `No bot matches “${input.query.trim()}”.`,
    };
  }
  return { title: "No bots yet", description: "Add a bot from a template." };
}
