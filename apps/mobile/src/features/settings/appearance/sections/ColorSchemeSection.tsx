import { Pressable, View } from "react-native";

import { SymbolView } from "../../../../components/AppSymbol";
import { AppText as Text } from "../../../../components/AppText";
import { useThemeColor } from "../../../../lib/useThemeColor";
import { SettingsSection } from "../../components/SettingsSection";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";

const OPTIONS = [
  { value: "dark", label: "Dark" },
  { value: "light", label: "Light" },
  { value: "system", label: "System" },
] as const;

export function ColorSchemeSection() {
  const { colorScheme, isReady, setColorScheme } = useAppearancePreferences();
  const accent = useThemeColor("--color-primary");

  return (
    <SettingsSection card title="Theme">
      {OPTIONS.map((option) => {
        const selected = colorScheme === option.value;
        return (
          <Pressable
            accessibilityRole="radio"
            accessibilityState={{ checked: selected, disabled: !isReady }}
            disabled={!isReady}
            key={option.value}
            onPress={() => setColorScheme(option.value)}
          >
            <View className="flex-row items-center gap-3 border-b border-border-subtle px-4 py-3 last:border-b-0">
              <Text className="flex-1 text-lg text-foreground">{option.label}</Text>
              {selected ? (
                <SymbolView
                  name="checkmark.circle.fill"
                  size={20}
                  tintColor={accent}
                  type="monochrome"
                  weight="semibold"
                />
              ) : null}
            </View>
          </Pressable>
        );
      })}
    </SettingsSection>
  );
}
