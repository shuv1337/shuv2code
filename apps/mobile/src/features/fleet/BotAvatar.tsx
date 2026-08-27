import type { BotAvatarView } from "@shuv2code/client-runtime/ade/contact-rail";
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { resolveBotAvatarTint } from "./fleet.logic";

/**
 * A bot's blob: the captain's emoji when they set one, otherwise initials on
 * the bot's colour. The colour resolution is `resolveBotAvatarTint`, which is
 * the only place a palette token becomes something React Native can paint.
 */
export function BotAvatar({
  avatar,
  size = 44,
}: {
  readonly avatar: BotAvatarView;
  readonly size?: number;
}) {
  const tint = resolveBotAvatarTint(avatar);
  return (
    <View
      className={cn("items-center justify-center", tint.className)}
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        ...(tint.color === null ? {} : { backgroundColor: tint.color }),
      }}
    >
      {avatar.emoji === null ? (
        <Text
          className="font-shuv2code-bold text-white"
          style={{ fontSize: Math.round(size * 0.36) }}
        >
          {avatar.initials}
        </Text>
      ) : (
        <Text style={{ fontSize: Math.round(size * 0.45) }}>{avatar.emoji}</Text>
      )}
    </View>
  );
}
