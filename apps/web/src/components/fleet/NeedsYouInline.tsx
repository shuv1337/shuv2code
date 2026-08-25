import { useAdeNeedsYouList } from "../../state/ade";
import { NeedsYouCard } from "./NeedsYouCard";
import { entriesForSubject, type NeedsYouSubject } from "./NeedsYouInbox.logic";

/**
 * The second rendering (spec §7 slice 5): the same durable items, shown where
 * their subject is. A captain reading a bot's conversation should not have to
 * go to an inbox to learn that this bot is what is waiting on them — and
 * deciding here retires the same item the inbox lists, because both mount
 * {@link NeedsYouCard}.
 *
 * Renders nothing when nothing is waiting: this sits above other content, and
 * a permanent empty panel is worse than no panel.
 */
export function NeedsYouInline({
  subject,
  variant = "inline",
}: {
  readonly subject: NeedsYouSubject;
  /** `bubble` when the conversation is the captain messenger (M4). */
  readonly variant?: "inline" | "bubble";
}) {
  const list = useAdeNeedsYouList();
  const entries = entriesForSubject(list.data?.entries ?? [], subject);
  if (entries.length === 0) return null;

  return (
    <section
      aria-label="Needs you"
      className={variant === "bubble" ? "flex flex-col items-start gap-2" : "flex flex-col gap-2"}
    >
      {entries.map((entry) => (
        <NeedsYouCard entry={entry} key={entry.item.id} variant={variant} />
      ))}
    </section>
  );
}
