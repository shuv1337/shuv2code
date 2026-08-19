import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@shuv2code/contracts";
import { PhoneIcon } from "lucide-react";
import { useCallback } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { useVoiceSession } from "../../voice/VoiceSessionProvider";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface VoiceControlButtonProps {
  readonly environmentId: EnvironmentId;
  readonly hostProjectId: ProjectId;
  readonly targetThreadId?: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: ModelSelection;
  readonly realtimeEnabled: boolean;
  readonly threadReadEnabled: boolean;
  readonly threadControlEnabled: boolean;
  readonly compact?: boolean;
  readonly surface?: boolean;
}

/**
 * The composer control is a lightweight doorway into Call. Starting media and
 * materializing a draft remain inside VoiceSurface, where the owning thread is
 * visible before the user grants microphone access.
 */
export function VoiceControlButton(props: VoiceControlButtonProps) {
  const voice = useVoiceSession();
  const sessionPresent = voice.state.phase.type !== "idle";
  const callPresent = sessionPresent && voice.state.owner?.kind === "thread-call";
  const unavailableReason = !props.realtimeEnabled
    ? "Realtime voice is disabled in server settings"
    : !props.threadReadEnabled
      ? "Voice thread status is disabled in server settings"
      : null;
  const openVoiceSurface = useCallback(() => {
    useRightPanelStore.getState().openVoice(props.environmentId);
  }, [props.environmentId]);
  const label = callPresent ? "Open call" : sessionPresent ? "Open voice session" : "Start a call";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size={props.compact ? "icon-sm" : "sm"}
            variant={callPresent ? "secondary" : props.surface ? "default" : "ghost"}
            className={
              callPresent || props.surface
                ? undefined
                : "text-muted-foreground/70 hover:text-foreground/80"
            }
            aria-label={unavailableReason ? `Call unavailable: ${unavailableReason}` : label}
            disabled={unavailableReason !== null}
            onClick={openVoiceSurface}
          >
            <PhoneIcon />
            {props.compact ? null : (
              <span className={props.surface ? undefined : "hidden sm:inline"}>
                {callPresent ? "Call" : "Start call"}
              </span>
            )}
          </Button>
        }
      />
      <TooltipPopup side="top">{unavailableReason ?? label}</TooltipPopup>
    </Tooltip>
  );
}
