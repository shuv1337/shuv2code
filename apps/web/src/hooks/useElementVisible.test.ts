import { describe, expect, it } from "vite-plus/test";

import {
  type IntersectionObserverCtor,
  observeDocumentHidden,
  observeElementVisibility,
} from "./useElementVisible";

/**
 * A stand-in for the browser's observer that lets a test drive the callback.
 *
 * The detach path is the one worth pinning: an implementation that only ever
 * reports "visible" would pass any test that merely checks the happy path, and
 * would also silently restore the defect this exists to prevent — a rail
 * holding a desktop's viewer socket open for a thumbnail nobody is looking at.
 */
function fakeObserver() {
  const state = {
    observed: [] as Element[],
    disconnected: 0,
    options: undefined as IntersectionObserverInit | undefined,
    emit: (_intersecting: boolean) => {},
  };
  const Ctor = function (
    this: unknown,
    callback: IntersectionObserverCallback,
    options?: IntersectionObserverInit,
  ) {
    state.options = options;
    state.emit = (intersecting: boolean) => {
      callback(
        [{ isIntersecting: intersecting } as IntersectionObserverEntry],
        undefined as unknown as IntersectionObserver,
      );
    };
    return {
      observe: (element: Element) => state.observed.push(element),
      disconnect: () => {
        state.disconnected += 1;
      },
      unobserve: () => {},
      takeRecords: () => [],
    } as unknown as IntersectionObserver;
  } as unknown as IntersectionObserverCtor;
  return { state, Ctor };
}

const element = {} as Element;

describe("observeElementVisibility", () => {
  it("observes the element and reports when it scrolls out of view", () => {
    const { state, Ctor } = fakeObserver();
    const seen: boolean[] = [];
    observeElementVisibility({
      element,
      observerCtor: Ctor,
      onChange: (intersecting) => seen.push(intersecting),
    });

    expect(state.observed).toEqual([element]);
    state.emit(true);
    state.emit(false);
    // The false is the whole point: it is what detaches the viewer and lets a
    // desktop reach its idle stop.
    expect(seen).toEqual([true, false]);
  });

  it("disconnects when the subscription ends", () => {
    const { state, Ctor } = fakeObserver();
    const stop = observeElementVisibility({ element, observerCtor: Ctor, onChange: () => {} });
    expect(state.disconnected).toBe(0);
    stop();
    expect(state.disconnected).toBe(1);
  });

  it("passes the caller's margin through, so a thumbnail connects just before it arrives", () => {
    const { state, Ctor } = fakeObserver();
    observeElementVisibility({
      element,
      observerCtor: Ctor,
      onChange: () => {},
      rootMargin: "200px",
    });
    expect(state.options).toEqual({ rootMargin: "200px" });
  });

  it("degrades to visible where the browser has no observer at all", () => {
    // Failing open keeps the surface working on an old webview. Failing closed
    // would disable it there for a reason nobody would trace back to a missing
    // API.
    const seen: boolean[] = [];
    const stop = observeElementVisibility({
      element,
      observerCtor: undefined,
      onChange: (intersecting) => seen.push(intersecting),
    });
    expect(seen).toEqual([true]);
    expect(() => stop()).not.toThrow();
  });
});

describe("observeDocumentHidden", () => {
  function fakeDocument(initial: DocumentVisibilityState) {
    const listeners: Array<() => void> = [];
    return {
      doc: {
        visibilityState: initial,
        addEventListener: (_type: string, listener: () => void) => listeners.push(listener),
        removeEventListener: (_type: string, listener: () => void) => {
          const index = listeners.indexOf(listener);
          if (index !== -1) listeners.splice(index, 1);
        },
      },
      listeners,
    };
  }

  it("reports the current state immediately, then on every change", () => {
    const { doc, listeners } = fakeDocument("visible");
    const seen: boolean[] = [];
    observeDocumentHidden({ doc, onChange: (hidden) => seen.push(hidden) });
    expect(seen).toEqual([false]);

    // A backgrounded tab keeps its geometry, so intersection alone would still
    // report the thumbnail as visible and keep the socket open.
    doc.visibilityState = "hidden";
    for (const listener of listeners) listener();
    expect(seen).toEqual([false, true]);
  });

  it("stops listening when the subscription ends", () => {
    const { doc, listeners } = fakeDocument("visible");
    const stop = observeDocumentHidden({ doc, onChange: () => {} });
    expect(listeners).toHaveLength(1);
    stop();
    expect(listeners).toHaveLength(0);
  });
});
