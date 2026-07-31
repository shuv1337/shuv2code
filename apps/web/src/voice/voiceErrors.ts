export class VoiceSessionError extends Error {
  readonly code: string;
  readonly recoverable: boolean;

  constructor(code: string, message: string, recoverable = false, options?: ErrorOptions) {
    super(message, options);
    this.name = "VoiceSessionError";
    this.code = code;
    this.recoverable = recoverable;
  }
}

export function normalizeVoiceSessionError(error: unknown): VoiceSessionError {
  if (error instanceof VoiceSessionError) {
    return error;
  }
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") {
      return new VoiceSessionError(
        "permission-denied",
        "Microphone access was denied. Allow microphone access and try again.",
        true,
        { cause: error },
      );
    }
    if (error.name === "NotFoundError" || error.name === "DevicesNotFoundError") {
      return new VoiceSessionError("microphone-unavailable", "No microphone is available.", true, {
        cause: error,
      });
    }
  }
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    const message =
      "message" in error && typeof error.message === "string"
        ? error.message
        : "Voice control could not complete the request.";
    const recoverable =
      "retryable" in error
        ? error.retryable === true
        : "recoverable" in error && error.recoverable === true;
    return new VoiceSessionError(error.code, message, recoverable, {
      cause: error,
    });
  }
  if (error instanceof Error) {
    return new VoiceSessionError("voice-failed", error.message, true, { cause: error });
  }
  return new VoiceSessionError("voice-failed", "Voice control could not start.", true);
}
