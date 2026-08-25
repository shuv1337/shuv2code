import * as Schema from "effect/Schema";
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";

import { getLocalStorageItem, setLocalStorageItem } from "./useLocalStorage";

const WidthSchema = Schema.Finite;

export interface UseResizableWidthOptions {
  /** localStorage key the persisted width is stored under. */
  readonly storageKey: string;
  readonly defaultWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  /**
   * Which edge of the host element carries the drag handle:
   *   - "left"  → panel grows leftward (right-anchored panels)
   *   - "right" → panel grows rightward (left-anchored panels)
   */
  readonly edge: "left" | "right";
  /**
   * An additional, *live* bound the caller imposes on top of `minWidth`/
   * `maxWidth` — typically one derived from the current viewport.
   *
   * This exists because a caller that clamped the returned `width` itself would
   * silently desynchronise the hook: the panel would render at the clamped
   * width while the hook kept dragging from the stored one, so the first part
   * of every drag would move the pointer without moving the panel (a dead
   * zone), and the panel would jump the moment the cursor crossed back into
   * range. Folding the caller's clamp in here keeps one number — the rendered
   * width — as the drag origin, the persisted value, and what the user sees.
   *
   * Must be referentially stable across renders that do not change the bound
   * (wrap it in `useCallback`), or the drag callbacks are rebuilt mid-gesture.
   */
  readonly clampWidth?: (value: number) => number;
}

export interface ResizableWidthHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * The single width function the hook uses everywhere: to render, to seed a
 * drag, and to persist.
 *
 * Exported because "everywhere" is the property worth testing. If the caller's
 * live bound is applied to the hook's *output* instead of folded in here, the
 * panel renders one number while drags start from another — a dead zone at the
 * start of every gesture, then a jump when the cursor crosses back into range.
 */
export function clampResizableWidth(input: {
  readonly value: number;
  readonly defaultWidth: number;
  readonly minWidth: number;
  readonly maxWidth: number;
  readonly clampWidth?: ((value: number) => number) | undefined;
}): number {
  if (!Number.isFinite(input.value)) {
    return input.clampWidth?.(input.defaultWidth) ?? input.defaultWidth;
  }
  const bounded = Math.max(input.minWidth, Math.min(input.maxWidth, input.value));
  return input.clampWidth === undefined ? bounded : input.clampWidth(bounded);
}

/**
 * Width state for a side-anchored panel resized via a drag handle on the
 * specified edge. Width is read from localStorage on mount and persisted on
 * drag-end (not on every rAF tick — would otherwise be ~60 writes/sec).
 *
 * The hook updates an internal `width` state during drag (so the panel
 * follows the cursor live) and only commits to localStorage when the user
 * lifts the pointer.
 */
