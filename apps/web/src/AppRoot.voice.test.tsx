import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vite-plus/test";

import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import type { AppRouter } from "./router";
import { AppRoot } from "./AppRoot";
import { VoiceSessionProvider } from "./voice/VoiceSessionProvider";

describe("AppRoot voice ownership", () => {
  it("mounts voice below the atom registry and above routed content", () => {
    const root = AppRoot({ router: {} as AppRouter });
    expect(root.type).toBe(AppAtomRegistryProvider);
    const registryChildren = Children.toArray(
      (root as ReactElement<{ readonly children: ReactNode }>).props.children,
    );
    expect(registryChildren).toHaveLength(1);
    const voiceProvider = registryChildren[0];
    expect(isValidElement(voiceProvider) && voiceProvider.type).toBe(VoiceSessionProvider);
    const providerChildren = Children.toArray(
      (voiceProvider as ReactElement<{ readonly children: ReactNode }>).props.children,
    );
    expect(providerChildren).toHaveLength(3);
  });
});
