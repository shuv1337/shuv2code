import { useAtomValue } from "@effect/atom-react";

import { primaryFleetHealthAtom } from "../../state/ade";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { getKernelHealthPillViews } from "./SidebarKernelHealthPills.logic";

/**
 * Kernel health pills (spec §4.8, UI slice 8): a compact always-visible row in
 * the sidebar footer showing shuvcode / Codex / Screenbox state. Purely
 * informational — the app stays fully navigable while degraded.
 */
export function SidebarKernelHealthPills() {
  const snapshot = useAtomValue(primaryFleetHealthAtom);
  const pills = getKernelHealthPillViews(snapshot);

  return (
    <div
      role="status"
      aria-label="Kernel health"
      className="flex items-center gap-3 px-2 py-1 text-xs text-sidebar-muted-foreground"
    >
      {pills.map((pill) => (
        <span key={pill.target} className="flex min-w-0 items-center gap-1.5">
          <ConnectionStatusDot
            tooltipText={pill.tooltip}
            dotClassName={pill.dotClassName}
            pingClassName={pill.pingClassName}
          />
          <span className="truncate">{pill.label}</span>
        </span>
      ))}
    </div>
  );
}
