import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useState,
  type PropsWithChildren,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

import { VoiceSurface, type VoiceSurfaceProps } from "./VoiceSurface";
import { VoiceSurfacePortalMount } from "./VoiceSurfaceHost.logic";

interface VoiceSurfaceHostContextValue {
  readonly publishPresentation: (presentation: VoiceSurfaceProps) => void;
  readonly attachTarget: (target: HTMLDivElement) => void;
  readonly detachTarget: (target: HTMLDivElement) => void;
}

const VoiceSurfaceHostContext = createContext<VoiceSurfaceHostContextValue | null>(null);

/**
 * Owns one Voice presentation tree for the lifetime of the authenticated chat route.
 *
 * Right-panel inline and sheet hosts are presentation slots: they may disappear or
 * replace one another while a Call continues. The portal container itself never
 * changes, so moving it between those slots preserves the VoiceSurface, canvas,
 * WebGL context, and all presentation-local state.
 */
export function VoiceSurfaceHostProvider({ children }: PropsWithChildren) {
  const [presentation, setPresentation] = useState<VoiceSurfaceProps | null>(null);
  const [portalMount] = useState(() => {
    const container = document.createElement("div");
    container.className = "flex min-h-0 flex-1 flex-col";
    container.dataset.persistentVoiceSurfaceHost = "true";
    return new VoiceSurfacePortalMount(container);
  });

  const attachTarget = useCallback(
    (nextTarget: HTMLDivElement) => portalMount.attach(nextTarget),
    [portalMount],
  );
  const detachTarget = useCallback(
    (removedTarget: HTMLDivElement) => {
      if (!portalMount.detach(removedTarget)) return;
      setPresentation((current) =>
        current === null || current.presented === false
          ? current
          : { ...current, presented: false },
      );
    },
    [portalMount],
  );
  const publishPresentation = useCallback((nextPresentation: VoiceSurfaceProps) => {
    setPresentation(nextPresentation);
  }, []);

  useLayoutEffect(() => () => portalMount.dispose(), [portalMount]);

  const value = useMemo<VoiceSurfaceHostContextValue>(
    () => ({ publishPresentation, attachTarget, detachTarget }),
    [attachTarget, detachTarget, publishPresentation],
  );

  return (
    <VoiceSurfaceHostContext value={value}>
      {children}
      {presentation === null
        ? null
        : createPortal(<VoiceSurface {...presentation} />, portalMount.container)}
    </VoiceSurfaceHostContext>
  );
}

export function VoiceSurfaceHostSlot(props: {
  readonly presentation: VoiceSurfaceProps;
  readonly presented: boolean;
  readonly fallback?: ReactNode;
}) {
  const host = useContext(VoiceSurfaceHostContext);
  const [target, setTarget] = useState<HTMLDivElement | null>(null);

  useLayoutEffect(() => {
    if (host === null) return;
    host.publishPresentation({ ...props.presentation, presented: props.presented });
  }, [host, props.presentation, props.presented]);

  useLayoutEffect(() => {
    if (host === null || target === null) return;
    host.attachTarget(target);
    return () => host.detachTarget(target);
  }, [host, target]);

  if (host === null) {
    return props.fallback ?? <VoiceSurface {...props.presentation} presented={props.presented} />;
  }
  return <div ref={setTarget} className="flex min-h-0 flex-1 flex-col" data-voice-surface-slot />;
}
