import { ArrowDownIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";

/**
 * The floating jump-to-latest control (MESSENGER-PIVOT §2). It exists only when
 * the captain has scrolled away from the end, so it never covers the newest
 * message it is offering to reveal.
 */
export function JumpToLatestPill({
  visible,
  unreadCount = 0,
  onJump,
  className,
}: {
  readonly visible: boolean;
  readonly unreadCount?: number;
  readonly onJump: () => void;
  readonly className?: string;
}) {
  if (!visible) {
    return null;
  }
  return (
    <div
      className={cn(
        "pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-center",
        className,
      )}
    >
      <Button
        className="pointer-events-auto gap-1.5 rounded-full shadow-md"
        onClick={onJump}
        size="sm"
        variant="secondary"
      >
        <ArrowDownIcon aria-hidden className="size-3.5" />
        {unreadCount > 0 ? `${unreadCount} new` : "Jump to latest"}
      </Button>
    </div>
  );
}
