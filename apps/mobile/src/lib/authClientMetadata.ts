import type { AuthClientPresentationMetadata } from "@shuv2code/contracts";
import { Platform } from "react-native";

export function authClientMetadata(): AuthClientPresentationMetadata {
  return {
    label: "shuv2code Mobile",
    deviceType: "mobile",
    ...(Platform.OS === "ios" ? { os: "iOS" } : Platform.OS === "android" ? { os: "Android" } : {}),
  };
}
