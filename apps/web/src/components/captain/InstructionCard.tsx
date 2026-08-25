import type { ScopedThreadRef } from "@shuv2code/contracts";
import { CheckIcon, ListChecksIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { ARTIFACT_HOVER_GROUP_CLASS, ArtifactHoverActions } from "./ArtifactHoverActions";
import type { InstructionCardView } from "./richCards.logic";

/**
 * The instruction card (MESSENGER-PIVOT §3, §6 M5): a bot-authored task list,
 * rendered as a checklist the captain can read at a glance instead of as a
 * paragraph of markdown bullets.
 *
 * ## Over `ChatMarkdown`, not instead of it
 * Every item body still goes through `ChatMarkdown`. That is the whole point of
 * the "over" in the spec line: a checklist item is usually mostly code — a path,
 * a command, a symbol — and `ChatMarkdown` is what already turns those into file
 * chips, skill chips, and highlighted spans. Re-rendering item text by hand
 * would produce a checklist whose code looked nothing like the code in the
 * bubble above it.
 *
 * The card adds one thing on top: the code inside an item is given the card's
 * own emphasis, so scanning the list reads as "these are the things being
 * touched" rather than as prose with incidental backticks.
 *
 * ## Why the checkboxes are not inputs
 * They are `aria-hidden` glyphs beside `role="listitem"` text, not checkboxes.
 * The list is a *report* of what the bot believes it has done; there is nothing
 * to write it back to, and a checkbox the captain can tick that forgets on the
 * next render is a worse lie than a static mark.
 */
export function InstructionCard({
  view,
  copyText,
  markdownCwd,
  threadRef,
  className,
}: {
  readonly view: InstructionCardView;
  /** The message exactly as sent, for the copy action. */
  readonly copyText: string;
  readonly markdownCwd: string | undefined;
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly className?: string;
}) {
  const total = view.items.length;
  return (
    <div className="flex w-full justify-start py-1">
      <article
        className={cn(
          ARTIFACT_HOVER_GROUP_CLASS,
          "min-w-0 max-w-[min(90%,38rem)] rounded-2xl rounded-bl-md border border-border/60 bg-muted/30",
          className,
        )}
        data-instruction-item-count={total}
      >
        <header className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
          <ListChecksIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <h3 className="min-w-0 flex-1 truncate text-sm font-medium">
            {view.title ?? "Task list"}
          </h3>
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {view.completedCount} of {total}
          </span>
          <ArtifactHoverActions copyLabel="Copy list" copyText={copyText} />
        </header>

        {view.leadMarkdown.length === 0 ? null : (
          <div className="px-3 pb-1 text-[15px]/[1.5]">
            <ChatMarkdown
              className="min-w-0 break-words"
              cwd={markdownCwd}
              lineBreaks
              text={view.leadMarkdown}
              threadRef={threadRef}
            />
          </div>
        )}

        <ul className="flex flex-col gap-0.5 px-3 pb-2">
          {view.items.map((item, index) => (
            <li
              className={cn(
                "flex min-w-0 items-start gap-2 text-[15px]/[1.5]",
                item.depth === 1 && "pl-4",
                item.depth === 2 && "pl-8",
              )}
              // Item bodies repeat across a list ("Run the tests" twice is a
              // real plan), so position is the only stable key here.
              key={`${index}:${item.markdown}`}
            >
              <span
                aria-hidden
                className={cn(
                  "mt-[0.3rem] flex size-3.5 shrink-0 items-center justify-center rounded-[4px] border",
                  item.checked
                    ? "border-transparent bg-primary text-primary-foreground"
                    : "border-border",
                )}
              >
                {item.checked ? <CheckIcon className="size-2.5" /> : null}
              </span>
              <div
                className={cn(
                  "min-w-0 flex-1",
                  // The card's own emphasis on code, so a checklist scans as
                  // the things being touched.
                  "[&_code]:rounded-[4px] [&_code]:bg-primary/10 [&_code]:px-1 [&_code]:py-px [&_code]:font-mono [&_code]:text-[0.9em]",
                  item.checked && "text-muted-foreground line-through decoration-border",
                )}
              >
                <ChatMarkdown
                  className="min-w-0 break-words"
                  cwd={markdownCwd}
                  lineBreaks
                  text={item.markdown}
                  threadRef={threadRef}
                />
                <span className="sr-only">{item.checked ? " (done)" : " (not done)"}</span>
              </div>
            </li>
          ))}
        </ul>

        {view.trailingMarkdown.length === 0 ? null : (
          <div className="border-t border-border/60 px-3 py-2 text-[15px]/[1.5]">
            <ChatMarkdown
              className="min-w-0 break-words"
              cwd={markdownCwd}
              lineBreaks
              text={view.trailingMarkdown}
              threadRef={threadRef}
            />
          </div>
        )}
      </article>
    </div>
  );
}
