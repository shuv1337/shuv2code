import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import type {
  ParsedAssignmentDelivery,
  ParsedAssignmentDeliveryItem,
} from "./assignmentResult.logic";

const STATUS_VARIANT: Record<
  ParsedAssignmentDeliveryItem["status"],
  "success" | "error" | "warning"
> = {
  completed: "success",
  failed: "error",
  cancelled: "warning",
};

/**
 * Renders one delivered assignment result (spec §13.5). The engine hands the
 * bot a fenced markdown blob as synthetic user input; this reads it back as
 * the structured record it always was.
 */
export function AssignmentResultCard({
  delivery,
  className,
  variant = "default",
}: {
  readonly delivery: ParsedAssignmentDelivery;
  readonly className?: string;
  /**
   * `nested` drops the per-assignment border (MESSENGER-PIVOT §3). The captain
   * messenger already draws a container — an attribution fold or a bubble — and
   * a second border inside it reads as a box in a box.
   */
  readonly variant?: "default" | "nested";
}) {
  const nested = variant === "nested";
  return (
    <div className={cn("flex flex-col gap-2", className)} data-assignment-variant={variant}>
      <p className="text-xs text-muted-foreground">
        {delivery.assignments.length === 1
          ? "An assignment you delegated has finished."
          : `${delivery.assignments.length} assignments you delegated have finished.`}
        {delivery.parentAssignmentId === null
          ? null
          : ` These complete the children of ${delivery.parentAssignmentId}.`}
      </p>
      {delivery.assignments.map((item) => (
        <div
          key={item.assignmentId}
          className={cn(
            "flex flex-col gap-2",
            nested ? "px-0.5 py-1" : "rounded-lg border border-border bg-card px-3 py-2.5",
          )}
        >
          <div className="flex flex-wrap items-center gap-2">
            <Badge size="sm" variant={STATUS_VARIANT[item.status]}>
              {item.status}
            </Badge>
            <span className="truncate font-mono text-xs text-muted-foreground">
              {item.assignmentId}
            </span>
            <span className="truncate text-xs text-muted-foreground">
              bot {item.recipientBotId}
            </span>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-muted-foreground">Instruction</span>
            <p className="whitespace-pre-wrap text-sm text-foreground/90">{item.instruction}</p>
          </div>
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-medium text-muted-foreground">Summary</span>
            <p className="whitespace-pre-wrap text-sm">{item.summary}</p>
          </div>
          {item.artifacts.length === 0 ? null : (
            <div className="flex flex-col gap-0.5">
              <span className="text-xs font-medium text-muted-foreground">Artifacts</span>
              <ul className="flex flex-col gap-0.5">
                {item.artifacts.map((artifact) => (
                  <li key={artifact} className="truncate font-mono text-xs text-muted-foreground">
                    {artifact}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
