import { assert, describe, it } from "@effect/vitest";

import { isLoopbackScreenboxOrigin, parseDesktopList } from "./AdeScreenboxClient.ts";
import { isPlausibleDesktopPort } from "./AdeScreenbox.ts";
import { escapeLikePattern } from "./AdeCaptainApi.ts";

describe("isLoopbackScreenboxOrigin", () => {
  it("accepts the loopback forms an operator actually configures", () => {
    for (const origin of [
      "http://127.0.0.1:8080",
      "http://localhost:8080",
      "http://LocalHost:8080",
      "https://127.0.0.1",
      // The whole 127.0.0.0/8 block, not just .1.
      "http://127.1.2.3:9000",
      "http://[::1]:8080",
    ]) {
      assert.isTrue(isLoopbackScreenboxOrigin(origin), origin);
    }
  });

  it("rejects anything off-box", () => {
    for (const origin of [
      "https://screenbox.example.com",
      "http://10.0.0.5:8080",
      "http://192.168.1.10:8080",
      // Close enough to fool a naive prefix check, and not loopback.
      "http://127.0.0.1.evil.com",
      "http://1270.0.0.1",
      "http://0.0.0.0:8080",
      "not a url",
      null,
    ]) {
      assert.isFalse(isLoopbackScreenboxOrigin(origin), String(origin));
    }
  });
});

describe("isPlausibleDesktopPort", () => {
  const none: ReadonlySet<number> = new Set();

  it("accepts a published container port", () => {
    assert.isTrue(isPlausibleDesktopPort(16081, none));
  });

  it("rejects privileged, out-of-range, and non-integer ports", () => {
    for (const port of [0, 22, 80, 443, 1023, 65536, 1.5, Number.NaN]) {
      assert.isFalse(isPlausibleDesktopPort(port, none), String(port));
    }
  });

  it("rejects this server's own listener", () => {
    // Otherwise the proxy would splice a captain into ADE's own HTTP/WS port.
    assert.isFalse(isPlausibleDesktopPort(4096, new Set([4096])));
    assert.isTrue(isPlausibleDesktopPort(4097, new Set([4096])));
  });
});

describe("parseDesktopList", () => {
  it("reads vnc_port and ignores the RDP siblings upstream also reports", () => {
    // Verbatim shape from the live service: `rdp_port` and `novnc_port` are the
    // same port, and it speaks RDP — only `vnc_port` is an RFB endpoint.
    const parsed = parseDesktopList([
      { id: "bot-a", state: "running", rdp_port: 16080, vnc_port: 16081, novnc_port: 16080 },
    ]);
    assert.deepStrictEqual(parsed, [{ desktopId: "bot-a", state: "running", vncPort: 16081 }]);
  });

  it("reports no port when upstream omits one for a stopped desktop", () => {
    const parsed = parseDesktopList([{ id: "bot-a", state: "stopped" }]);
    assert.strictEqual(parsed[0]?.vncPort, null);
  });

  it("refuses a port that is not a usable number", () => {
    for (const vnc_port of [0, -1, 70000, "nope", null, 1.5]) {
      const parsed = parseDesktopList([{ id: "bot-a", state: "running", vnc_port }]);
      assert.strictEqual(parsed[0]?.vncPort, null, String(vnc_port));
    }
  });
});

describe("escapeLikePattern", () => {
  it("escapes the metacharacters that would widen a LIKE", () => {
    // A `%` in an interpolated id would turn "this bot" into "any bot", which
    // on the Needs You sweep means resolving other bots' open items.
    assert.strictEqual(escapeLikePattern("bot%a"), "bot\\%a");
    assert.strictEqual(escapeLikePattern("bot_a"), "bot\\_a");
    assert.strictEqual(escapeLikePattern("bot\\a"), "bot\\\\a");
    assert.strictEqual(escapeLikePattern("bot-a"), "bot-a");
  });
});
