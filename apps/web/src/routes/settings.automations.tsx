import { createFileRoute } from "@tanstack/react-router";

import { AutomationsSettingsPanel } from "../components/settings/AutomationsSettings";

export const Route = createFileRoute("/settings/automations")({
  component: AutomationsSettingsPanel,
});
