import { assert, describe, it } from "@effect/vitest";

import type { AdeBotScreen, BotId } from "@shuv2code/contracts";

import {
  deleteVolumeWorkaroundFor,
  getBotScreenView,
  resolveRfbConstructor,
  viewerSocketUrl,
} from "./BotScreenTab.logic";

describe("resolveRfbConstructor", () => {
  class Rfb {}

  it("accepts the dev-server interop shape ({ default: RFB })", () => {
    assert.strictEqual(resolveRfbConstructor({ default: Rfb }), Rfb);
  });

  it("accepts the production-bundle shape (default is the raw CJS exports object)", () => {
    // The built app hands the dynamic import `module.exports` verbatim; this
    // shape is what produced "s is not a constructor" in a packaged server.
    assert.strictEqual(resolveRfbConstructor({ default: { __esModule: true, default: Rfb } }), Rfb);
  });

  it("accepts a bare constructor", () => {
    assert.strictEqual(resolveRfbConstructor(Rfb), Rfb);
  });

  it("returns null rather than a non-callable for anything else", () => {
    assert.isNull(resolveRfbConstructor({ default: { __esModule: true } }));
    assert.isNull(resolveRfbConstructor(undefined));
    assert.isNull(resolveRfbConstructor("rfb"));
  });
});

const screen = (overrides: Partial<AdeBotScreen> = {}): AdeBotScreen =>
  ({
    botId: "bot-a" as BotId,
    status: "none",
    computerUse: true,
    viewers: 0,
    lastNeededAt: null,
    viewerPath: null,
    screenboxConfigured: true,
    ...overrides,
  }) as AdeBotScreen;

describe("getBotScreenView", () => {
  it("offers Start but no viewer for a bot that has never had a desktop", () => {
    const view = getBotScreenView(screen());
    assert.strictEqual(view.phase, "not-started");
    assert.isTrue(view.canStart);
    assert.isFalse(view.canStop);
    // The whole point of the tab's empty state: opening it must not connect.
    assert.isNull(view.viewerPath);
  });

  it("connects the viewer only once the server hands back a path", () => {
    const view = getBotScreenView(
      screen({ status: "running", viewerPath: "/ade/screen/bot-a", viewers: 1 }),
    );
    assert.strictEqual(view.phase, "live");
    assert.strictEqual(view.viewerPath, "/ade/screen/bot-a");
    assert.isTrue(view.canStop);
    assert.isFalse(view.canStart);
    assert.strictEqual(view.viewers, 1);
  });

  it("refuses to connect a running desktop the server gave no path for", () => {
    // Upstream lost the desktop between the status read and the port lookup.
    // Rendering a viewer here would open a socket the proxy answers with 409.
    const view = getBotScreenView(screen({ status: "running", viewerPath: null }));
    assert.strictEqual(view.phase, "live");
    assert.isNull(view.viewerPath);
  });

  it("explains a host with no Screenbox instead of offering Start", () => {
    const view = getBotScreenView(screen({ screenboxConfigured: false }));
    assert.strictEqual(view.phase, "unavailable");
    assert.isFalse(view.canStart);
    assert.isFalse(view.canStop);
  });

  it("tells the captain to enable computer use before a desktop can exist", () => {
    const view = getBotScreenView(screen({ computerUse: false }));
    assert.strictEqual(view.phase, "disabled");
    assert.isFalse(view.canStart);
    assert.include(view.detail, "computer use");
  });

  it("keeps Stop reachable for a running desktop whose computer use was turned off", () => {
    // Otherwise flipping the toggle would strand a live container with no way
    // to shut it down from the UI.
    const view = getBotScreenView(
      screen({ computerUse: false, status: "running", viewerPath: "/ade/screen/bot-a" }),
    );
    assert.strictEqual(view.phase, "live");
    assert.isTrue(view.canStop);
  });

  it("offers Start again for a stopped desktop and says its data survived", () => {
    const view = getBotScreenView(screen({ status: "stopped" }));
    assert.strictEqual(view.phase, "stopped");
    assert.isTrue(view.canStart);
    assert.isFalse(view.canStop);
    assert.isNull(view.viewerPath);
  });

  it("lets a failed provision be retried", () => {
    const view = getBotScreenView(screen({ status: "failed" }));
    assert.strictEqual(view.phase, "failed");
    assert.isTrue(view.canStart);
  });

  it("shows a starting desktop as stoppable but not yet viewable", () => {
    const view = getBotScreenView(screen({ status: "provisioning" }));
    assert.strictEqual(view.phase, "starting");
    assert.isNull(view.viewerPath);
    assert.isFalse(view.canStart);
    assert.isTrue(view.canStop);
  });
});

describe("viewerSocketUrl", () => {
  it("carries the upgrade ticket on the page's own origin", () => {
    // The ticket is not optional: a WebSocket cannot send an Authorization
    // header, so without it every client that is not a plain cookie-bearing
    // browser tab is refused with a 401 the viewer cannot explain.
    assert.strictEqual(
      viewerSocketUrl({
        pageOrigin: "http://localhost:5173",
        viewerPath: "/ade/screen/bot-a",
        wsTicket: "tkt-1",
      }),
      "ws://localhost:5173/ade/screen/bot-a?wsTicket=tkt-1",
    );
  });

  it("upgrades to wss on a secure page", () => {
    assert.strictEqual(
      viewerSocketUrl({
        pageOrigin: "https://box.example:8228",
        viewerPath: "/ade/screen/bot-a",
        wsTicket: "tkt-1",
      }),
      "wss://box.example:8228/ade/screen/bot-a?wsTicket=tkt-1",
    );
  });

  it("escapes a ticket that would otherwise break out of the query", () => {
    const url = new URL(
      viewerSocketUrl({
        pageOrigin: "https://box.example",
        viewerPath: "/ade/screen/bot-a",
        wsTicket: "a&b=c d",
      }),
    );
    assert.strictEqual(url.searchParams.get("wsTicket"), "a&b=c d");
  });

  it("cannot be pointed at another host by the path", () => {
    // Even a fully-qualified path resolves against the page origin, so a
    // server bug cannot send the captain's keystrokes somewhere else.
    const url = new URL(
      viewerSocketUrl({
        pageOrigin: "https://box.example",
        viewerPath: "/ade/screen/bot%2Fa",
        wsTicket: "tkt-1",
      }),
    );
    assert.strictEqual(url.host, "box.example");
    assert.strictEqual(url.pathname, "/ade/screen/bot%2Fa");
  });
});

describe("deleteVolumeWorkaroundFor", () => {
  it("names the volume upstream leaks so the captain can remove it by hand", () => {
    assert.strictEqual(
      deleteVolumeWorkaroundFor("bot-a"),
      "docker volume rm -f screenbox-bot-a-home",
    );
  });
});
