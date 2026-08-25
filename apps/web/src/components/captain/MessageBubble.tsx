import type { ScopedThreadRef, ServerProviderSkill } from "@shuv2code/contracts";

import { cn } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { MessageCopyButton } from "../chat/MessageCopyButton";
import type { ExpandedImagePreview } from "../chat/ExpandedImagePreview";
import { UserMessageFileList, UserMessageImageGrid } from "../chat/UserMessageAttachments";
import type { BotAvatarView } from "./contactRail.logic";
import { BotAvatar } from "./BotAvatar";
import type { BubbleGroupPosition, BubbleMessageDisplay } from "./bubbleTimeline.logic";

const EMPTY_BUBBLE_SKILLS: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> = [];

/**
 * Corner geometry for a run of bubbles: the outer corners of a run stay at the
 * messenger's 16px radius, the inner ones tighten so a run reads as one block
 * (MESSENGER-PIVOT §1).
 */
export function resolveBubbleRadiusClass(
  author: "captain" | "bot",
  position: BubbleGroupPosition,
): string {
  // Written out rather than composed: Tailwind's scanner only sees literals.
  if (position === "single") return "rounded-2xl";
  if (author === "captain") {
    if (position === "first") return "rounded-2xl rounded-br-md";
    if (position === "last") return "rounded-2xl rounded-tr-md";
    return "rounded-2xl rounded-tr-md rounded-br-md";
  }
  if (position === "first") return "rounded-2xl rounded-bl-md";
  if (position === "last") return "rounded-2xl rounded-tl-md";
  return "rounded-2xl rounded-tl-md rounded-bl-md";
}

/**
 * One captain or bot message (MESSENGER-PIVOT §1). ~90% of captain-visible
 * traffic renders through here; everything the bubble renderer cannot claim
 * losslessly goes to `TraceCard` instead, so this component is deliberately
 * narrow — message contents, no tool chrome.
 *
 * "Message contents" means what `resolveBubbleMessageDisplay` returns, not
 * `message.text`: attachments render above the line with the *same* grid and
 * file list the IDE row uses, and the text has already had its send-time
 * trailers stripped. A bubble that drew only the raw text showed an image-only
 * message as an empty box and leaked `<element_context>` markup into the
 * conversation.
 */
export function MessageBubble({
  author,
  display,
  createdAt,
  groupPosition,
  avatar,
  showAvatar,
  markdownCwd,
  threadRef,
  skills,
  onImageExpand,
  showCopyButton = false,
  streaming = false,
}: {
  readonly author: "captain" | "bot";
  readonly display: BubbleMessageDisplay;
  readonly createdAt: string;
  readonly groupPosition: BubbleGroupPosition;
  readonly avatar: BotAvatarView | null;
  readonly showAvatar: boolean;
  readonly markdownCwd: string | undefined;
  readonly threadRef?: ScopedThreadRef | undefined;
  readonly skills?: ReadonlyArray<Pick<ServerProviderSkill, "name" | "displayName">> | undefined;
  readonly onImageExpand: (preview: ExpandedImagePreview) => void;
  readonly showCopyButton?: boolean;
  readonly streaming?: boolean;
}) {
  const isCaptain = author === "captain";
  return (
    <div
      className={cn(
        "group/bubble flex w-full items-end gap-2",
        isCaptain ? "justify-end" : "justify-start",
        groupPosition === "first" || groupPosition === "single" ? "mt-2" : "mt-0.5",
      )}
      data-bubble-author={author}
      data-bubble-position={groupPosition}
      data-message-created-at={createdAt}
    >
      {isCaptain ? null : (
        <div aria-hidden className="w-7 shrink-0">
          {showAvatar && avatar !== null ? <BotAvatar avatar={avatar} size="sm" /> : null}
        </div>
      )}
      <div
        className={cn(
          "max-w-[min(78%,34rem)] min-w-0 px-3.5 py-2 text-[15px]/[1.5]",
          resolveBubbleRadiusClass(author, groupPosition),
          isCaptain
            ? "bg-primary text-primary-foreground"
            : "bg-muted text-foreground border border-border/60",
        )}
      >
        <UserMessageImageGrid images={display.images} onImageExpand={onImageExpand} />
        <UserMessageFileList files={display.files} />
        {display.text.trim().length === 0 ? null : (
          <ChatMarkdown
            className={cn(
              "min-w-0 break-words",
              isCaptain && "[&_a]:text-primary-foreground [&_a]:underline",
            )}
            cwd={markdownCwd}
            isStreaming={streaming}
            lineBreaks
            skills={skills ?? EMPTY_BUBBLE_SKILLS}
            text={display.text}
            threadRef={threadRef}
          />
        )}
      </div>
      {showCopyButton && !streaming ? (
        <MessageCopyButton
          className="opacity-0 transition-opacity group-hover/bubble:opacity-100"
          size="icon-xs"
          text={display.copyText}
          variant="ghost"
        />
      ) : null}
    </div>
  );
}
