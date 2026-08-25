/**
 * The wired viewer route, driven as a real HTTP request.
 *
 * `AdeScreenViewerRoute.test.ts` covers the decision logic in isolation. This
 * file exists so the *ordering* cannot silently regress: authentication must
 * happen in the route, ahead of any desktop lookup, and a caller with no
 * credential must never learn whether a bot has a desktop.
 */
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/unstable/http";

import { AuthOrchestrationOperateScope, AuthOrchestrationReadScope } from "@shuv2code/contracts";
import type { BotId } from "@shuv2code/contracts";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import { adeScreenViewerRouteLayer } from "./AdeScreenViewerRoute.ts";
import {
  AdeScreenboxProvisionError,
  AdeScreenboxRuntime,
  type AdeScreenboxRuntimeShape,
} from "./AdeScreenbox.ts";

const session = (scopes: ReadonlyArray<string>) => ({
  sessionId: "viewer-session" as EnvironmentAuth.AuthenticatedSession["sessionId"],
  subject: "captain",
  method: "bearer-access-token" as const,
  scopes,
});

/** Records whether the route ever reached a desktop lookup. */
const trackingScreenbox = () => {
  const asked: Array<string> = [];
  const attached: Array<string> = [];
  const detached: Array<string> = [];
  const service = {
    viewerTargetFor: (botId: BotId) => {
      asked.push(botId);
      return Effect.succeed({ host: "127.0.0.1", port: 16081 });
    },
    viewerAttached: (botId: BotId) => Effect.sync(() => void attached.push(botId)),
    viewerDetached: (botId: BotId) => Effect.sync(() => void detached.push(botId)),
  } as unknown as AdeScreenboxRuntimeShape;
  return { asked, attached, detached, service };
};

const authService = (
  authenticate: Effect.Effect<
    ReturnType<typeof session>,
    EnvironmentAuth.ServerAuthCredentialError
  >,
) =>
  ({
    authenticateWebSocketUpgrade: () => authenticate,
  }) as unknown as EnvironmentAuth.EnvironmentAuth["Service"];

/**
 * The route resolves both services *per request*, so they are request
 * requirements rather than layer requirements — `toWebHandler` takes them as a
 * context argument. Building it this way is also what keeps the test honest:
 * it drives the same wiring production does.
 */
const requestContext = (input: {
  readonly auth: EnvironmentAuth.EnvironmentAuth["Service"];
  readonly screenbox: AdeScreenboxRuntimeShape;
}) =>
  Context.make(EnvironmentAuth.EnvironmentAuth, input.auth).pipe(
    Context.add(AdeScreenboxRuntime, input.screenbox),
  );

const request = (path: string) => new Request(`http://ade.test${path}`);

describe("adeScreenViewerRouteLayer", () => {
  const drive = async (input: {
    readonly auth: EnvironmentAuth.EnvironmentAuth["Service"];
    readonly screenbox: AdeScreenboxRuntimeShape;
    readonly path?: string;
  }): Promise<Response> => {
    const { handler, dispose } = HttpRouter.toWebHandler(adeScreenViewerRouteLayer, {
      disableLogger: true,
    });
    try {
      return await handler(
        request(input.path ?? "/ade/screen/bot-a"),
        requestContext({ auth: input.auth, screenbox: input.screenbox }),
      );
    } finally {
      await dispose();
    }
  };

  it("refuses an unauthenticated upgrade without looking up any desktop", async () => {
    const screenbox = trackingScreenbox();
    const response = await drive({
      auth: authService(Effect.fail(new EnvironmentAuth.ServerAuthMissingCredentialError({}))),
      screenbox: screenbox.service,
    });
    assert.strictEqual(response.status, 401);
    // The refusal must come before the lookup, or an anonymous caller could
    // map which bots have live desktops by diffing status codes.
    assert.deepStrictEqual(screenbox.asked, []);
    assert.deepStrictEqual(screenbox.attached, []);
  });

  it("refuses a read-only session without looking up any desktop", async () => {
    const screenbox = trackingScreenbox();
    const response = await drive({
      auth: authService(Effect.succeed(session([AuthOrchestrationReadScope]))),
      screenbox: screenbox.service,
    });
    assert.strictEqual(response.status, 403);
    assert.deepStrictEqual(screenbox.asked, []);
  });

  it("answers a plain GET with 426 rather than a 500", async () => {
    const screenbox = trackingScreenbox();
    // A curl or a mis-linked tab is a client mistake, not a server fault.
    const response = await drive({
      auth: authService(Effect.succeed(session([AuthOrchestrationOperateScope]))),
      screenbox: screenbox.service,
    });
    assert.strictEqual(response.status, 426);
    // No viewer hold may be taken for a socket that never existed.
    assert.deepStrictEqual(screenbox.attached, []);
  });

  it("refuses a bot with no viewable desktop with 409", async () => {
    const refusing = {
      viewerTargetFor: (botId: BotId) =>
        Effect.fail(
          new AdeScreenboxProvisionError({ botId, kind: "not-eligible", reason: "not running" }),
        ),
      viewerAttached: () => Effect.void,
      viewerDetached: () => Effect.void,
    } as unknown as AdeScreenboxRuntimeShape;
    const response = await drive({
      auth: authService(Effect.succeed(session([AuthOrchestrationOperateScope]))),
      screenbox: refusing,
    });
    assert.strictEqual(response.status, 409);
  });

  it("does not resolve a desktop for a path that names no bot", async () => {
    const screenbox = trackingScreenbox();
    const response = await drive({
      auth: authService(Effect.succeed(session([AuthOrchestrationOperateScope]))),
      screenbox: screenbox.service,
      path: "/ade/screen/bot-a/extra",
    });
    assert.strictEqual(response.status, 404);
    assert.deepStrictEqual(screenbox.asked, []);
  });
});
