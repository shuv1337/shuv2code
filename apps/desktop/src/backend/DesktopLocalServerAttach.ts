import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

import { TrimmedNonEmptyString } from "@shuv2code/contracts";
import { waitForHttpReady } from "@shuv2code/shared/httpReadiness";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";

const BACKEND_READINESS_PATH = "/.well-known/shuv2code/environment";
const DEFAULT_ATTACH_PROBE_TIMEOUT = Duration.millis(175);
const DEFAULT_ATTACH_READINESS_TIMEOUT = Duration.millis(200);
const DEFAULT_ATTACH_RENDERER_TIMEOUT = Duration.millis(200);
const DEFAULT_ATTACH_DISCOVERY_TIMEOUT = Duration.millis(500);

const PersistedServerRuntimeState = Schema.Struct({
  version: Schema.Literal(1),
  pid: Schema.Int,
  host: Schema.optional(Schema.String),
  port: Schema.Int,
  origin: Schema.String,
  startedAt: Schema.String,
});

const PersistedLocalDesktopAttach = Schema.Struct({
  version: Schema.Literal(1),
  credential: TrimmedNonEmptyString,
});

const decodePersistedServerRuntimeState = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);
const decodePersistedLocalDesktopAttach = Schema.decodeUnknownEffect(
  Schema.fromJsonString(PersistedLocalDesktopAttach),
);

export interface DiscoveredLocalServer {
  readonly httpBaseUrl: URL;
  readonly port: number;
  readonly bootstrapToken: string;
  readonly origin: string;
}

class LocalServerReadinessProbeError extends Schema.TaggedErrorClass<LocalServerReadinessProbeError>()(
  "LocalServerReadinessProbeError",
  {
    origin: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const readJsonFileOptional = <A, E>(
  path: string,
  decode: (raw: string) => Effect.Effect<A, E>,
): Effect.Effect<Option.Option<A>, never, FileSystem.FileSystem> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const raw = yield* fs.readFileString(path).pipe(
      Effect.matchEffect({
        onFailure: (cause) =>
          cause.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.succeed(Option.none<string>()),
        onSuccess: (contents) => Effect.succeed(Option.some(contents)),
      }),
    );
    if (Option.isNone(raw)) return Option.none<A>();
    const trimmed = raw.value.trim();
    if (trimmed.length === 0) return Option.none<A>();
    return yield* decode(trimmed).pipe(
      Effect.map(Option.some),
      Effect.orElseSucceed(() => Option.none<A>()),
    );
  });

const probeReadyOrigin = (origin: string) =>
  waitForHttpReady({
    baseUrl: origin,
    path: BACKEND_READINESS_PATH,
    timeoutMs: Duration.toMillis(DEFAULT_ATTACH_READINESS_TIMEOUT),
    intervalMs: Duration.toMillis(DEFAULT_ATTACH_PROBE_TIMEOUT),
    probeTimeoutMs: Duration.toMillis(DEFAULT_ATTACH_PROBE_TIMEOUT),
    makeError: ({ cause }) => new LocalServerReadinessProbeError({ origin, cause }),
  }).pipe(
    Effect.as(true),
    Effect.orElseSucceed(() => false),
  );

const probeUsableRendererOrigin = Effect.fn("desktop.probeUsableRendererOrigin")(function* (
  origin: string,
) {
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.followRedirects());
  const response = yield* client.get(`${origin.replace(/\/$/, "")}/`).pipe(
    Effect.timeoutOption(DEFAULT_ATTACH_RENDERER_TIMEOUT),
    Effect.orElseSucceed(() => Option.none()),
  );
  return Option.exists(response, (value) => value.status >= 200 && value.status < 300);
});

