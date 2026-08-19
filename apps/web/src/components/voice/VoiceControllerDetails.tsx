import type {
  ProviderInstanceId,
  ProjectId,
  RuntimeMode,
  VoiceControllerIdentity,
} from "@shuv2code/contracts";

import { cn } from "../../lib/utils";

function voiceControllerStateLabel(state: VoiceControllerIdentity["state"]): string {
  switch (state) {
    case "provisioning":
      return "Starting";
    case "active":
      return "Active";
    case "dormant":
      return "Ready to reconnect";
    case "resetting":
      return "Resetting";
  }
}

interface VoiceControllerConfigurationDetailsProps {
  readonly hostProjectId: ProjectId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly authorizedRuntimeCeiling: RuntimeMode;
  readonly controller?: VoiceControllerIdentity;
  readonly model?: string;
  readonly className?: string;
}

export function VoiceControllerConfigurationDetails({
  hostProjectId,
  providerInstanceId,
  authorizedRuntimeCeiling,
  controller,
  model,
  className,
}: VoiceControllerConfigurationDetailsProps) {
  return (
    <dl className={cn("grid gap-3 text-sm", className)}>
      {controller ? (
        <div>
          <dt className="font-medium">Status</dt>
          <dd className="text-muted-foreground">{voiceControllerStateLabel(controller.state)}</dd>
        </div>
      ) : null}
      <div>
        <dt className="font-medium">Host project</dt>
        <dd className="break-all font-mono text-muted-foreground">{hostProjectId}</dd>
      </div>
      <div>
        <dt className="font-medium">Codex provider instance</dt>
        <dd className="break-all font-mono text-muted-foreground">{providerInstanceId}</dd>
      </div>
      <div>
        <dt className="font-medium">Authority ceiling</dt>
        <dd className="text-muted-foreground">{authorizedRuntimeCeiling}</dd>
      </div>
      {model ? (
        <div>
          <dt className="font-medium">Controller model</dt>
          <dd className="break-all font-mono text-muted-foreground">{model}</dd>
        </div>
      ) : null}
      {controller ? (
        <div>
          <dt className="font-medium">Controller thread</dt>
          <dd className="break-all font-mono text-muted-foreground">
            {controller.controllerThreadId}
          </dd>
        </div>
      ) : null}
    </dl>
  );
}
