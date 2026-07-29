import { createFileRoute } from "@tanstack/react-router";

import { SpeechSettingsPanel } from "../components/settings/SpeechSettingsPanel";

function SettingsSpeechRoute() {
  return <SpeechSettingsPanel />;
}

export const Route = createFileRoute("/settings/speech")({
  component: SettingsSpeechRoute,
});
