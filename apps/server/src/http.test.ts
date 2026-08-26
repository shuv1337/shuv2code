import { expect, it } from "@effect/vitest";
import { describe } from "vite-plus/test";

import {
  assetResponseHeaders,
  isLoopbackHostname,
  parseAssetByteRange,
  resolveDevRedirectUrl,
} from "./http.ts";

describe("http dev routing", () => {
  it("treats localhost and loopback addresses as local", () => {
    expect(isLoopbackHostname("127.0.0.1")).toBe(true);
    expect(isLoopbackHostname("localhost")).toBe(true);
    expect(isLoopbackHostname("::1")).toBe(true);
    expect(isLoopbackHostname("[::1]")).toBe(true);
  });

  it("does not treat LAN addresses as local", () => {
    expect(isLoopbackHostname("192.168.86.35")).toBe(false);
    expect(isLoopbackHostname("10.0.0.24")).toBe(false);
    expect(isLoopbackHostname("example.local")).toBe(false);
  });

  it("preserves path and query when redirecting to the dev server", () => {
    const devUrl = new URL("http://127.0.0.1:5173/");
    const requestUrl = new URL("http://127.0.0.1:3774/pair?token=test-token");

    expect(resolveDevRedirectUrl(devUrl, requestUrl)).toBe(
      "http://127.0.0.1:5173/pair?token=test-token",
    );
  });
});

describe("assetResponseHeaders", () => {
  it("sandboxes SVG assets", () => {
    expect(assetResponseHeaders("/attachments/user-image.svg")).toMatchObject({
      "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "X-Content-Type-Options": "nosniff",
    });
    expect(assetResponseHeaders("/attachments/user-image.SVG")).toHaveProperty(
      "Content-Security-Policy",
    );
  });

  it("does not apply document policy to raster images", () => {
    expect(assetResponseHeaders("/attachments/user-image.png")).toEqual({
      "Accept-Ranges": "bytes",
      "Cache-Control": "private, max-age=3600",
      "X-Content-Type-Options": "nosniff",
    });
  });
});

describe("parseAssetByteRange", () => {
  it("parses bounded, open-ended, and suffix ranges", () => {
    expect(parseAssetByteRange("bytes=10-19", 100)).toEqual({ start: 10, end: 19 });
    expect(parseAssetByteRange("bytes=90-", 100)).toEqual({ start: 90, end: 99 });
    expect(parseAssetByteRange("bytes=-10", 100)).toEqual({ start: 90, end: 99 });
    expect(parseAssetByteRange("bytes=95-200", 100)).toEqual({ start: 95, end: 99 });
  });

  it("rejects unsupported syntax and identifies unsatisfiable ranges", () => {
    expect(parseAssetByteRange("items=0-1", 100)).toBeUndefined();
    expect(parseAssetByteRange("bytes=0-1,4-5", 100)).toBeUndefined();
    expect(parseAssetByteRange("bytes=0-1-2", 100)).toBeUndefined();
    expect(parseAssetByteRange("bytes=100-", 100)).toBe("unsatisfiable");
    expect(parseAssetByteRange("bytes=20-10", 100)).toBe("unsatisfiable");
  });
});
