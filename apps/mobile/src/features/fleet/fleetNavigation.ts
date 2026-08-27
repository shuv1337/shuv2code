/**
 * Typed navigation for the bot-mode routes.
 *
 * ## Why this exists
 *
 * `Stack.tsx` declares `interface RootNavigator extends RootStackType`, which
 * is supposed to give a bare `useNavigation()` real per-route param types. In
 * this version of the static API that inference bails out across the whole
 * app: `navigate("Thread", { environmentId, threadId })` in `HomeRouteScreen`
 * and `navigate("ThreadFile", …)` in `ThreadFilesRouteScreen` both collapse
 * their argument tuple to `never`, and a screen's own `StaticScreenProps`
 * params never reach `setParams`, which is typed `undefined`. Those are
 * pre-existing and app-wide, not something bot mode introduced.
 *
 * Rather than add more of them, the fleet routes navigate through the escape
 * hatch the repo already uses for its nested picker stacks
 * (`ThreadSettingsSheet` does the same with `ThreadSettingsPickerStackParams`):
 * a hand-written param list plus `useNavigation<NativeStackNavigationProp<…>>`.
 * That is strictly *more* type safety than the bare hook gives here — a typo in
 * a route name or a missing `botId` is a compile error — at the cost of one
 * table that has to agree with `Stack.tsx`.
 *
 * **Keep this in sync with the fleet screens registered in `Stack.tsx`.** When
 * the static inference is repaired app-wide, delete this file and go back to a
 * bare `useNavigation()`.
 */
import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";

export type FleetParamList = {
  readonly Fleet: undefined;
  readonly NeedsYou: undefined;
  readonly BotChat: {
    readonly environmentId: string;
    readonly botId: string;
    /** Written back by `BotChatRouteScreen` once the session names the thread. */
    readonly threadId?: string;
  };
  readonly BotProfile: { readonly environmentId: string; readonly botId: string };
  readonly BotIdentitySheet: { readonly environmentId: string; readonly botId: string };
  readonly BotModelSheet: { readonly environmentId: string; readonly botId: string };
};

export type FleetNavigation = NativeStackNavigationProp<FleetParamList>;

export function useFleetNavigation(): FleetNavigation {
  return useNavigation<FleetNavigation>();
}
