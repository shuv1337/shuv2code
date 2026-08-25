import { describe, expect, it } from "vite-plus/test";

import { clampResizableWidth } from "./useResizableWidth";

const bounds = { defaultWidth: 470, minWidth: 320, maxWidth: 720 };

describe("clampResizableWidth", () => {
  it("holds the panel inside its own bounds", () => {
    expect(clampResizableWidth({ ...bounds, value: 500 })).toBe(500);
    expect(clampResizableWidth({ ...bounds, value: 900 })).toBe(720);
    expect(clampResizableWidth({ ...bounds, value: 10 })).toBe(320);
  });

  it("falls back to the default for a width it cannot read", () => {
    expect(clampResizableWidth({ ...bounds, value: Number.NaN })).toBe(470);
  });

  it("applies the caller's live bound on top of its own", () => {
    // The viewport clamp. Folded in here rather than applied to the hook's
    // output, so the rendered width, the drag origin and the persisted value
    // stay one number (D2): a rail dragged to 700px on a wide monitor and
    // reopened on a narrow one renders at 400 *and* drags from 400, instead of
    // rendering at 400 while the drag silently starts from 700 — which is a
    // dead handle until the cursor travels 300px, then a jump.
    const clampWidth = (value: number) => Math.min(value, 400);
    expect(clampResizableWidth({ ...bounds, value: 700, clampWidth })).toBe(400);
  });

  it("lets the caller's bound narrow the default too", () => {
    const clampWidth = (value: number) => Math.min(value, 360);
    expect(clampResizableWidth({ ...bounds, value: Number.NaN, clampWidth })).toBe(360);
  });

  it("keeps the caller's bound subordinate to nothing — it is applied last", () => {
    // A caller that wants a width below `minWidth` gets it: the live bound
    // describes the space that actually exists, and a panel wider than its
    // container is worse than a narrow one.
    const clampWidth = () => 200;
    expect(clampResizableWidth({ ...bounds, value: 500, clampWidth })).toBe(200);
  });

  it("is unchanged for callers that pass no live bound", () => {
    expect(clampResizableWidth({ ...bounds, value: 500, clampWidth: undefined })).toBe(500);
  });
});
