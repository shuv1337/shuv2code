/**
 * ADE's WS→VNC viewer proxy (spec §4.6).
 *
 * The captain's browser never talks to Screenbox. It opens a WebSocket at
 * `/ade/screen/<botId>` on the ADE server's own origin; this route
 * authenticates that upgrade against the captain session, resolves the bot's
 * desktop to a loopback RFB port, and relays bytes in both directions. noVNC
 * on the other end speaks plain RFB over the socket, so the relay is a byte
 * pipe with no framing of its own.
 *
 * Three properties this module exists to guarantee:
 *
 * - **The upstream dashboard and the raw VNC ports are never reachable from a
 *   browser.** Ports bind to 127.0.0.1 on the Screenbox host and the target is
 *   resolved server-side from `botId`; a client cannot name a host, a port, or
 *   another bot's desktop.
 * - **Viewing never spawns.** The route only ever *reads* the desktop's
 *   address. A bot with no desktop, or with a stopped one, gets a refusal —
 *   never an implicit provision. Starting is an explicit captain action.
 * - **Viewer presence feeds the idle policy.** Attachment is bracketed around
 *   the socket's whole lifetime, so a watched desktop is not idle-stopped and
 *   a closed tab releases its hold even if the client vanished mid-frame.
 */
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Socket from "effect/unstable/socket/Socket";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
  HttpServerRespondable,
} from "effect/unstable/http";
import * as net from "node:net";

import { AuthOrchestrationOperateScope, type BotId } from "@shuv2code/contracts";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "../auth/http.ts";
import {
  AdeScreenboxRuntime,
  type AdeScreenboxRuntimeShape,
  type AdeScreenboxViewerTarget,
} from "./AdeScreenbox.ts";

/** Route prefix for the viewer proxy. One socket per bot, botId in the path. */
export const ADE_SCREEN_VIEWER_PREFIX = "/ade/screen";

/**
 * Extracts the botId from a viewer request path, or null when the path is not
 * a viewer request at all.
 *
 * Registered as a wildcard route, so this is the only thing standing between a
 * URL and a desktop lookup. It rejects nested and empty segments outright:
 * `/ade/screen/a/b` must not resolve to bot `a`, and `/ade/screen/` must not
 * resolve to the empty bot.
 */
export const screenViewerBotIdFromPath = (pathname: string): string | null => {
  if (!pathname.startsWith(`${ADE_SCREEN_VIEWER_PREFIX}/`)) return null;
  const suffix = pathname.slice(ADE_SCREEN_VIEWER_PREFIX.length + 1);
  if (suffix.length === 0 || suffix.includes("/")) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(suffix);
  } catch {
    // A malformed percent-escape is a malformed request, not bot "%zz".
    return null;
  }
  const trimmed = decoded.trim();
  return trimmed.length === 0 ? null : trimmed;
};

/** The viewer path the client should open for a bot. Server-authored only. */
export const screenViewerPathFor = (botId: BotId): string =>
  `${ADE_SCREEN_VIEWER_PREFIX}/${encodeURIComponent(botId)}`;

/**
 * Buffered RFB chunks in flight from the desktop toward the viewer.
 *
 * Small on purpose: a viewer that stops reading (a backgrounded tab, a stalled
 * network) must push back onto the desktop's socket rather than let the server
 * accumulate framebuffer updates. Overflow pauses the upstream read; it never
 * drops a chunk, because RFB is a stream and a dropped chunk desynchronizes
 * the protocol permanently.
 */
const VIEWER_QUEUE_CAPACITY = 64;

