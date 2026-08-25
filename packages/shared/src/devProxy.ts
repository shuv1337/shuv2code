/**
 * Backend paths the web dev server proxies in single-origin browser dev.
 *
 * Two consumers must agree on this list: the Vite proxy map
 * (apps/web/vite.config.ts) that forwards these to the backend, and the
 * server's dev catch-all (apps/server/src/http.ts) that 404s them instead of
 * redirecting back to Vite. Drift is silent and nasty in both directions — a
 * prefix only Vite knows gets answered with index.html; a prefix only the
 * server knows redirect-loops through the proxy.
 */
export const DEV_PROXIED_PATH_PREFIXES = [
  "/api",
  "/oauth",
  "/.well-known",
  "/ws",
  /** ADE's WS→VNC viewer proxy (spec §4.6); an upgrade like `/ws`. */
  "/ade/screen",
] as const;

/**
 * Prefixes whose proxy entry must carry `ws: true`. These are WebSocket
 * upgrades, not request/response paths — without this the dev proxy answers the
 * upgrade with HTML and the socket never reaches the backend.
 */
export const DEV_PROXIED_WEBSOCKET_PREFIXES: ReadonlySet<string> = new Set(["/ws", "/ade/screen"]);

export function isDevProxiedPath(pathname: string): boolean {
  return DEV_PROXIED_PATH_PREFIXES.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
