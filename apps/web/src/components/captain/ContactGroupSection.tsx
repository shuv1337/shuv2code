import type { BotId } from "@shuv2code/contracts";

import { ContactRow } from "./ContactRow";
import type { ContactGroupSectionView } from "./contactRail.logic";

/**
 * One group of contacts. Until M2 (#197) ships captain-defined groups there is
 * exactly one of these — the implicit trailing "Ungrouped" — and its header is
 * suppressed, because a single header named "Ungrouped" over the entire fleet
 * is a label that tells the captain nothing.
 *
 * When the rail is an icon strip the header degrades to a divider (§2).
 */
export function ContactGroupSection({
  section,
  activeBotId,
  collapsed,
  showHeader,
  showDivider,
}: {
  readonly section: ContactGroupSectionView;
  readonly activeBotId: BotId | null;
  readonly collapsed: boolean;
  readonly showHeader: boolean;
  readonly showDivider: boolean;
}) {
  return (
    <section aria-label={section.name} className="flex flex-col gap-0.5">
      {showHeader ? (
        <h3 className="px-2 pt-2 pb-1 text-xs font-medium text-sidebar-muted-foreground">
          {section.name}
        </h3>
      ) : showDivider ? (
        <hr aria-hidden className="mx-2 my-1 border-sidebar-border" />
      ) : null}
      <ul className="flex flex-col gap-0.5">
        {section.rows.map((row) => (
          <ContactRow
            collapsed={collapsed}
            isActive={row.botId === activeBotId}
            key={row.botId}
            row={row}
          />
        ))}
      </ul>
    </section>
  );
}