/** Opens the loopback RFB connection, closed with the enclosing scope. */
const connectToDesktop = (
  target: AdeScreenboxViewerTarget,
): Effect.Effect<net.Socket, Socket.SocketError, Scope.Scope> =>
  Effect.acquireRelease(
    Effect.callback<net.Socket, Socket.SocketError>((resume) => {
      const connection = net.connect({ host: target.host, port: target.port });
      const onConnect = (): void => {
        connection.off("error", onError);
        resume(Effect.succeed(connection));
      };
      const onError = (cause: Error): void => {
        connection.off("connect", onConnect);
        connection.destroy();
        resume(
          Effect.fail(
            new Socket.SocketError({
              reason: new Socket.SocketOpenError({ kind: "Unknown", cause }),
            }),
          ),
        );
      };
      connection.once("connect", onConnect);
      connection.once("error", onError);
      return Effect.sync(() => {
        connection.destroy();
      });
    }),
    (connection) =>
      Effect.sync(() => {
        connection.destroy();
      }),
  );

/**
 * Pipes an upgraded viewer socket to a desktop's RFB socket until either end
 * closes. Exported so the relay can be exercised against a real TCP server
 * without standing up authentication or a Screenbox.
 */
export const relayViewerToDesktop = (
  viewer: Socket.Socket,
  target: AdeScreenboxViewerTarget,
): Effect.Effect<void, Socket.SocketError, Scope.Scope> =>
  Effect.gen(function* () {
    const desktop = yield* connectToDesktop(target);
    const writeToViewer = yield* viewer.writer;
    const fromDesktop = yield* Queue.bounded<Uint8Array, Cause.Done>(VIEWER_QUEUE_CAPACITY);
    // Resuming a paused read is a plain queue offer with no service needs, but
    // fork it from the enclosing context so it stays inside this request's
    // fiber tree and dies with the socket instead of outliving it.
    const runResume = Effect.runForkWith(yield* Effect.context<never>());

    desktop.on("data", (chunk: Buffer) => {
      // Copy: Node hands out slices of a pooled buffer and reuses the memory as
      // soon as this handler returns, so queueing the view would corrupt frames
      // under any backpressure at all.
      const bytes = Uint8Array.from(chunk);
      if (Queue.offerUnsafe(fromDesktop, bytes)) return;
      // The viewer is behind. Stop reading the desktop until it catches up
      // rather than buffering an unbounded framebuffer backlog in the server.
      desktop.pause();
      runResume(
        Queue.offer(fromDesktop, bytes).pipe(
          Effect.andThen(
            Effect.sync(() => {
              desktop.resume();
            }),
          ),
        ),
      );
    });
    const endQueue = (): void => {
      Queue.endUnsafe(fromDesktop);
    };
    desktop.once("end", endQueue);
    desktop.once("close", endQueue);
    desktop.once("error", endQueue);

    const pumpToViewer: Effect.Effect<void, Socket.SocketError> = Queue.take(fromDesktop).pipe(
      Effect.flatMap(writeToViewer),
      Effect.forever,
      // `Done` is the desktop hanging up, which is an ordinary end of session
      // rather than a failure to propagate to the captain.
      Effect.catchTag("Done", () => Effect.void),
    );

    const pumpToDesktop = viewer.run((chunk) =>
      Effect.callback<void>((resume) => {
        desktop.write(chunk, () => {
          resume(Effect.void);
        });
      }),
    );

    // Either direction ending ends the session: a half-open RFB stream is not
    // recoverable, and leaving the other pump running would hold the desktop
    // against the idle sweep with nobody watching.
    yield* Effect.raceAll([pumpToViewer, pumpToDesktop]);
  });

/**
 * What the route should do with one viewer request, decided before anything is
 * upgraded or dialled.
 */
export type AdeScreenViewerDecision =
  /** Session lacks the operate scope; nothing about the bot is disclosed. */
  | { readonly _tag: "forbidden" }
  /** The path does not name a bot. */
  | { readonly _tag: "not-found" }
  /** The bot has no viewable desktop right now. */
  | { readonly _tag: "unavailable"; readonly botId: BotId; readonly reason: string }
  | { readonly _tag: "relay"; readonly botId: BotId; readonly target: AdeScreenboxViewerTarget };

