/**
 * Kernel health, in the two shapes a phone needs (spec §4.8, §7.8).
 *
 * `KernelHealthAlertStrip` is the interrupting one: it appears on the fleet
 * list only while something is actually down. `KernelHealthPills` is the
 * complete row, on a bot's profile, where a captain who already suspects
 * something has gone to look.
 *
 * Neither gates anything. The app is never blocked on kernel health (spec
 * §4.1) — a down kernel is something to read, not a wall.
 */
import { View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { type KernelHealthPillView } from "./kernelHealth.logic";

export function KernelHealthPills({
  pills,
}: {
  readonly pills: ReadonlyArray<KernelHealthPillView>;
}) {
  return (
    <View className="flex-row flex-wrap gap-2">
      {pills.map((pill) => (
        <View
          accessibilityLabel={pill.accessibilityLabel}
          accessibilityRole="text"
          className="flex-row items-center gap-1.5 rounded-full bg-card-alt px-3 py-1.5"
          key={pill.target}
        >
          <View className={cn("h-2 w-2 rounded-full", pill.dotClassName)} />
          <Text className="text-xs font-shuv2code-medium text-foreground-secondary">
            {pill.label}
          </Text>
          <Text className="text-xs text-foreground-tertiary">{pill.stateText}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * The one line the contact list shows when a kernel is out, and nothing at all
 * the rest of the time. `line` is null exactly when there is nothing to say, so
 * the caller renders this unconditionally and it disappears on its own.
 */
export function KernelHealthAlertStrip({
  line,
  detail,
}: {
  readonly line: string | null;
  readonly detail: string | null;
}) {
  if (line === null) return null;
  return (
    <View className="border-b border-border bg-danger px-5 py-2">
      <Text className="text-sm font-shuv2code-bold text-danger-foreground">{line}</Text>
      {detail === null ? null : (
        <Text className="mt-0.5 text-xs text-danger-foreground" numberOfLines={2}>
          {detail}
        </Text>
      )}
    </View>
  );
}
