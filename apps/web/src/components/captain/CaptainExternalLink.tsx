import type { ReactNode } from "react";

import { readLocalApi } from "../../localApi";
import { writeTextToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import {
  resolveExternalWebLinkHost,
  showExternalLinkContextMenu,
} from "../chat/externalLinkContextMenu";

/**
 * An outbound link on a captain card, with the app's link context menu attached
 * (MESSENGER-PIVOT §6 M5 — "View PR / Open-in via `externalLinkContextMenu`").
 *
 * A card's PR link is the one place in the messenger where the captain leaves
 * for the outside world, and the app already has an answer for what a link
 * should do on right-click — open in the system browser, or copy the link.
 * `ProjectViewPage` renders its stack URL as a bare anchor and so has neither;
 * that gap is what this exists to not repeat.
 *
 * **Open-in-integrated-browser is deliberately absent.** That item needs a
 * thread to open beside and the preview plumbing `ChatMarkdown` carries;
 * `externalLinkContextMenuItems` already drops it when `canOpenInPreview` is
 * false, which is the supported way to offer the two answers that hold anywhere
 * rather than dropping the whole menu because one item cannot be honoured.
 *
 * Non-http(s) hrefs render as plain text. An artifact's `url` is free-form
 * (`TrimmedNonEmptyString`), so a bot can report something that is not a web
 * link, and turning that into an anchor would offer a click that goes nowhere.
 */
export function CaptainExternalLink({
  href,
  children,
  className,
  title,
  ariaLabel,
}: {
  readonly href: string;
  readonly children: ReactNode;
  readonly className?: string;
  readonly title?: string;
  readonly ariaLabel?: string;
}) {
  const host = resolveExternalWebLinkHost(href);
  if (host === null) {
    return (
      <span className={className} title={title}>
        {children}
      </span>
    );
  }

  return (
    <a
      aria-label={ariaLabel}
      className={cn("hover:underline", className)}
      href={href}
      onContextMenu={(event) => {
        const api = readLocalApi();
        // No bridge means no context menu to show; letting the platform's own
        // menu through beats swallowing the gesture.
        if (api === undefined || api === null) return;
        event.preventDefault();
        event.stopPropagation();
        void showExternalLinkContextMenu({
          href,
          canOpenInPreview: false,
          position: { x: event.clientX, y: event.clientY },
          showContextMenu: (items, position) => api.contextMenu.show(items, position),
          openInPreview: () => Promise.resolve(),
          openExternal: (target) => api.shell.openExternal(target),
          copyLink: (target) => writeTextToClipboard(target, "link"),
          reportFailure: (operation, cause) => {
            console.error("[captain-card] link action failed", { operation, href }, cause);
          },
        });
      }}
      rel="noreferrer"
      target="_blank"
      title={title}
    >
      {children}
    </a>
  );
}
