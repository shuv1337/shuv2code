import { cn } from "../../lib/utils";
import type { BotAvatarView } from "./contactRail.logic";

const SIZE_CLASS = {
  sm: "size-6 text-[11px]",
  md: "size-9 text-sm",
  lg: "size-11 text-base",
} as const;

export type BotAvatarSize = keyof typeof SIZE_CLASS;

/**
 * The bot's blob (§3). A captain-chosen emoji and colour win when
 * `BotDisplayMeta` carries them; otherwise the blob is initials on a hue
 * derived from the bot id, so an unstyled fleet is still visually
 * distinguishable and a bot keeps the same colour on every surface it appears
 * on — rail, conversation header, attribution line, needs-you card.
 *
 * `aria-hidden`: the row, header, or card always prints the bot's name beside
 * this, so announcing the blob would read the name twice.
 */
export function BotAvatar({
  avatar,
  className,
  size = "md",
}: {
  readonly avatar: BotAvatarView;
  readonly className?: string;
  readonly size?: BotAvatarSize;
}) {
  const background = avatar.color ?? `hsl(${avatar.hue} 62% 42%)`;
  return (
    <span
      aria-hidden
      className={cn(
        "flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white",
        SIZE_CLASS[size],
        className,
      )}
      style={{ backgroundColor: background }}
    >
      {avatar.emoji ?? avatar.initials}
    </span>
  );
}
