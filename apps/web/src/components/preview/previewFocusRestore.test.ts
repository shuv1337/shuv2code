import { describe, expect, it, vi } from "vite-plus/test";

import { capturePreviewFocusRestorer, withPreviewFocusPreserved } from "./previewFocusRestore";

describe("preview focus restoration", () => {
  it("restores a connected focus target without scrolling", () => {
    const focus = vi.fn();
    const restore = capturePreviewFocusRestorer({ isConnected: true, focus });

    restore();

    expect(focus).toHaveBeenCalledOnce();
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("does not restore a target that was removed while automation ran", () => {
    const focus = vi.fn();
    const target = { isConnected: true, focus };
    const restore = capturePreviewFocusRestorer(target);
    target.isConnected = false;

    restore();

    expect(focus).not.toHaveBeenCalled();
  });

  it("restores focus after a successful automation operation", async () => {
    const order: string[] = [];
    const result = await withPreviewFocusPreserved(
      async () => {
        order.push("press");
        return "pressed";
      },
      {
        isConnected: true,
        focus: () => order.push("restore"),
      },
    );

    expect(result).toBe("pressed");
    expect(order).toEqual(["press", "restore"]);
  });

  it("restores focus after a failed automation operation", async () => {
    const focus = vi.fn();
    await expect(
      withPreviewFocusPreserved(
        async () => {
          throw new Error("press failed");
        },
        { isConnected: true, focus },
      ),
    ).rejects.toThrow("press failed");
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
  });
});
