import { WS_METHODS, type EnvironmentId, type ProjectId } from "@shuv2code/contracts";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
} from "./runtime.ts";

export function createAutomationEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const scheduler = createAtomCommandScheduler();
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:automations:list",
    tag: WS_METHODS.automationsList,
    staleTimeMs: 2_000,
    refreshIntervalMs: 5_000,
  });
  const runs = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:automations:runs",
    tag: WS_METHODS.automationsListRuns,
    staleTimeMs: 1_000,
    refreshIntervalMs: 3_000,
  });

  const refreshProject = (
    target: {
      readonly environmentId: EnvironmentId;
      readonly input: { readonly projectId: ProjectId };
    },
    registry: AtomRegistry.AtomRegistry,
  ) =>
    Effect.sync(() => {
      registry.refresh(
        list({ environmentId: target.environmentId, input: { projectId: target.input.projectId } }),
      );
    });

  return {
    list,
    runs,
    validateSchedule: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automations:validate-schedule",
      tag: WS_METHODS.automationsValidateSchedule,
      scheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId }) => environmentId,
      },
    }),
    create: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automations:create",
      tag: WS_METHODS.automationsCreate,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.projectId}`,
      },
      onSettled: refreshProject,
    }),
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automations:update",
      tag: WS_METHODS.automationsUpdate,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.automationId}`,
      },
      onSettled: refreshProject,
    }),
    delete: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automations:delete",
      tag: WS_METHODS.automationsDelete,
      scheduler,
      concurrency: {
        mode: "serial",
        key: ({ environmentId, input }) => `${environmentId}:${input.automationId}`,
      },
      onSettled: refreshProject,
    }),
    runNow: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:automations:run-now",
      tag: WS_METHODS.automationsRunNow,
      scheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) => `${environmentId}:${input.automationId}`,
      },
      onSettled: (target, registry) =>
        refreshProject(target, registry).pipe(
          Effect.andThen(
            Effect.sync(() => {
              registry.refresh(
                runs({
                  environmentId: target.environmentId,
                  input: {
                    projectId: target.input.projectId,
                    automationId: target.input.automationId,
                    limit: 50,
                  },
                }),
              );
            }),
          ),
        ),
    }),
  };
}
