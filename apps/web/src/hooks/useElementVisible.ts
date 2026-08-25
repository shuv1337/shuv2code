import { type RefObject, useEffect, useState } from "react";

/**
 * Whether an element is currently being looked at: on screen *and* in a visible
 * document.
 *
 * Both halves are needed and neither implies the other. `IntersectionObserver`
 * reports geometry, and a backgrounded tab's elements keep whatever geometry
 * they had — so a captain who switches tabs leaves every "visible" element
 * still intersecting. `visibilityState` covers that, and covers the locked
 * screen and the minimised window with it.
 *
 * The two subscriptions below are exported as plain functions taking their
 * observer and document by argument. The hook is a thin composition of them.
 * That split is deliberate: this repository's tests run in a node environment
 * with no DOM, so an effect-only implementation would be untestable exactly
 * where it matters — the *detach* path, which is the half that has to work for
 * the feature to be worth having.
 */

export type IntersectionObserverCtor = new (
  callback: IntersectionObserverCallback,
  options?: IntersectionObserverInit,
) => IntersectionObserver;

/**
 * Report whether `element` is on screen, until the returned function is called.
 *
 * Environments with no `IntersectionObserver` (an old embedded webview, a test
 * that did not stub one) report *visible* once and stop: degrading to "always
 * on" keeps the surface working, where degrading to "always off" would silently
 * disable it in a way nobody would attribute to a missing browser API.
 */
export function observeElementVisibility(input: {
  readonly element: Element;
  readonly rootMargin?: string;
  readonly onChange: (intersecting: boolean) => void;
  readonly observerCtor?: IntersectionObserverCtor | undefined;
}): () => void {
  const Ctor =
    input.observerCtor ??
    (typeof IntersectionObserver === "undefined" ? undefined : IntersectionObserver);
  if (Ctor === undefined) {
    input.onChange(true);
    return () => {};
  }
  const observer = new Ctor(
    (entries) => {
      const entry = entries.at(-1);
      if (entry === undefined) return;
      input.onChange(entry.isIntersecting);
    },
    input.rootMargin === undefined ? undefined : { rootMargin: input.rootMargin },
  );
  observer.observe(input.element);
  return () => observer.disconnect();
}

/**
 * The slice of `document` this needs. Spelled out structurally rather than as
 * `Pick<Document, …>` so a test can supply a plain object: `Document`'s
 * listener signatures are overloaded, and matching them exactly is work that
 * buys the caller nothing.
 */
export interface DocumentVisibilitySource {
  readonly visibilityState: DocumentVisibilityState;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/** Report whether the document is hidden, until the returned function is called. */
export function observeDocumentHidden(input: {
  readonly doc: DocumentVisibilitySource;
  readonly onChange: (hidden: boolean) => void;
}): () => void {
  const report = () => input.onChange(input.doc.visibilityState === "hidden");
  report();
  input.doc.addEventListener("visibilitychange", report);
  return () => input.doc.removeEventListener("visibilitychange", report);
}

export function useElementVisible(
  ref: RefObject<Element | null>,
  options: { readonly rootMargin?: string } = {},
): { readonly intersecting: boolean; readonly documentHidden: boolean } {
  const { rootMargin } = options;
  const [intersecting, setIntersecting] = useState(true);
  const [documentHidden, setDocumentHidden] = useState(
    () => typeof document !== "undefined" && document.visibilityState === "hidden",
  );

  useEffect(() => {
    if (typeof document === "undefined") return;
    return observeDocumentHidden({ doc: document, onChange: setDocumentHidden });
  }, []);

  useEffect(() => {
    const element = ref.current;
    if (element === null) return;
    return observeElementVisibility({
      element,
      onChange: setIntersecting,
      ...(rootMargin === undefined ? {} : { rootMargin }),
    });
  }, [ref, rootMargin]);

  // Returned apart rather than pre-combined: the caller decides what each one
  // means, and "off-screen" and "backgrounded tab" are different sentences to
  // show a captain even though both end in the same detach.
  return { intersecting, documentHidden };
}
