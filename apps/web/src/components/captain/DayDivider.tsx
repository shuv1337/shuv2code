import { cn } from "../../lib/utils";

/**
 * The messenger's date rule (MESSENGER-PIVOT §2). Today and yesterday get
 * words; anything older gets a date, with the year only once it stops being
 * obvious.
 */
export function formatDayDividerLabel(at: string, now: Date = new Date()): string {
  const day = new Date(at);
  if (Number.isNaN(day.getTime())) {
    return "";
  }
  const startOfDay = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const deltaDays = Math.round((startOfDay(now) - startOfDay(day)) / 86_400_000);
  if (deltaDays === 0) return "Today";
  if (deltaDays === 1) return "Yesterday";
  return day.toLocaleDateString(undefined, {
    weekday: deltaDays < 7 ? "long" : undefined,
    month: "short",
    day: "numeric",
    ...(day.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}

export function DayDivider({
  at,
  className,
}: {
  readonly at: string;
  readonly className?: string;
}) {
  const label = formatDayDividerLabel(at);
  if (label === "") {
    return null;
  }
  return (
    <div className={cn("flex items-center justify-center py-3", className)}>
      <span className="rounded-full bg-muted/60 px-2.5 py-0.5 text-[11px] font-medium text-muted-foreground">
        {label}
      </span>
    </div>
  );
}
