import { useEffect, useState } from "react";

import { isElectron } from "../env";
import { isMacPlatform } from "../lib/utils";

/**
 * Whether the window is currently showing macOS traffic lights over the
 * top-left of the app, so whichever surface is leftmost has to leave room.
 *
 * False everywhere but a non-fullscreen frameless macOS desktop window: in the
 * browser there are no lights, and in fullscreen macOS hides them and gives the
 * corner back.
 *
 * Extracted from `AppSidebarLayout` rather than duplicated because #216 gave
 * the app a second frame — the captain surface, which has no app sidebar — and
 * two copies of this would drift the moment one of them learned something.
 */
export function useMacosTrafficLightsInset(): boolean {
  const isMacosDesktop = isElectron && isMacPlatform(navigator.platform);
  const [isWindowFullscreen, setIsWindowFullscreen] = useState(() => {
    const getWindowFullscreenState = window.desktopBridge?.getWindowFullscreenState;
    return isMacosDesktop && typeof getWindowFullscreenState === "function"
      ? getWindowFullscreenState()
      : false;
  });

  useEffect(() => {
    if (!isMacosDesktop) return;
    const bridge = window.desktopBridge;
    if (!bridge) return;
    const { getWindowFullscreenState, onWindowFullscreenStateChange } = bridge;
    if (
      typeof getWindowFullscreenState !== "function" ||
      typeof onWindowFullscreenStateChange !== "function"
    ) {
      return;
    }

    const unsubscribe = onWindowFullscreenStateChange(setIsWindowFullscreen);
    setIsWindowFullscreen(getWindowFullscreenState());
    return unsubscribe;
  }, [isMacosDesktop]);

  return isMacosDesktop && !isWindowFullscreen;
}
