import type { UsageProviderKind } from "@shuv2code/contracts";
import { useColorScheme } from "react-native";

/**
 * Series and table order. The chart stacks providers from the bottom in this
 * order, so it also fixes which band sits on top of the bars.
 */
export const PROVIDER_ORDER: readonly UsageProviderKind[] = ["codex"];

export const PROVIDER_LABEL: Record<UsageProviderKind, string> = {
  codex: "Codex",
};

/**
 * Codex is neutral and must flip with the theme or its bars vanish against
 * the matching background.
 */
export function useProviderColors(): Record<UsageProviderKind, string> {
  const scheme = useColorScheme();
  return {
    codex: scheme === "dark" ? "#e6e6e6" : "#3c3c43",
  };
}
