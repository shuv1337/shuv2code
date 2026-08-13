import { createFileRoute, redirect } from "@tanstack/react-router";

import { VoiceSurfaceLab } from "../components/voice/VoiceSurfaceLab";

function VoiceLabRoute() {
  return <VoiceSurfaceLab />;
}

export const Route = createFileRoute("/dev/voice")({
  beforeLoad: () => {
    if (!import.meta.env.DEV) {
      throw redirect({ to: "/", replace: true });
    }
  },
  component: VoiceLabRoute,
});
