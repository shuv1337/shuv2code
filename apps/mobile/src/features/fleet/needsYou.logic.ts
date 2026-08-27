/**
 * Mobile-shaped view logic for the Needs You inbox (spec §7 slice 5).
 *
 * Everything about *deciding* an item — which control it offers, whether this
 * client may press it, what the captain reads afterwards — is
 * `@shuv2code/client-runtime/ade/needs-you`, shared with the web inbox. What is
 * left here is what a phone does differently: web puts a list beside a detail
 * pane and opens on the first actionable entry (`selectNeedsYouEntry`), which a
 * 390pt screen has no room for. The phone shows one flat list where the card
 * *is* the detail, so the ordering that pane-selection encoded has to be
 * re-expressed as section order instead.
 */
import type { AdeNeedsYouEntry } from "@shuv2code/contracts";

/**
 * The mobile remedy for a phone with no `ade:approve`.
 *
 * Web's default sentence tells the captain to open the app from the server's
 * startup link. A paired phone cannot: it has no browser session on that
 * origin, and the scope it holds was fixed when it paired. So the phone names
 * the thing that *is* true — the item is still there, and the machine that can
 * decide it can. Nothing is hidden: the item, its title and its detail all
 * still render, because a captain away from their desk still needs to know
 * what is waiting even when they cannot clear it.
 */
export const MOBILE_APPROVE_UNAVAILABLE_REASON =
  "This phone is not paired with approval authority. Decide this from your captain machine.";

export type NeedsYouSectionId = "waiting" | "watching" | "resolved";

export type NeedsYouListItem =
  | { readonly kind: "section"; readonly key: string; readonly title: string }
  | { readonly kind: "entry"; readonly key: string; readonly entry: AdeNeedsYouEntry };

const SECTION_TITLES: Record<NeedsYouSectionId, string> = {
  waiting: "Waiting on you",
  watching: "Watching",
  resolved: "Recently resolved",
};

/**
 * The inbox as one flat `LegendList` of keyed rows.
 *
 * Three buckets in a fixed order, and the order is the whole argument for this
 * function existing:
 *
 * 1. **Waiting on you** — open and actionable. These are the reason the badge
 *    is lit; anything else above them is something between the captain and the
 *    thing they came to do.
 * 2. **Watching** — open, but nothing to press. They clear when their condition
 *    does (a kernel coming back, a stall resolving), so they are context, not
 *    work. Web never had to rank these against the actionable ones because its
 *    detail pane simply opened on the first actionable entry.
 * 3. **Recently resolved** — history, present only when the caller asked for
 *    it.
 *
 * Within a bucket the server's order is kept: it sends newest-relevant first,
 * and a client re-sort would be a second opinion about priority that no other
 * surface shares.
 *
 * Empty sections emit no header, so an inbox with only actionable work does not
 * carry two labels explaining what is absent.
 */
export function buildNeedsYouListItems(
  entries: ReadonlyArray<AdeNeedsYouEntry>,
): ReadonlyArray<NeedsYouListItem> {
  const buckets: ReadonlyArray<readonly [NeedsYouSectionId, ReadonlyArray<AdeNeedsYouEntry>]> = [
    ["waiting", entries.filter((entry) => entry.item.status === "open" && entry.actionable)],
    ["watching", entries.filter((entry) => entry.item.status === "open" && !entry.actionable)],
    ["resolved", entries.filter((entry) => entry.item.status !== "open")],
  ];
  const items: Array<NeedsYouListItem> = [];
  for (const [section, sectionEntries] of buckets) {
    if (sectionEntries.length === 0) continue;
    items.push({ kind: "section", key: `section:${section}`, title: SECTION_TITLES[section] });
    for (const entry of sectionEntries) {
      items.push({ kind: "entry", key: `item:${entry.item.id}`, entry });
    }
  }
  return items;
}

/** How many of the open items the captain can actually act on right now. */
export function countActionableEntries(entries: ReadonlyArray<AdeNeedsYouEntry>): number {
  return entries.filter((entry) => entry.item.status === "open" && entry.actionable).length;
}

export interface NeedsYouEmptyCopy {
  readonly title: string;
  readonly detail: string;
}

/**
 * The empty state, which has to distinguish two different nothings.
 *
 * "Nothing is waiting" is good news and should read as such. "Nothing is
 * waiting *and* nothing has been resolved lately" is the same good news with
 * the history view on, and saying "no resolved items" there would report the
 * absence of history as though it were the point.
 */
export function needsYouEmptyCopy(includeResolved: boolean): NeedsYouEmptyCopy {
  return includeResolved
    ? {
        title: "Nothing here yet",
        detail: "Nothing is waiting on you, and nothing has been resolved recently.",
      }
    : {
        title: "Nothing needs you",
        detail: "The fleet is running without you. Anything that needs a decision lands here.",
      };
}

/** The label on the history toggle, which says what pressing it will show. */
export function needsYouHistoryToggleLabel(includeResolved: boolean): string {
  return includeResolved ? "Hide resolved" : "Show resolved";
}
