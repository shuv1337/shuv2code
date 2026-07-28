import { View } from "react-native";

import { Shuv2CodeHeaderButton } from "../../native/Shuv2CodeHeaderButton.android";
import type { SidebarHeaderActionsProps } from "./sidebar-header-actions";

export function SidebarHeaderActions(props: SidebarHeaderActionsProps) {
  return (
    <View className="h-11 flex-row gap-1">
      <Shuv2CodeHeaderButton
        accessibilityLabel="Open settings"
        icon="gearshape"
        onPress={props.onOpenSettings}
      />
    </View>
  );
}