const candidateOrigins = (input: {
  readonly configuredPort: Option.Option<number>;
  readonly runtimeOrigin: Option.Option<string>;
  readonly runtimePort: Option.Option<number>;
}): ReadonlyArray<string> => {
  const origins = new Set<string>();
  if (Option.isSome(input.runtimeOrigin)) {
    origins.add(input.runtimeOrigin.value.replace(/\/$/, ""));
  }
  const ports = new Set<number>();
  if (Option.isSome(input.configuredPort)) ports.add(input.configuredPort.value);
  if (Option.isSome(input.runtimePort)) ports.add(input.runtimePort.value);
  ports.add(3773);
  for (const port of ports) {
    origins.add(`http://127.0.0.1:${port}`);
    origins.add(`http://localhost:${port}`);
  }
  return [...origins];
};

const discoverReusableLocalServerUnbounded = Effect.fn(
  "desktop.discoverReusableLocalServerUnbounded",
)(function* (): Effect.fn.Return<
  Option.Option<DiscoveredLocalServer>,
  never,
  DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem | HttpClient.HttpClient
> {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const stateDirs = [
    ...new Set([
      environment.stateDir,
      environment.path.join(environment.baseDir, "userdata"),
      environment.path.join(environment.baseDir, "dev"),
    ]),
  ];

  const candidates: Array<{
    readonly origin: string;
    readonly bootstrapToken: string;
  }> = [];
  const seenOrigins = new Set<string>();
  for (const stateDir of stateDirs) {
    const attachPath = environment.path.join(stateDir, "local-desktop-attach.json");
    const runtimeStatePath = environment.path.join(stateDir, "server-runtime.json");
    const attach = yield* readJsonFileOptional(attachPath, decodePersistedLocalDesktopAttach);
    if (Option.isNone(attach)) continue;

    const runtime = yield* readJsonFileOptional(
      runtimeStatePath,
      decodePersistedServerRuntimeState,
    );
    for (const origin of candidateOrigins({
      configuredPort: environment.configuredBackendPort,
      runtimeOrigin: Option.map(runtime, (value) => value.origin),
      runtimePort: Option.map(runtime, (value) => value.port),
    })) {
      if (seenOrigins.has(origin)) continue;
      seenOrigins.add(origin);
      candidates.push({ origin, bootstrapToken: attach.value.credential });
    }
  }

  if (candidates.length === 0) return Option.none();
  const probeCandidate = Effect.fn("desktop.probeReusableLocalServerCandidate")(function* ({
    origin,
    bootstrapToken,
  }: (typeof candidates)[number]) {
    if (!(yield* probeReadyOrigin(origin))) return Option.none<DiscoveredLocalServer>();
    if (!(yield* probeUsableRendererOrigin(origin))) return Option.none<DiscoveredLocalServer>();
    const httpBaseUrl = new URL(origin.endsWith("/") ? origin : `${origin}/`);
    const port = Number(httpBaseUrl.port || (httpBaseUrl.protocol === "https:" ? 443 : 80));
    if (!Number.isFinite(port) || port <= 0) return Option.none<DiscoveredLocalServer>();
    return Option.some({
      httpBaseUrl,
      port,
      bootstrapToken,
      origin: httpBaseUrl.origin,
    } satisfies DiscoveredLocalServer);
  });
  const discoverByPriority = Effect.scoped(
    Effect.gen(function* () {
      const probes = [];
      for (const candidate of candidates) {
        probes.push(yield* Effect.forkScoped(probeCandidate(candidate)));
      }
      for (const probe of probes) {
        const result = yield* Fiber.join(probe);
        if (Option.isSome(result)) return result;
      }
      return Option.none<DiscoveredLocalServer>();
    }),
  );
  return yield* discoverByPriority;
});

export const discoverReusableLocalServer = Effect.fn("desktop.discoverReusableLocalServer")(
  function* (): Effect.fn.Return<
    Option.Option<DiscoveredLocalServer>,
    never,
    DesktopEnvironment.DesktopEnvironment | FileSystem.FileSystem | HttpClient.HttpClient
  > {
    const discovered = yield* discoverReusableLocalServerUnbounded().pipe(
      Effect.timeoutOption(DEFAULT_ATTACH_DISCOVERY_TIMEOUT),
    );
    return Option.flatten(discovered);
  },
);
