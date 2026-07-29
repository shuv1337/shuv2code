import { ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { CodeAppearanceSection } from "./appearance/sections/CodeAppearanceSection";
import { ColorSchemeSection } from "./appearance/sections/ColorSchemeSection";
import { TerminalAppearanceSection } from "./appearance/sections/TerminalAppearanceSection";
import { TextAppearanceSection } from "./appearance/sections/TextAppearanceSection";

export function SettingsAppearanceRouteScreen() {
  const insets = useSafeAreaInsets();

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 18) + 18,
        }}
      >
        <ColorSchemeSection />
        <TextAppearanceSection />
        <TerminalAppearanceSection />
        <CodeAppearanceSection />
      </ScrollView>
    </View>
  );
}
