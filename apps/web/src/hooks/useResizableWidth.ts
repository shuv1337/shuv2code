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
}

export interface ResizableWidthHandlers {
  readonly onPointerDown: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerUp: (event: ReactPointerEvent<HTMLElement>) => void;
  readonly onPointerCancel: (event: ReactPointerEvent<HTMLElement>) => void;
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
  const { storageKey, defaultWidth, minWidth, maxWidth, edge } = options;

  const clamp = useCallback(
    (value: number): number => {
      if (!Number.isFinite(value)) return defaultWidth;
      return Math.max(minWidth, Math.min(maxWidth, value));
    },
    [defaultWidth, maxWidth, minWidth],
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
