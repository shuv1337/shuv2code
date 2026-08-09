import type {
  EnvironmentId,
  ModelSelection,
  ProjectId,
  ProviderInstanceId,
  RuntimeMode,
  ThreadId,
  VoiceControllerIdentity,
} from "@shuv2code/contracts";
import { MicIcon } from "lucide-react";
import { useCallback, useState } from "react";

import { useRightPanelStore } from "../../rightPanelStore";
import { useVoiceSession } from "../../voice/VoiceSessionProvider";
import {
  acquireVoiceMicrophoneStream,
  releaseVoiceMicrophoneStream,
} from "../../voice/voiceMicrophoneAccess";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { VoiceControllerConfigurationDetails } from "./VoiceControllerDetails";
import {
  hasVoiceControllerBindingConflict,
  replaceVoiceControllerAfterMicrophoneAccess,
} from "./VoiceControllerManagement.logic";

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

type ControllerLookup =
  | { readonly type: "idle" | "loading" }
  | { readonly type: "ready"; readonly controller: VoiceControllerIdentity | null }
  | { readonly type: "error"; readonly message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The voice controller could not be read.";
}

export function VoiceControlButton(props: VoiceControlButtonProps) {
  const voice = useVoiceSession();
  const [setupOpen, setSetupOpen] = useState(false);
  const [ceiling, setCeiling] = useState<RuntimeMode>("approval-required");
  const [lookup, setLookup] = useState<ControllerLookup>({ type: "idle" });
  const [resetConfirmOpen, setResetConfirmOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const bindingConflictError =
    voice.state.phase.type === "error" && voice.state.phase.code === "controller_binding_conflict";
  const active =
    voice.state.phase.type !== "idle" &&
    voice.state.phase.type !== "unsupported" &&
    !bindingConflictError;
  const pending =
    voice.state.phase.type === "requesting-permission" ||
    voice.state.phase.type === "negotiating" ||
    voice.state.phase.type === "reconnecting";
  const unavailableReason = !props.realtimeEnabled
    ? "Realtime voice is disabled in server settings"
    : !props.threadReadEnabled
      ? "Voice thread status is disabled in server settings"
      : null;
  const requested = {
    hostProjectId: props.hostProjectId,
    providerInstanceId: props.providerInstanceId,
    authorizedRuntimeCeiling: ceiling,
  };
  const existing = lookup.type === "ready" ? lookup.controller : null;
  const conflict = hasVoiceControllerBindingConflict(existing, requested);
  const openVoiceSurface = useCallback(() => {
    useRightPanelStore.getState().openVoice(props.environmentId);
  }, [props.environmentId]);

  const loadController = useCallback(async () => {
    setLookup({ type: "loading" });
    setActionError(null);
    try {
      const controller = await voice.getController(props.environmentId);
      setLookup({ type: "ready", controller });
    } catch (error) {
      setLookup({ type: "error", message: errorMessage(error) });
    }
  }, [props.environmentId, voice.getController]);

  const openSetup = () => {
    setSetupOpen(true);
    void loadController();
  };

  const startVoice = async (useExisting: boolean) => {
    setBusy(true);
    setActionError(null);
    let microphoneStream: MediaStream | undefined;
    try {
      microphoneStream = await acquireVoiceMicrophoneStream();
      if (bindingConflictError) {
        await voice.stop();
      }
      setSetupOpen(false);
      const preparedMicrophone = microphoneStream;
      microphoneStream = undefined;
      await voice.start(
        useExisting && existing
          ? {
              environmentId: props.environmentId,
              hostProjectId: existing.hostProjectId,
              ...(props.targetThreadId === undefined
                ? {}
                : { targetThreadId: props.targetThreadId }),
              providerInstanceId: existing.providerInstanceId,
              authorizedRuntimeCeiling: existing.authorizedRuntimeCeiling,
              microphoneStream: preparedMicrophone,
            }
          : {
              environmentId: props.environmentId,
              hostProjectId: props.hostProjectId,
              ...(props.targetThreadId === undefined
                ? {}
                : { targetThreadId: props.targetThreadId }),
              providerInstanceId: props.providerInstanceId,
              modelSelection: props.modelSelection,
              authorizedRuntimeCeiling: ceiling,
              microphoneStream: preparedMicrophone,
            },
      );
      openVoiceSurface();
    } catch (error) {
      setSetupOpen(true);
      setActionError(errorMessage(error));
    } finally {
      releaseVoiceMicrophoneStream(microphoneStream);
      setBusy(false);
    }
  };

  const resetAndStart = async () => {
    if (!existing) return;
    setBusy(true);
    setActionError(null);
    try {
      // Acquire the one stream startup will use before destroying the durable binding. A denied
      // or unavailable microphone therefore cannot make a successful reset look broken.
      await replaceVoiceControllerAfterMicrophoneAccess({
        acquireMicrophone: acquireVoiceMicrophoneStream,
        resetController: () =>
          voice.resetController(props.environmentId, existing.controllerThreadId),
        startWithMicrophone: async (microphoneStream) => {
          setResetConfirmOpen(false);
          setSetupOpen(false);
          await voice.start({
            environmentId: props.environmentId,
            hostProjectId: props.hostProjectId,
            ...(props.targetThreadId === undefined ? {} : { targetThreadId: props.targetThreadId }),
            providerInstanceId: props.providerInstanceId,
            modelSelection: props.modelSelection,
            authorizedRuntimeCeiling: ceiling,
            microphoneStream,
          });
          openVoiceSurface();
        },
        releaseMicrophone: releaseVoiceMicrophoneStream,
      });
    } catch (error) {
      const message = errorMessage(error);
      setResetConfirmOpen(false);
      setSetupOpen(true);
      await loadController();
      setActionError(message);
    } finally {
      setBusy(false);
    }
  };

  const idleLabel = bindingConflictError ? "Reconfigure voice control" : "Set up voice control";

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size={props.compact ? "icon-sm" : "sm"}
              variant={active ? "secondary" : props.surface ? "default" : "ghost"}
              className={
                active || props.surface
                  ? undefined
                  : "text-muted-foreground/70 hover:text-foreground/80"
              }
              aria-label={
                active
                  ? "Voice control active"
                  : unavailableReason
                    ? `Voice control unavailable: ${unavailableReason}`
                    : idleLabel
              }
              disabled={pending || unavailableReason !== null}
              onClick={active ? openVoiceSurface : openSetup}
            >
              <MicIcon />
              {props.compact ? null : (
                <span className={props.surface ? undefined : "hidden sm:inline"}>
                  {active ? "Voice" : props.surface ? "Start voice" : "Voice"}
                </span>
              )}
            </Button>
          }
        />
        <TooltipPopup side="top">
          {active
            ? "Open voice"
            : (unavailableReason ?? (props.surface ? "Start voice" : idleLabel))}
        </TooltipPopup>
      </Tooltip>

      <Dialog
        open={setupOpen}
        onOpenChange={(open) => {
          setSetupOpen(open);
          if (open && lookup.type === "idle") void loadController();
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>
              {conflict ? "Use the existing voice controller?" : "Start voice"}
            </DialogTitle>
            <DialogDescription>
              {conflict
                ? "This environment already has a persistent controller. Use it, or replace it with the configuration from this thread."
                : "Choose the maximum control level, then allow microphone access."}
            </DialogDescription>
          </DialogHeader>
          <DialogPanel className="space-y-4">
            {lookup.type === "loading" || lookup.type === "idle" ? (
              <p className="text-sm text-muted-foreground">Checking the environment controller…</p>
            ) : lookup.type === "error" ? (
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm">
                <p>{lookup.message}</p>
                <Button
                  className="mt-3"
                  size="sm"
                  variant="outline"
                  onClick={() => void loadController()}
                >
                  Try again
                </Button>
              </div>
            ) : conflict && existing ? (
              <div className="grid gap-3 sm:grid-cols-2">
                <section className="rounded-lg border border-border bg-muted/40 p-3">
                  <h3 className="mb-3 text-sm font-semibold">Existing controller</h3>
                  <VoiceControllerConfigurationDetails
                    controller={existing}
                    hostProjectId={existing.hostProjectId}
                    providerInstanceId={existing.providerInstanceId}
                    authorizedRuntimeCeiling={existing.authorizedRuntimeCeiling}
                  />
                </section>
                <section className="rounded-lg border border-primary/40 bg-primary/5 p-3">
                  <h3 className="mb-3 text-sm font-semibold">Requested here</h3>
                  <VoiceControllerConfigurationDetails
                    hostProjectId={props.hostProjectId}
                    providerInstanceId={props.providerInstanceId}
                    authorizedRuntimeCeiling={ceiling}
                    model={props.modelSelection.model}
                  />
                </section>
              </div>
            ) : (
              <>
                {existing ? (
                  <p className="rounded-lg border border-border bg-muted/64 p-3 text-sm">
                    This matches the controller already configured for the environment.
                  </p>
                ) : null}
                <VoiceControllerConfigurationDetails
                  hostProjectId={props.hostProjectId}
                  providerInstanceId={props.providerInstanceId}
                  authorizedRuntimeCeiling={ceiling}
                  model={props.modelSelection.model}
                />
              </>
            )}
            {lookup.type === "ready" ? (
              <>
                <label className="block space-y-1.5 text-sm font-medium">
                  Control level
                  <select
                    className="h-9 w-full rounded-lg border border-input bg-background px-3 font-normal"
                    value={ceiling}
                    onChange={(event) => setCeiling(event.target.value as RuntimeMode)}
                  >
                    <option value="approval-required">Approval required (recommended)</option>
                    <option value="auto-accept-edits">Auto-accept edits</option>
                    <option value="auto">Automatic</option>
                    <option value="full-access">Full access</option>
                  </select>
                </label>
                <p className="text-xs text-muted-foreground">
                  Effective voice authority is also limited by the controller and target runtime
                  modes. Raising this ceiling later requires reauthorization.
                </p>
                {!props.threadControlEnabled ? (
                  <p className="rounded-lg border border-border bg-muted/64 p-3 text-sm">
                    Thread control is disabled. Voice will run in read-only status mode and cannot
                    create, steer, or stop target threads.
                  </p>
                ) : null}
              </>
            ) : null}
            {actionError ? (
              <p className="rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive-foreground">
                {actionError}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" disabled={busy} onClick={() => setSetupOpen(false)}>
              Cancel
            </Button>
            {lookup.type === "ready" && conflict ? (
              <>
                <Button variant="outline" disabled={busy} onClick={() => void startVoice(true)}>
                  Use existing
                </Button>
                <Button
                  variant="destructive"
                  disabled={busy}
                  onClick={() => setResetConfirmOpen(true)}
                >
                  Reset and use here
                </Button>
              </>
            ) : lookup.type === "ready" ? (
              <Button disabled={busy} onClick={() => void startVoice(false)}>
                {props.threadControlEnabled ? "Confirm and start" : "Start read-only voice"}
              </Button>
            ) : null}
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog open={resetConfirmOpen} onOpenChange={setResetConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Replace the environment voice controller?</AlertDialogTitle>
            <AlertDialogDescription>
              This ends active voice control, revokes the existing controller credentials, and
              archives only its hidden controller thread. Ordinary project threads and their work
              are untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={busy} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={busy} onClick={() => void resetAndStart()}>
              {busy ? "Replacing…" : "Replace and start"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
