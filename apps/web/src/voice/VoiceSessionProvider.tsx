import {
  createRealtimeVoiceEnvironmentAtoms,
  initialRealtimeVoiceState,
  type RealtimeVoiceSessionState,
} from "@shuv2code/client-runtime/state/realtime-voice";
import type { EnvironmentId, ThreadId, VoiceControllerIdentity } from "@shuv2code/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import {
  VoiceSessionController,
  type StartVoiceSessionInput,
  type VoiceSessionControllerApi,
} from "./VoiceSessionController";

const realtimeVoiceEnvironment = createRealtimeVoiceEnvironmentAtoms(connectionAtomRuntime);

async function runVoiceCommand<Input, Output>(
  command: {
    readonly run: (
      registry: typeof appAtomRegistry,
      target: { readonly environmentId: EnvironmentId; readonly input: Input },
    ) => Promise<
      | { readonly _tag: "Success"; readonly value: Output }
      | { readonly _tag: "Failure"; readonly cause: Cause.Cause<unknown> }
    >;
  },
  environmentId: EnvironmentId,
  input: Input,
): Promise<Output> {
  const result = await command.run(appAtomRegistry, { environmentId, input });
  if (result._tag === "Success") {
    return result.value;
  }
  throw Cause.squash(result.cause);
}

const browserVoiceApi: VoiceSessionControllerApi = {
  ensureController: (environmentId, input) =>
    runVoiceCommand(realtimeVoiceEnvironment.ensureController, environmentId, input),
  listVoices: (environmentId, input) =>
    runVoiceCommand(realtimeVoiceEnvironment.listVoices, environmentId, input),
  start: (environmentId, input) =>
    runVoiceCommand(realtimeVoiceEnvironment.start, environmentId, input),
  ingestRealtimeEvent: (environmentId, input) =>
    runVoiceCommand(realtimeVoiceEnvironment.ingestRealtimeEvent, environmentId, input),
  stop: (environmentId, input) =>
    runVoiceCommand(realtimeVoiceEnvironment.stop, environmentId, input),
  subscribe: (environmentId, input, onEvent, onError) => {
    const atom = realtimeVoiceEnvironment.events({ environmentId, input });
    let lastSequence = -1;
    return appAtomRegistry.subscribe(atom, (result) => {
      if (AsyncResult.isSuccess(result)) {
        if (result.value.sequence > lastSequence) {
          lastSequence = result.value.sequence;
          onEvent(result.value);
        }
      } else if (result._tag === "Failure") {
        onError(Cause.squash(result.cause));
      }
    });
  },
};

interface VoiceSessionContextValue {
  readonly state: RealtimeVoiceSessionState;
  readonly getController: (environmentId: EnvironmentId) => Promise<VoiceControllerIdentity | null>;
  readonly resetController: (
    environmentId: EnvironmentId,
    controllerThreadId: ThreadId,
  ) => Promise<boolean>;
  readonly start: (input: StartVoiceSessionInput) => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly reconnect: () => Promise<void>;
  readonly setMuted: (muted: boolean) => void;
}

const VoiceSessionContext = createContext<VoiceSessionContextValue | null>(null);

export interface VoiceSessionProviderProps extends PropsWithChildren {
  readonly controller?: VoiceSessionController;
}

export function VoiceSessionProvider({
  children,
  controller: supplied,
}: VoiceSessionProviderProps) {
  const [controller] = useState(
    () => supplied ?? new VoiceSessionController({ api: browserVoiceApi }),
  );
  const subscribe = useCallback(
    (listener: () => void) => controller.subscribe(() => listener()),
    [controller],
  );
  const getSnapshot = useCallback(() => controller.state, [controller]);
  const state = useSyncExternalStore(subscribe, getSnapshot, () => initialRealtimeVoiceState);
  const getController = useCallback(
    async (environmentId: EnvironmentId) =>
      (await runVoiceCommand(realtimeVoiceEnvironment.getController, environmentId, {})).controller,
    [],
  );
  const resetController = useCallback(
    async (environmentId: EnvironmentId, controllerThreadId: ThreadId) => {
      if (controller.state.environmentId === environmentId) {
        await controller.stop();
      }
      return (
        await runVoiceCommand(realtimeVoiceEnvironment.resetController, environmentId, {
          controllerThreadId,
        })
      ).reset;
    },
    [controller],
  );
  const value = useMemo<VoiceSessionContextValue>(
    () => ({
      state,
      getController,
      resetController,
      start: (input) => controller.start(input),
      stop: () => controller.stop(),
      reconnect: () => controller.reconnect(),
      setMuted: (muted) => controller.setMuted(muted),
    }),
    [controller, getController, resetController, state],
  );
  useEffect(
    () => () => {
      void controller.stop();
    },
    [controller],
  );

  return <VoiceSessionContext value={value}>{children}</VoiceSessionContext>;
}

export function useVoiceSession(): VoiceSessionContextValue {
  const value = useContext(VoiceSessionContext);
  if (!value) {
    throw new Error("useVoiceSession must be used inside VoiceSessionProvider.");
  }
  return value;
}
