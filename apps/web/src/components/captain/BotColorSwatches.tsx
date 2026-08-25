/**
 * The bot avatar color picker (`docs/ade/MESSENGER-PIVOT.md` §3, M2 / #197).
 *
 * A controlled picker rather than `components/color-selector`, for two
 * reasons that both showed up as defects:
 *
 * - That component resolves tokens through a **module-private** map, so every
 *   other surface that paints a bot would have had to re-derive the mapping or
 *   apply the raw token as a CSS color — which renders `emerald`, `fuchsia`
 *   and `lime` invisible and the rest as untuned CSS named colors. The
 *   resolver now lives in `botIdentity.logic.ts` and every painter shares it.
 * - It holds the selection in its own `useState`, seeded once from
 *   `defaultValue`, so the selected ring goes stale the moment the sheet
 *   re-seeds from the server. Here the selection is a prop.
 *
 * A "None" swatch is first: a color the captain set has to be removable, and
 * without it the only way back to the deterministic id-derived hue would be to
 * never have picked one.
 */
import { CheckIcon, SlashIcon } from "lucide-react";

import { cn } from "../../lib/utils";
import { BOT_AVATAR_COLORS, resolveBotAvatarColor } from "./botIdentity.logic";

export function BotColorSwatches({
  value,
  onChange,
}: {
  /** Empty string means no color — the avatar falls back to its id-derived hue. */
  readonly value: string;
  readonly onChange: (next: string) => void;
}) {
  return (
    <div aria-label="Bot color" className="flex flex-wrap gap-2" role="radiogroup">
      <button
        aria-checked={value === ""}
        aria-label="No color"
        className={cn(
          "flex size-5 items-center justify-center rounded-full border border-border text-muted-foreground transition-transform duration-200 active:scale-90",
          value === "" && "ring-2 ring-foreground ring-offset-2 ring-offset-card",
        )}
        role="radio"
        type="button"
        onClick={() => onChange("")}
      >
        <SlashIcon className="size-3" />
      </button>
      {BOT_AVATAR_COLORS.map((token) => {
        const selected = value === token;
        return (
          <button
            key={token}
            aria-checked={selected}
            aria-label={`${token} color`}
            className={cn(
              "flex size-5 items-center justify-center rounded-full transition-transform duration-200 active:scale-90",
              selected && "ring-2 ring-offset-2 ring-offset-card",
            )}
            role="radio"
            style={{
              backgroundColor: resolveBotAvatarColor(token) ?? undefined,
              ...(selected ? { ["--tw-ring-color" as string]: resolveBotAvatarColor(token) } : {}),
            }}
            type="button"
            onClick={() => onChange(token)}
          >
            {selected ? <CheckIcon className="size-3 text-white" /> : null}
          </button>
        );
      })}
    </div>
  );
}
