import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { toastManager } from "../components/ui/toast";
import { requestSpeechAudio } from "./requestSpeechAudio";
import { SpeechPlaybackController } from "./SpeechPlaybackController";

function messageForError(error: Error): string {
  const detail = error.message.trim();
  return detail.length > 0 ? detail : "Text-to-speech playback failed.";
}

export function useSpeechPlayback() {
  const controller = useMemo(
    () =>
      new SpeechPlaybackController({
        requestAudio: requestSpeechAudio,
        createAudio: (url) => new Audio(url),
        createObjectUrl: (blob) => URL.createObjectURL(blob),
        revokeObjectUrl: (url) => URL.revokeObjectURL(url),
        onError: (error) =>
          toastManager.add({
            title: "Could not read message",
            description: messageForError(error),
          }),
      }),
    [],
  );
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );

  useEffect(() => () => controller.dispose(), [controller]);

  const toggle = useCallback(
    (messageId: string, input: string) =>
      controller.toggle(messageId, input).catch((error: unknown) => {
        const resolved = error instanceof Error ? error : new Error();
        toastManager.add({
          title: "Could not read message",
          description: messageForError(resolved),
        });
      }),
    [controller],
  );
  const stop = useCallback(() => controller.stop(), [controller]);

  return {
    state,
    toggle,
    stop,
  };
}
