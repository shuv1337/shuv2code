/**
 * Pure view mapping for the captain's contact rail (MESSENGER-PIVOT §3, M1).
 *
 * This absorbs `fleet/FleetRosterPage.logic.ts` wholesale — the server owns the
 * order (Firstmate, then the other coordinators, then crew), so nothing here
 * re-sorts; it only decides what each row says — and adds the rail's own
 * concerns: the avatar model, search, and group bucketing.
 *
 * Groups are an M2 (#197) delivery. Until `Bot.groupId` exists in the contract
 * the bucketing is real but degenerate: every bot falls into the implicit
 * trailing "Ungrouped" section. Shipping the section shape now means M2 adds
 * captain-defined headers without re-cutting the rail.
 */
import type {
  AdeBotTemplateSummary,
  AdeRoster,
  AdeRosterEntry,
  BotDisplayMeta,
  BotId,
} from "@shuv2code/contracts";

import { structuralRoleLabel } from "../../state/ade.logic";

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
  /** The dim one-line under the name until M3 lands real message previews. */
  readonly secondaryLine: string;
  readonly avatar: BotAvatarView;
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

/** Ported from `FleetRosterPage.logic.ts`; the wording is unchanged. */
export function openAssignmentLabel(openAssignmentCount: number): string | null {
  if (openAssignmentCount <= 0) {
    return null;
  }
  return openAssignmentCount === 1
    ? "1 open assignment"
    : `${openAssignmentCount} open assignments`;
}

export function getContactRowView(entry: AdeRosterEntry): ContactRowView {
  const projectLabel = entry.projectName ?? "Fleet-wide";
  const assignments = openAssignmentLabel(entry.openAssignmentCount);
  return {
    botId: entry.bot.id,
    name: entry.bot.name,
    roleLabel: structuralRoleLabel(entry.bot.structuralRole),
    roleTag: entry.bot.roleTag,
    projectLabel,
    isFirstmate: entry.bot.structuralRole === "firstmate",
    openAssignmentLabel: assignments,
    chatLabel: entry.hasActivePrimarySession ? "Resume chat" : "Chat",
    secondaryLine: assignments === null ? projectLabel : `${projectLabel} · ${assignments}`,
    avatar: getBotAvatarView({
      botId: entry.bot.id,
      name: entry.bot.name,
      displayMeta: entry.bot.displayMeta,
    }),
  };
}

export function getContactRowViews(roster: AdeRoster | null): ReadonlyArray<ContactRowView> {
  return roster === null ? [] : roster.entries.map(getContactRowView);
}

/**
 * Rail search. Matches the bot's name and its role tag, case- and
 * accent-insensitively, so "coder" finds Coder whatever the captain renamed it
 * to. An all-whitespace query is not a filter — it returns the roster intact
 * rather than nothing.
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
      normalizeSearchText(row.roleTag).includes(needle),
  );
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
 * one. Until M2 there is exactly one section — the implicit "Ungrouped" — and
 * an empty roster produces no sections at all so the rail can show its own
 * empty state rather than an empty header.
 */
export function getContactGroupSections(
  rows: ReadonlyArray<ContactRowView>,
): ReadonlyArray<ContactGroupSectionView> {
  if (rows.length === 0) {
    return [];
  }
  return [{ groupId: UNGROUPED_SECTION_ID, name: UNGROUPED_SECTION_NAME, rows }];
}

/**
 * Whether to show the #141 first-run CTA. Only once the roster has actually
 * answered: telling a captain to create a project they already have is the one
 * wrong thing an empty state can say.
 */
export function rosterNeedsFirstProject(roster: AdeRoster | null): boolean {
  return roster !== null && roster.projects.length === 0;
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
}): { readonly title: string; readonly description: string } {
  if (input.totalRows > 0) {
    return {
      title: "No matches",
      description: `No bot matches “${input.query.trim()}”.`,
    };
  }
  return {
    title: "No bots yet",
    description: "Add one from a template to start building your crew.",
  };
}