/**
 * Decides one viewer request, given an already-authenticated session.
 *
 * Split out from the route so the ordering rules can be tested without an HTTP
 * server: authentication happens in the route *before* this runs, and the
 * scope check here happens before any desktop lookup — otherwise a caller
 * could map which bots have live desktops by diffing 403 against 409.
 */
export const decideScreenViewerRequest = (input: {
  readonly scopes: ReadonlyArray<string>;
  readonly pathname: string;
  readonly screenbox: Pick<AdeScreenboxRuntimeShape, "viewerTargetFor">;
}): Effect.Effect<AdeScreenViewerDecision> =>
  Effect.gen(function* () {
    // The relay is bidirectional: keyboard and pointer input reach a real
    // desktop through it. That is an operate capability, not a read one, so a
    // read-only token is refused even though "viewing" sounds passive.
    if (!input.scopes.includes(AuthOrchestrationOperateScope)) {
      return { _tag: "forbidden" } as const;
    }
    const botId = screenViewerBotIdFromPath(input.pathname);
    if (botId === null) return { _tag: "not-found" } as const;

    const target = yield* input.screenbox.viewerTargetFor(botId as BotId).pipe(Effect.result);
    if (target._tag === "Failure") {
      return {
        _tag: "unavailable",
        botId: botId as BotId,
        reason: target.failure.reason,
      } as const;
    }
    return { _tag: "relay", botId: botId as BotId, target: target.success } as const;
  });

/**
 * The viewer proxy route.
 *
 * Registered separately from the RPC socket so the RPC group's handler graph
 * stays untouched, but it authenticates through exactly the same
 * `authenticateWebSocketUpgrade` path — a browser cannot set headers on a
 * WebSocket, so both routes carry the captain's short-lived `wsTicket`.
 */
export const adeScreenViewerRouteLayer = HttpRouter.add(
  "GET",
  `${ADE_SCREEN_VIEWER_PREFIX}/*`,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const serverAuth = yield* EnvironmentAuth.EnvironmentAuth;
    const screenbox = yield* AdeScreenboxRuntime;

    // Authenticate *before* looking anything up. An unauthenticated caller must
    // not be able to probe which bots have desktops by reading status codes.
    const session = yield* serverAuth.authenticateWebSocketUpgrade(request).pipe(
      Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
        failEnvironmentAuthInvalid(EnvironmentAuth.serverAuthCredentialReason(error)),
      ),
      Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
        failEnvironmentInternal("internal_error", error),
      ),
    );

    const decision = yield* decideScreenViewerRequest({
      scopes: session.scopes,
      pathname: new URL(request.url, "http://localhost").pathname,
      screenbox,
    });
    if (decision._tag === "forbidden") return HttpServerResponse.empty({ status: 403 });
    if (decision._tag === "not-found") return HttpServerResponse.empty({ status: 404 });
    if (decision._tag === "unavailable") {
      yield* Effect.logDebug("ADE screen viewer refused", {
        botId: decision.botId,
        reason: decision.reason,
      });
      // 409, not 404: the bot exists and the captain may view it — there is
      // just no running desktop yet. The Screen tab reads this as "press Start"
      // rather than "this bot is gone".
      return HttpServerResponse.empty({ status: 409 });
    }
    const botId = decision.botId;

    const socket = yield* Effect.orDie(request.upgrade);
    // Presence is bracketed around the socket's entire life, so an abandoned
    // tab or a dropped connection still releases the desktop to the idle sweep.
    yield* Effect.acquireUseRelease(
      screenbox.viewerAttached(botId),
      () =>
        relayViewerToDesktop(socket, decision.target).pipe(
          Effect.catchCause((cause) =>
            Effect.logDebug("ADE screen viewer relay ended", { botId, cause }),
          ),
        ),
      () => screenbox.viewerDetached(botId),
    ).pipe(Effect.scoped);
    return HttpServerResponse.empty();
  }).pipe(
    Effect.catchTags({
      EnvironmentAuthInvalidError: HttpServerRespondable.toResponse,
      EnvironmentInternalError: HttpServerRespondable.toResponse,
    }),
  ),
);
