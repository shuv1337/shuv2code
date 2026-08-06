interface RestorableFocusTarget {
  readonly isConnected: boolean;
  focus: (options?: FocusOptions) => void;
}

function isRestorableFocusTarget(value: unknown): value is RestorableFocusTarget {
  return (
    value !== null &&
    typeof value === "object" &&
    "isConnected" in value &&
    typeof value.isConnected === "boolean" &&
    "focus" in value &&
    typeof value.focus === "function"
  );
}

/**
 * Preview keyboard automation temporarily focuses the guest WebContents.
 * Capture the renderer's active element so the user's typing caret can be
 * restored when Electron returns focus to the app WebContents.
 */
export function capturePreviewFocusRestorer(
  activeElement: unknown = typeof document === "undefined" ? null : document.activeElement,
): () => void {
  return () => {
    if (!isRestorableFocusTarget(activeElement) || !activeElement.isConnected) return;
    try {
      activeElement.focus({ preventScroll: true });
    } catch {
      // The element may have become unfocusable while automation was running.
    }
  };
}

export async function withPreviewFocusPreserved<A>(
  operation: () => Promise<A>,
  activeElement: unknown = typeof document === "undefined" ? null : document.activeElement,
): Promise<A> {
  const restoreFocus = capturePreviewFocusRestorer(activeElement);
  try {
    return await operation();
  } finally {
    restoreFocus();
  }
}
