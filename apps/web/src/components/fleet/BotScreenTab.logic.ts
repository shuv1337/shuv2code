/**
 * Pure view mapping for the bot detail Screen tab (spec §4.6).
 *
 * The rule this file exists to enforce: **viewing never spawns a desktop.**
 * The viewer connects only when the server has already said a desktop is
 * running and handed back a `viewerPath`; every other state renders an
 * explanation and, where it makes sense, a Start button the captain must press.
 */
import type { AdeBotScreen } from "@shuv2code/contracts";

/**
 * Operator workaround for a known upstream defect, surfaced in the delete
 * confirmation rather than buried in a server log.
 *
 * Screenbox's `delete-data` answers `{"deleted": true}` even when removing the
 * desktop's home volume failed: its docker-proxy whitelist has no
 * `DELETE /volumes` route. shuv2code deliberately makes no docker calls of its
 * own, so a captain who needs the disk back has to run this on the Screenbox
 * host. Telling them at the moment they confirm is the only honest place —
 * afterwards there is no bot left to hang the warning on.
 */
export const deleteVolumeWorkaroundFor = (botId: string): string =>
  `docker volume rm -f screenbox-${botId}-home`;

export const DELETE_VOLUME_WORKAROUND_NOTE =
  "Screenbox reports success even when it cannot remove the desktop's home volume. If you need the disk space back, run this on the Screenbox host afterwards:";

/** Endpoint that mints the short-lived ticket a WebSocket upgrade carries. */
export const WEBSOCKET_TICKET_PATH = "/api/auth/websocket-ticket";

/**
 * Picks the RFB class out of a dynamically imported `@novnc/novnc/lib/rfb.js`.
 *
 * noVNC ships Babel CJS (`exports.default = RFB` + `__esModule`). The dev
 * server interops that into `{ default: RFB }`, but the production bundler
 * hands the dynamic import the raw `module.exports` object as `default`, so
 * `new mod.default(...)` throws "is not a constructor" in a built app while
 * working in dev. Accept every shape the two pipelines produce.
 */
export function resolveRfbConstructor(mod: unknown): unknown {
  const record = (value: unknown): Record<string, unknown> | null =>
    typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
  if (typeof mod === "function") return mod;
  const top = record(mod);
  if (top === null) return null;
  if (typeof top.default === "function") return top.default;
  const nested = record(top.default);
  if (nested !== null && typeof nested.default === "function") return nested.default;
  return null;
}

/**
 * Turns the server-issued viewer path into the WebSocket URL noVNC opens.
 *
 * Same-origin by construction: ADE is a primary-environment-only surface and
 * the primary environment is the server that served this page. Building the URL
 * from an origin the server did not name is what this signature is shaped to
 * prevent — the path always comes from `AdeBotScreen.viewerPath`, never from
 * the client.
 *
 * The `wsTicket` is not optional. A browser cannot set an `Authorization`
 * header on a WebSocket, so header-bearing clients (the desktop app, anything
 * on a bearer or DPoP token) have no way to authenticate an upgrade *except*
 * this query parameter — the RPC socket at `/ws` carries one for exactly that
 * reason. Relying on the session cookie alone works only in a plain browser
 * tab and fails silently with a 401 everywhere else.
 */
export function viewerSocketUrl(input: {
  readonly pageOrigin: string;
  readonly viewerPath: string;
  readonly wsTicket: string;
}): string {
  const url = new URL(input.viewerPath, input.pageOrigin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.searchParams.set("wsTicket", input.wsTicket);
  return url.toString();
}

/*
 * The phase machine moved to `@shuv2code/client-runtime/ade/bot-screen` so the
 * mobile fleet surface reads the same phases and the same poster copy. Only the
 * browser half — the RFB interop shim and the WebSocket URL noVNC opens — stays
 * here, because only a browser has a canvas to draw into.
 */
export {
  botScreenPanelTitle,
  getBotScreenPanelView,
  getBotScreenView,
  type BotScreenPanelView,
  type BotScreenPhase,
  type BotScreenView,
} from "@shuv2code/client-runtime/ade/bot-screen";
