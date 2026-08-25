import { useAtomValue } from "@effect/atom-react";

import { cn } from "../../lib/utils";
import { primaryFleetHealthAtom } from "../../state/ade";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { getKernelHealthPillViews } from "./SidebarKernelHealthPills.logic";

/**
 * Kernel health pills (spec §4.8, UI slice 8): shuvcode / Codex / Screenbox
 * state. Purely informational — the app stays fully navigable while degraded.
 *
 * These live in the captain shell's contact-rail footer (MESSENGER-PIVOT §2),
 * and the rail has two widths. `compact` drops the labels and wraps the dots so
 * the 64px icon strip still shows kernel state rather than hiding it: a status
 * indicator that disappears when the window narrows is not a status indicator.
 * The tooltip carries the full text either way.
 */
export function SidebarKernelHealthPills({
  compact = false,
}: {
  readonly compact?: boolean;
} = {}) {
  const snapshot = useAtomValue(primaryFleetHealthAtom);
  const pills = getKernelHealthPillViews(snapshot);

  return (
    <div
      role="status"
      aria-label="Kernel health"
      className={cn(
        "flex text-xs text-sidebar-muted-foreground",
        compact
          ? "flex-wrap items-center justify-center gap-1.5 px-1 py-1"
          : "items-center gap-3 px-2 py-1",
      )}
    >
      {pills.map((pill) => (
        <span className={cn("flex min-w-0 items-center", !compact && "gap-1.5")} key={pill.target}>
          <ConnectionStatusDot
            dotClassName={pill.dotClassName}
            pingClassName={pill.pingClassName}
            tooltipText={pill.tooltip}
          />
          {compact ? null : <span className="truncate">{pill.label}</span>}
        </span>
      ))}
    </div>
  );
}
