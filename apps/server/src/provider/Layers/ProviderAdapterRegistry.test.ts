import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ServerProvider,
} from "@shuv2code/contracts";
import { it, assert, vi } from "@effect/vitest";

import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import type * as CodexAdapter from "../Services/CodexAdapter.ts";
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "../Services/ProviderAdapterRegistry.ts";
import * as ProviderInstanceRegistry from "../Services/ProviderInstanceRegistry.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import type * as TextGeneration from "../../textGeneration/TextGeneration.ts";
import * as ProviderAdapterRegistryLayer from "./ProviderAdapterRegistry.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const OPENCODE_V2_DRIVER = ProviderDriverKind.make("opencodeV2");

const fakeCodexAdapter: CodexAdapter.CodexAdapterShape = {
  provider: CODEX_DRIVER,
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

const fakeOpenCodeV2Adapter: ProviderAdapterShape<ProviderAdapterError> = {
  provider: OPENCODE_V2_DRIVER,
  capabilities: { sessionModelSwitch: "in-session" },
  startSession: vi.fn(),
  sendTurn: vi.fn(),
  interruptTurn: vi.fn(),
  respondToRequest: vi.fn(),
  respondToUserInput: vi.fn(),
  stopSession: vi.fn(),
  listSessions: vi.fn(),
  hasSession: vi.fn(),
  readThread: vi.fn(),
  rollbackThread: vi.fn(),
  stopAll: vi.fn(),
  streamEvents: Stream.empty,
};

// ProviderAdapterRegistryLive is now a facade over ProviderInstanceRegistry —
// it walks `listInstances` once at boot and surfaces the default-instance
// adapter keyed by its driver kind. To test the facade we supply fake
// instances whose `instanceId === defaultInstanceIdForDriver(driverKind)` so
// they pass the default-instance filter.
const makeFakeInstance = (
  driverKindString: "codex" | "opencodeV2",
  adapter: ProviderInstance["adapter"],
): ProviderInstance => {
  const driverKind = ProviderDriverKind.make(driverKindString);
  return {
    instanceId: defaultInstanceIdForDriver(driverKind),
    driverKind,
    continuationIdentity: {
      driverKind,
      continuationKey: `${driverKind}:instance:${defaultInstanceIdForDriver(driverKind)}`,
    },
    displayName: undefined,
    enabled: true,
    snapshot: {
      maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
        provider: driverKind,
        packageName: null,
      }),
      getSnapshot: Effect.succeed({} as unknown as ServerProvider),
      refresh: Effect.succeed({} as unknown as ServerProvider),
      streamChanges: Stream.empty,
    },
    adapter,
    textGeneration: {} as unknown as TextGeneration.TextGeneration["Service"],
  };
};

const fakeInstances: ReadonlyArray<ProviderInstance> = [
  makeFakeInstance("codex", fakeCodexAdapter),
  makeFakeInstance("opencodeV2", fakeOpenCodeV2Adapter),
];

const fakeInstanceRegistryLayer = Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
  getInstance: (instanceId) =>
    Effect.succeed(fakeInstances.find((instance) => instance.instanceId === instanceId)),
  listInstances: Effect.succeed(fakeInstances),
  listUnavailable: Effect.succeed([]),
  streamChanges: Stream.empty,
  // Tests never drive changes through this fake; acquire a throwaway
  // subscription on an unused PubSub so the shape is satisfied.
  subscribeChanges: Effect.flatMap(PubSub.unbounded<void>(), (pubsub) => PubSub.subscribe(pubsub)),
});

const layer = Layer.mergeAll(
  Layer.provide(
    ProviderAdapterRegistryLayer.ProviderAdapterRegistryLive,
    fakeInstanceRegistryLayer,
  ),
  NodeServices.layer,
);

it.layer(layer)("ProviderAdapterRegistryLive", (it) => {
  it("resolves adapters and routing metadata from provider instances", () =>
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistry;
      const openCodeV2InstanceId = defaultInstanceIdForDriver(OPENCODE_V2_DRIVER);

      const adapter = yield* registry.getByInstance(openCodeV2InstanceId);
      assert.strictEqual(adapter, fakeOpenCodeV2Adapter);

      const info = yield* registry.getInstanceInfo(openCodeV2InstanceId);
      assert.deepStrictEqual(info, {
        instanceId: openCodeV2InstanceId,
        driverKind: OPENCODE_V2_DRIVER,
        displayName: undefined,
        accentColor: undefined,
        enabled: true,
        continuationIdentity: {
          driverKind: OPENCODE_V2_DRIVER,
          continuationKey: "opencodeV2:instance:opencodeV2",
        },
      });

      const instances = yield* registry.listInstances();
      assert.deepStrictEqual(instances, [
        defaultInstanceIdForDriver(CODEX_DRIVER),
        openCodeV2InstanceId,
      ]);

      const providers = yield* registry.listProviders();
      assert.deepStrictEqual(providers, [CODEX_DRIVER, OPENCODE_V2_DRIVER]);
    }));
});
