/**
 * Minimal typings for the vendored noVNC client (spec §4.6).
 *
 * `@novnc/novnc` ships Babel-transpiled CJS with no `types` and no `exports`
 * map, so the import path is the file path. Only the surface the Screen tab
 * actually uses is declared — a hand-written full transcription of noVNC's API
 * would rot silently against the real module, whereas a missing member here is
 * a compile error at the call site.
 *
 * Pinned to **1.5.0, not 1.6.0**: 1.6.0's `lib/util/browser.js` is CJS that
 * still contains a top-level `await` (an upstream packaging bug — CJS cannot
 * have one), which makes the production bundle fail to build with `REQUIRE_TLA`.
 * 1.5.0 carries the same `lib/rfb.js` entry and the same members declared here.
 */
declare module "@novnc/novnc/lib/rfb.js" {
  export interface RfbOptions {
    /** Extra query/handshake credentials. Unused: ADE's proxy is the auth. */
    readonly credentials?: { readonly password?: string };
    readonly shared?: boolean;
    readonly repeaterID?: string;
    readonly wsProtocols?: ReadonlyArray<string>;
  }

  export default class RFB extends EventTarget {
    constructor(target: HTMLElement, urlOrChannel: string | WebSocket, options?: RfbOptions);
    /** Scales the framebuffer to the container instead of clipping it. */
    scaleViewport: boolean;
    /** Asks the server to match the container's size when it supports it. */
    resizeSession: boolean;
    /** False makes the viewer read-only; the Screen tab keeps input on. */
    viewOnly: boolean;
    background: string;
    disconnect(): void;
    focus(): void;
    blur(): void;
  }
}
