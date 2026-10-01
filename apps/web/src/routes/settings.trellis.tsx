import { createFileRoute } from "@tanstack/react-router";

import { TrellisSettingsPanel } from "../components/settings/TrellisSettings";

export const Route = createFileRoute("/settings/trellis")({
  component: TrellisSettingsPanel,
});
