import * as ManagedRuntime from "effect/ManagedRuntime";
import type * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as HttpClient from "effect/unstable/http/HttpClient";
import * as Socket from "effect/unstable/socket/Socket";

import { remoteHttpClientLayer } from "@shuv2code/client-runtime/rpc";
import { makeRelayClientTracingLayer } from "@shuv2code/shared/relayTracing";
import * as PrimaryEnvironmentHttpClient from "../environments/primary/httpClient";
import { primaryEnvironmentHttpLayer } from "../environments/primary/httpLayer";

import { browserCryptoLayer } from "../cloud/dpop";
import { managedRelayClientLayer } from "../cloud/managedRelayLayer";
import { resolveCloudPublicConfig, resolveRelayTracingConfig } from "../cloud/publicConfig";

function configuredRelayUrl(): string {
  return resolveCloudPublicConfig().relayUrl ?? "http://relay.invalid";
}

const httpClientLayer = remoteHttpClientLayer((input, init) => globalThis.fetch(input, init));
const relayTracingLayer = makeRelayClientTracingLayer(resolveRelayTracingConfig(), {
  serviceName: "shuv2code-web-relay-client",
  serviceVersion: import.meta.env.APP_VERSION,
  runtime: "browser",
  client: typeof window !== "undefined" && window.desktopBridge ? "desktop" : "web",
}).pipe(Layer.provide(httpClientLayer));

type RuntimeLayerSource =
  | typeof httpClientLayer
  | typeof browserCryptoLayer
  | typeof Socket.layerWebSocketConstructorGlobal
  | typeof relayTracingLayer
  | ReturnType<typeof managedRelayClientLayer>;

export const remoteHttpRuntime = ManagedRuntime.make(httpClientLayer);

const primaryHttpRuntime = ManagedRuntime.make(
  PrimaryEnvironmentHttpClient.layer.pipe(Layer.provide(primaryEnvironmentHttpLayer)),
);
const primaryRawHttpRuntime = ManagedRuntime.make(primaryEnvironmentHttpLayer);

export type PrimaryHttpEffectRunner = <A, E>(
  effect: Effect.Effect<A, E, PrimaryEnvironmentHttpClient.PrimaryEnvironmentHttpClient>,
) => Promise<A>;

const livePrimaryHttpRunner: PrimaryHttpEffectRunner = (effect) =>
  primaryHttpRuntime.runPromise(effect);

let primaryHttpRunner = livePrimaryHttpRunner;

export const runPrimaryHttp = <A, E>(
  effect: Effect.Effect<A, E, PrimaryEnvironmentHttpClient.PrimaryEnvironmentHttpClient>,
) => primaryHttpRunner(effect);

export const runPrimaryRawHttp = <A, E>(
  effect: Effect.Effect<A, E, HttpClient.HttpClient>,
  options?: Effect.RunOptions,
) => primaryRawHttpRuntime.runPromise(effect, options);

export function __setPrimaryHttpRunnerForTests(runner?: PrimaryHttpEffectRunner): void {
  primaryHttpRunner = runner ?? livePrimaryHttpRunner;
}

const runtimeLayer = Layer.mergeAll(
  httpClientLayer,
  browserCryptoLayer,
  Socket.layerWebSocketConstructorGlobal,
  relayTracingLayer,
  managedRelayClientLayer(configuredRelayUrl()).pipe(
    Layer.provide(Layer.mergeAll(httpClientLayer, browserCryptoLayer)),
  ),
);

export const runtime: ManagedRuntime.ManagedRuntime<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = ManagedRuntime.make(runtimeLayer);

export const runtimeContextLayer: Layer.Layer<
  Layer.Success<RuntimeLayerSource>,
  Layer.Error<RuntimeLayerSource>
> = Layer.effectContext(runtime.contextEffect);
