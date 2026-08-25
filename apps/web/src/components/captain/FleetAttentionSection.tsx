/**
 * Open Needs You items that name no bot (`docs/ade/MESSENGER-PIVOT.md` §5.4,
 * ticket M3 / #196).
 *
 * The rail lists contacts, and a contact row can only carry an item that has a
 * bot to sit under. Two kinds do not: a `kernel-down` names an engine, and a
 * bounced change whose author bot is gone names only an integration candidate
 * (`adeNeedsYou.ts`'s "unroutable repair"). Both are counted by the sidebar
 * badge.
 *
 * With the standalone inbox retired, that left the badge pointing at a view
 * that could not show what it was counting: a "1" on the sidebar and "Nothing
 * needs you" underneath it. Worse, the unroutable repair is one of exactly two
 * items **nothing will ever clear on its own** — the captain is the only thing
 * that retires it — so an unreachable one counts forever.
 *
 * So the Attention view opens with these, above the contacts, rendered through
 * the same `NeedsYouCard` the inbox used. The badge target is a superset of the
 * badge again, which is the property that makes the count trustworthy.
 */
import type { AdeNeedsYouEntry } from "@shuv2code/contracts";
import { AlertTriangleIcon } from "lucide-react";

import { NeedsYouCard } from "../fleet/NeedsYouCard";

/**
 * Presentational: the rail owns the read, because it also has to know whether
 * these exist before deciding the view is empty. "Nothing needs you" printed
 * above an unroutable repair would be the same lie in a new place.
 */
export function FleetAttentionSection({
  entries,
}: {
  readonly entries: ReadonlyArray<AdeNeedsYouEntry>;
}) {
  if (entries.length === 0) {
    return null;
  }

  return (
    <section aria-label="Fleet-wide" className="flex flex-col gap-1 pb-1">
      <h3 className="flex items-center gap-1.5 px-2 py-1 text-xs font-medium text-sidebar-muted-foreground">
        <AlertTriangleIcon aria-hidden className="size-3.5 text-amber-500" />
        Fleet-wide
      </h3>
      {entries.map((entry) => (
        // `variant="inline"` rather than `inbox`: the rail is 380px and the
        // inbox chrome assumes a page. The decision path is identical — one
        // durable item, one `ade.submitNeedsYouDecision`, so acknowledging here
        // retires it everywhere.
        <NeedsYouCard entry={entry} key={entry.item.id} variant="inline" />
      ))}
    </section>
  );
}
