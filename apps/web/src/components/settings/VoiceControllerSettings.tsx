import type { VoiceControllerIdentity } from "@shuv2code/contracts";
import { MicIcon, RefreshCwIcon } from "lucide-react";
import { useCallback, useEffect, useState } from "react";

import { usePrimaryEnvironment } from "../../state/environments";
import { useVoiceSession } from "../../voice/VoiceSessionProvider";
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
import { VoiceControllerConfigurationDetails } from "../voice/VoiceControllerDetails";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type ControllerStatus =
  | { readonly type: "loading" }
  | { readonly type: "ready"; readonly controller: VoiceControllerIdentity | null }
  | { readonly type: "error"; readonly message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The voice controller could not be read.";
}

export function VoiceControllerSettings() {
  const primaryEnvironment = usePrimaryEnvironment();
  const voice = useVoiceSession();
  const getController = voice.getController;
  const resetController = voice.resetController;
  const [status, setStatus] = useState<ControllerStatus>({ type: "loading" });
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  const load = useCallback(async () => {
    const environmentId = primaryEnvironment?.environmentId;
    if (!environmentId) {
      setStatus({ type: "ready", controller: null });
      return;
    }
    if (primaryEnvironment.connection.phase !== "connected") {
      setStatus({ type: "loading" });
      return;
    }
    setStatus({ type: "loading" });
    try {
      const controller = await getController(environmentId);
      setStatus({ type: "ready", controller });
    } catch (error) {
      setStatus({ type: "error", message: errorMessage(error) });
    }
  }, [getController, primaryEnvironment]);

  useEffect(() => {
    void load();
  }, [load]);

  const controller = status.type === "ready" ? status.controller : null;
  const reset = async () => {
    if (!primaryEnvironment || !controller) return;
    setResetting(true);
    try {
      const reset = await resetController(
        primaryEnvironment.environmentId,
        controller.controllerThreadId,
      );
      if (!reset) {
        throw new Error("The controller changed before it could be reset. Refresh and try again.");
      }
      setConfirmOpen(false);
      setStatus({ type: "ready", controller: null });
    } catch (error) {
      setConfirmOpen(false);
      setStatus({ type: "error", message: errorMessage(error) });
    } finally {
      setResetting(false);
    }
  };

  return (
    <>
      <SettingsSection title="Voice control" icon={<MicIcon className="size-5" />}>
        <SettingsRow
          title="Environment controller"
          description="One controller is securely bound to this environment. Reset it before changing its host project, provider, or authority ceiling."
          status={
            status.type === "loading"
              ? "Checking the current binding…"
              : status.type === "error"
                ? status.message
                : controller
                  ? "A controller is configured."
                  : "No controller is configured."
          }
          control={
            <div className="flex gap-2">
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={status.type === "loading" || resetting}
                onClick={() => void load()}
              >
                <RefreshCwIcon />
                Refresh
              </Button>
              {controller ? (
                <Button
                  type="button"
                  size="sm"
                  variant="destructive-outline"
                  disabled={resetting}
                  onClick={() => setConfirmOpen(true)}
                >
                  Reset controller
                </Button>
              ) : null}
            </div>
          }
        >
          {controller ? (
            <VoiceControllerConfigurationDetails
              className="mt-4 rounded-lg border border-border/70 bg-muted/40 p-3"
              controller={controller}
              hostProjectId={controller.hostProjectId}
              providerInstanceId={controller.providerInstanceId}
              authorizedRuntimeCeiling={controller.authorizedRuntimeCeiling}
            />
          ) : null}
        </SettingsRow>
      </SettingsSection>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Reset the environment voice controller?</AlertDialogTitle>
            <AlertDialogDescription>
              This ends active voice control, revokes its controller credentials, and archives only
              the hidden controller thread. Ordinary project threads and their work are untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" disabled={resetting} />}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={resetting} onClick={() => void reset()}>
              {resetting ? "Resetting…" : "Reset controller"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
