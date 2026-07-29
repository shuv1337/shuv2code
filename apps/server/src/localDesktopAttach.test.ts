import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as LocalDesktopAttach from "./localDesktopAttach.ts";

describe("localDesktopAttach", () => {
  it.effect("creates a durable attach credential and reuses it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "shuv2code-local-desktop-attach-test-",
      });
      const attachPath = path.join(root, "local-desktop-attach.json");

      const first = yield* LocalDesktopAttach.ensureLocalDesktopAttachCredential(attachPath);
      const second = yield* LocalDesktopAttach.ensureLocalDesktopAttachCredential(attachPath);
      const restored = yield* LocalDesktopAttach.readPersistedLocalDesktopAttach(attachPath);

      assert.isTrue(first.length > 0);
      assert.strictEqual(second, first);
      assert.deepEqual(Option.getOrThrow(restored), { version: 1, credential: first });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("treats a missing attach file as absent", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fileSystem.makeTempDirectoryScoped({
        prefix: "shuv2code-local-desktop-attach-test-",
      });

      const restored = yield* LocalDesktopAttach.readPersistedLocalDesktopAttach(
        path.join(root, "missing.json"),
      );

      assert.isTrue(Option.isNone(restored));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
