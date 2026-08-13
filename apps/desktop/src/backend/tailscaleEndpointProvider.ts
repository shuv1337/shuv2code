import { createAdvertisedEndpoint } from "@shuv2code/shared/advertisedEndpoint";
import type { AdvertisedEndpoint, AdvertisedEndpointProvider } from "@shuv2code/contracts";
import {
  buildTailscaleHttpsBaseUrl,
  isTailscaleIpv4Address,
  parseTailscaleMagicDnsName,
  probeTailscaleHttpsEndpoint,
  readTailscaleStatus,
} from "@shuv2code/tailscale";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";

import type { NetworkInterfaces } from "./DesktopNetworkInterfaces.ts";

export { isTailscaleIpv4Address, parseTailscaleMagicDnsName } from "@shuv2code/tailscale";

const TAILSCALE_ENDPOINT_PROVIDER: AdvertisedEndpointProvider = {
  id: "tailscale",
  label: "Tailscale",
  kind: "private-network",
  isAddon: true,
};

function resolveTailscaleIpAdvertisedEndpoints(input: {
  readonly port: number;
  readonly networkInterfaces: NetworkInterfaces;
}): readonly AdvertisedEndpoint[] {
  const endpoints: AdvertisedEndpoint[] = [];

  for (const address of resolveTailscaleIpv4Addresses(input.networkInterfaces)) {
    endpoints.push(
      createAdvertisedEndpoint({
        provider: TAILSCALE_ENDPOINT_PROVIDER,
        source: "desktop-addon",
        id: `tailscale-ip:http://${address}:${input.port}`,
        label: "Tailscale IP",
        httpBaseUrl: `http://${address}:${input.port}`,
        reachability: "private-network",
        status: "available",
        description: "Reachable from devices on the same Tailnet.",
      }),
    );
  }

  return endpoints;
}

function resolveTailscaleIpv4Addresses(networkInterfaces: NetworkInterfaces): readonly string[] {
  const seen = new Set<string>();
  const addresses: string[] = [];

  for (const interfaceAddresses of Object.values(networkInterfaces)) {
    if (!interfaceAddresses) continue;

    for (const address of interfaceAddresses) {
      if (address.internal) continue;
      if (address.family !== "IPv4") continue;
      if (!isTailscaleIpv4Address(address.address)) continue;
      if (seen.has(address.address)) continue;
      seen.add(address.address);
      addresses.push(address.address);
    }
  }

  return addresses;
}

const normalizeTailscalePtrName = (hostname: string): string | null => {
  const normalized = hostname.trim().toLowerCase().replace(/\.$/u, "");
  return normalized.endsWith(".ts.net") ? normalized : null;
};

const resolveMagicDnsNameFromReverseDns = Effect.fn("resolveMagicDnsNameFromReverseDns")(
  function* (input: {
    readonly networkInterfaces: NetworkInterfaces;
    readonly reverseDnsLookup: (address: string) => Effect.Effect<readonly string[], never>;
  }) {
    for (const address of resolveTailscaleIpv4Addresses(input.networkInterfaces)) {
      const hostnames = yield* input.reverseDnsLookup(address);
      for (const hostname of hostnames) {
        const normalized = normalizeTailscalePtrName(hostname);
        if (normalized) return normalized;
      }
    }
    return null;
  },
);

const resolveTailscaleMagicDnsAdvertisedEndpoint = Effect.fn(
  "resolveTailscaleMagicDnsAdvertisedEndpoint",
)(function* (input: {
  readonly dnsName: string | null;
  readonly serveEnabled: boolean;
  readonly servePort?: number;
  readonly probe?: (baseUrl: string) => Effect.Effect<boolean, never, HttpClient.HttpClient>;
}): Effect.fn.Return<Option.Option<AdvertisedEndpoint>, never, HttpClient.HttpClient> {
  if (!input.dnsName) {
    return Option.none();
  }

  const httpBaseUrl = buildTailscaleHttpsBaseUrl({
    magicDnsName: input.dnsName,
    ...(input.servePort === undefined ? {} : { servePort: input.servePort }),
  });
  const probe =
    input.probe?.(httpBaseUrl) ??
    probeTailscaleHttpsEndpoint({
      baseUrl: httpBaseUrl,
    });
  const isReachable = input.serveEnabled ? yield* probe : false;

  return Option.some(
    createAdvertisedEndpoint({
      provider: TAILSCALE_ENDPOINT_PROVIDER,
      source: "desktop-addon",
      id: `tailscale-magicdns:${httpBaseUrl}`,
      label: "Tailscale HTTPS",
      httpBaseUrl,
      reachability: "private-network",
      hostedHttpsCompatibility: isReachable ? "compatible" : "requires-configuration",
      status: isReachable ? "available" : "unavailable",
      description: isReachable
        ? "HTTPS endpoint served by Tailscale Serve."
        : "MagicDNS hostname. Configure Tailscale Serve for HTTPS access.",
    }),
  );
});

export const resolveTailscaleAdvertisedEndpoints = Effect.fn("resolveTailscaleAdvertisedEndpoints")(
  function* (input: {
    readonly port: number;
    readonly serveEnabled?: boolean;
    readonly servePort?: number;
    readonly networkInterfaces: NetworkInterfaces;
    readonly statusJson?: string | null;
    readonly readMagicDnsName?: Effect.Effect<
      string | null,
      never,
      ChildProcessSpawner.ChildProcessSpawner
    >;
    readonly reverseDnsLookup?: (address: string) => Effect.Effect<readonly string[], never>;
    readonly probe?: (baseUrl: string) => Effect.Effect<boolean, never, HttpClient.HttpClient>;
  }): Effect.fn.Return<
    readonly AdvertisedEndpoint[],
    never,
    ChildProcessSpawner.ChildProcessSpawner | HttpClient.HttpClient
  > {
    const ipEndpoints = resolveTailscaleIpAdvertisedEndpoints(input);
    const readDnsName =
      input.readMagicDnsName ??
      readTailscaleStatus.pipe(
        Effect.map((status) => status.magicDnsName),
        Effect.orElseSucceed(() => null),
      );
    const commandDnsName =
      input.statusJson === undefined
        ? yield* readDnsName
        : input.statusJson
          ? yield* parseTailscaleMagicDnsName(input.statusJson).pipe(
              Effect.orElseSucceed(() => null),
            )
          : null;
    const dnsName =
      commandDnsName ??
      (input.reverseDnsLookup
        ? yield* resolveMagicDnsNameFromReverseDns({
            networkInterfaces: input.networkInterfaces,
            reverseDnsLookup: input.reverseDnsLookup,
          })
        : null);
    const magicDnsEndpoint = yield* resolveTailscaleMagicDnsAdvertisedEndpoint({
      dnsName,
      serveEnabled: input.serveEnabled === true,
      ...(input.servePort === undefined ? {} : { servePort: input.servePort }),
      ...(input.probe === undefined ? {} : { probe: input.probe }),
    });

    return Option.match(magicDnsEndpoint, {
      onNone: () => ipEndpoints,
      onSome: (endpoint) => [...ipEndpoints, endpoint],
    });
  },
);
