import { ExternalLinkIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "../../lib/utils";
import { MessageCopyButton } from "../chat/MessageCopyButton";
import { CaptainExternalLink } from "./CaptainExternalLink";

/**
 * The hover affordance a card carries (MESSENGER-PIVOT §6 M5).
 *
 * `MessageBubble` already does this for one action — a copy button that fades
 * in on `group-hover/bubble`. Cards need the same gesture with more than one
 * action, so the pattern is lifted into a component instead of copied into
 * three: one hover group name, one set of geometry, one keyboard story.
 *
 * ## Why it is not focus-hostile
 * Hover-only actions are unreachable by keyboard, so the strip is revealed by
 * `focus-within` as well as `group-hover`. Tabbing into a card shows its
 * actions; the mouse never has to be the way in.
 *
 * ## Scope
 * Copy and open are here because both have somewhere real to go: the clipboard,
 * and `CaptainExternalLink`'s open/copy-link/open-in-preview menu. A reaction
 * affordance is deliberately **not** here — ADE has no durable store for a
 * reaction on a card (no table, no contract field, no RPC), and a control that
 * animates and forgets is worse than no control. `extra` is the seam for one:
 * whoever lands the store passes the button through it, and no geometry moves.
 */
export function ArtifactHoverActions({
  copyText,
  copyLabel = "Copy",
  openHref,
  openLabel = "Open",
  extra,
  className,
}: {
  /** Copied verbatim; absent hides the copy control. */
  readonly copyText?: string | undefined;
  readonly copyLabel?: string;
  /** External destination; absent hides the open control. */
  readonly openHref?: string | undefined;
  readonly openLabel?: string;
  readonly extra?: ReactNode;
  readonly className?: string;
}) {
  const hasCopy = copyText !== undefined && copyText.length > 0;
  const hasOpen = openHref !== undefined && openHref.length > 0;
  if (!hasCopy && !hasOpen && extra === undefined) return null;

  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity",
        "group-hover/artifact:opacity-100 group-focus-within/artifact:opacity-100",
        className,
      )}
      data-artifact-actions
    >
      {extra}
      {hasOpen ? (
        <CaptainExternalLink
          ariaLabel={openLabel}
          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground hover:no-underline"
          href={openHref}
          title={openLabel}
        >
          <ExternalLinkIcon aria-hidden className="size-3.5" />
        </CaptainExternalLink>
      ) : null}
      {hasCopy ? (
        <MessageCopyButton
          key={copyLabel}
          size="icon-xs"
          text={copyText as string}
          variant="ghost"
        />
      ) : null}
    </div>
  );
}

/**
 * The class a card's root needs for {@link ArtifactHoverActions} to reveal.
 *
 * Exported as a constant rather than documented in prose because Tailwind's
 * scanner only sees literals, and a card that forgets it renders a strip that
 * never appears.
 */
export const ARTIFACT_HOVER_GROUP_CLASS = "group/artifact";
