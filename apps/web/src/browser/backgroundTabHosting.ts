import type { DesktopPreviewHosting } from "@shuv2code/contracts";

/**
 * A background-owned guest must never have a duplicate DOM `<webview>`.
 * Visibility is the explicit adoption signal: the desktop releases its hidden
 * window first, then the renderer is allowed to mount the human-facing guest.
 */
export const shouldRendererHostPreview = (
  hosting: DesktopPreviewHosting,
  visible: boolean,
): boolean => visible || hosting !== "background";