export function useResizableWidth(options: UseResizableWidthOptions): {
  readonly width: number;
  readonly handlers: ResizableWidthHandlers;
} {
  const { storageKey, defaultWidth, minWidth, maxWidth, edge, clampWidth } = options;

  const clamp = useCallback(
    (value: number): number =>
      clampResizableWidth({ value, defaultWidth, minWidth, maxWidth, clampWidth }),
    [clampWidth, defaultWidth, maxWidth, minWidth],
  );

  // No cross-tab subscription: panel width is per-window state.
  const [width, setWidth] = useState<number>(() => {
    if (typeof window === "undefined") return defaultWidth;
    try {
      const stored = getLocalStorageItem(storageKey, WidthSchema);
      return clamp(stored ?? defaultWidth);
    } catch (error) {
      console.error("Could not read persisted panel width.", error);
      return defaultWidth;
    }
  });

  const clampedWidth = clamp(width);

  const dragStateRef = useRef<{
    pointerId: number;
    startX: number;
    startWidth: number;
    pending: number;
    rafId: number | null;
    target: HTMLElement;
    removeWindowListeners: (() => void) | null;
  } | null>(null);

  const releasePointer = useCallback((pointerId: number) => {
    const state = dragStateRef.current;
    if (!state) return;
    if (state.rafId !== null) {
      cancelAnimationFrame(state.rafId);
    }
    state.removeWindowListeners?.();
    try {
      if (state.target.hasPointerCapture(pointerId)) {
        state.target.releasePointerCapture(pointerId);
      }
    } catch {
      // pointer may already be released; harmless.
    }
    document.body.style.removeProperty("cursor");
    document.body.style.removeProperty("user-select");
    dragStateRef.current = null;
  }, []);

  useEffect(
    () => () => {
      const state = dragStateRef.current;
      if (state) releasePointer(state.pointerId);
    },
    [releasePointer],
  );

  const updatePointer = useCallback(
    (pointerId: number, clientX: number) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== pointerId) return;
      const delta = edge === "left" ? state.startX - clientX : clientX - state.startX;
      state.pending = clamp(state.startWidth + delta);
      if (state.rafId !== null) return;
      state.rafId = requestAnimationFrame(() => {
        const active = dragStateRef.current;
        if (!active) return;
        active.rafId = null;
        setWidth(active.pending);
      });
    },
    [clamp, edge],
  );

  const finishPointer = useCallback(
    (pointerId: number) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== pointerId) return;
      const finalWidth = clamp(state.pending);
      releasePointer(pointerId);
      // Commit once at drag-end to avoid 60Hz localStorage writes.
      try {
        setLocalStorageItem(storageKey, finalWidth, WidthSchema);
      } catch (error) {
        console.error("Could not persist panel width.", error);
      }
      setWidth(finalWidth);
    },
    [clamp, releasePointer, storageKey],
  );

  const cancelPointer = useCallback(
    (pointerId: number) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== pointerId) return;
      // Don't persist a cancelled drag; revert to the start width.
      const startWidth = state.startWidth;
      releasePointer(pointerId);
      setWidth(startWidth);
    },
    [releasePointer],
  );

  const onPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const target = event.currentTarget;
      try {
        target.setPointerCapture(event.pointerId);
      } catch {
        // Electron may decline capture near a native drag region. The
        // window listeners below still provide a complete drag lifecycle.
      }
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      const state: NonNullable<typeof dragStateRef.current> = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startWidth: clampedWidth,
        pending: clampedWidth,
        rafId: null,
        target,
        removeWindowListeners: null,
      };
      dragStateRef.current = state;

      const onWindowPointerMove = (pointerEvent: PointerEvent) => {
        if (pointerEvent.pointerId !== state.pointerId) return;
        pointerEvent.preventDefault();
        updatePointer(pointerEvent.pointerId, pointerEvent.clientX);
      };
      const onWindowPointerUp = (pointerEvent: PointerEvent) => {
        finishPointer(pointerEvent.pointerId);
      };
      const onWindowPointerCancel = (pointerEvent: PointerEvent) => {
        cancelPointer(pointerEvent.pointerId);
      };
      window.addEventListener("pointermove", onWindowPointerMove, { passive: false });
      window.addEventListener("pointerup", onWindowPointerUp);
      window.addEventListener("pointercancel", onWindowPointerCancel);
      state.removeWindowListeners = () => {
        window.removeEventListener("pointermove", onWindowPointerMove);
        window.removeEventListener("pointerup", onWindowPointerUp);
        window.removeEventListener("pointercancel", onWindowPointerCancel);
      };
    },
    [cancelPointer, clampedWidth, finishPointer, updatePointer],
  );

  const onPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      const state = dragStateRef.current;
      if (!state || state.pointerId !== event.pointerId) return;
      event.preventDefault();
      updatePointer(event.pointerId, event.clientX);
    },
    [updatePointer],
  );

  const onPointerUp = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      finishPointer(event.pointerId);
    },
    [finishPointer],
  );

  const onPointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLElement>) => {
      cancelPointer(event.pointerId);
    },
    [cancelPointer],
  );

  return {
    width: clampedWidth,
    handlers: { onPointerDown, onPointerMove, onPointerUp, onPointerCancel },
  };
}
