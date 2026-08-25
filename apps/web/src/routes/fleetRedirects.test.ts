import { isRedirect } from "@tanstack/react-router";
import { describe, expect, it } from "vite-plus/test";

import { Route as BotChatRedirectRoute } from "./_chat.fleet_.$botId_.chat";
import { Route as NeedsYouRedirectRoute } from "./_chat.fleet_.needs-you";

/**
 * The retired routes (MESSENGER-PIVOT §5 step 4, closed by M6).
 *
 * Both landed as redirect stubs in earlier tickets and neither had a test: a
 * redirect is one line, and one line is exactly what a later refactor deletes
 * without noticing. What breaks then is silent — a bookmark or the sidebar
 * badge lands on a 404, or worse, `/fleet/$botId/chat` starts rendering
 * `BotChatPage` bare again, dropping the captain out of the shell with no
 * contacts rail. These assert the redirect *targets*, not merely that
 * something is thrown.
 */
function redirectFrom(beforeLoad: unknown, argument: unknown): Record<string, unknown> {
  expect(typeof beforeLoad).toBe("function");
  try {
    (beforeLoad as (input: unknown) => unknown)(argument);
  } catch (thrown) {
    // A router redirect is a `Response` carrying the navigation on `.options`;
    // asserting through `isRedirect` means a route that starts throwing a real
    // error fails here rather than passing as "it threw something".
    expect(isRedirect(thrown)).toBe(true);
    return (thrown as { readonly options: Record<string, unknown> }).options;
  }
  throw new Error("Expected the route to throw a redirect.");
}

describe("/fleet/$botId/chat", () => {
  it("redirects into the shell conversation for the same bot", () => {
    const redirect = redirectFrom(BotChatRedirectRoute.options.beforeLoad, {
      params: { botId: "bot-1" },
    });
    expect(redirect.to).toBe("/fleet/$botId");
    expect(redirect.params).toEqual({ botId: "bot-1" });
  });

  it("replaces rather than pushes, so Back does not bounce through it again", () => {
    const redirect = redirectFrom(BotChatRedirectRoute.options.beforeLoad, {
      params: { botId: "bot-1" },
    });
    expect(redirect.replace).toBe(true);
  });
});

describe("/fleet/needs-you", () => {
  it("redirects to the rail's attention filter, not to a bare index", () => {
    // The point of retiring the inbox was that the same bots were listed
    // twice. Landing on `/fleet` with no filter would answer a different
    // question than the one the captain (or the sidebar badge) asked.
    const redirect = redirectFrom(NeedsYouRedirectRoute.options.beforeLoad, {});
    expect(redirect.to).toBe("/fleet");
    expect(redirect.search).toEqual({ filter: "attention" });
    expect(redirect.replace).toBe(true);
  });
});
