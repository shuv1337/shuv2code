interface RestorableFocusTarget {
  readonly isConnected: boolean;
  focus: (options?: FocusOptions) => void;
}

function readActiveElement(): unknown {
  return typeof document === "undefined" ? null : document.activeElement;
}

function isDocumentFocusFallback(value: unknown): boolean {
  return typeof document !== "undefined" && value === document.body;
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
  activeElement: unknown = readActiveElement(),
  currentActiveElement: () => unknown = readActiveElement,
): () => void {
  return () => {
    if (!isRestorableFocusTarget(activeElement) || !activeElement.isConnected) return;
    const current = currentActiveElement();
    // Do not steal focus back if the user deliberately moved it while the
    // preview operation was in flight. Losing renderer focus can temporarily
    // leave body (or no element) active, which is still safe to restore from.
    if (current !== null && current !== activeElement && !isDocumentFocusFallback(current)) return;
    try {
      activeElement.focus({ preventScroll: true });
    } catch {
      // The element may have become unfocusable while automation was running.
    }
  };
}

export async function withPreviewFocusPreserved<A>(
  operation: () => Promise<A>,
  activeElement: unknown = readActiveElement(),
  currentActiveElement: () => unknown = readActiveElement,
): Promise<A> {
  const restoreFocus = capturePreviewFocusRestorer(activeElement, currentActiveElement);
  try {
    return await operation();
  } finally {
    restoreFocus();
  }
}
