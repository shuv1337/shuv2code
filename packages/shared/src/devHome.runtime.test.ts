// @effect-diagnostics nodeBuiltinImport:off - verifies disposable workspace markers.
/* oxlint-disable shuv2code/no-manual-effect-runtime-in-tests -- Independent runtime probe while the Effect/Vite+ adapter fails before collection. */
import * as NodeServices from "@effect/platform-node/NodeServices";
// @ts-expect-error Direct Vitest import bypasses the broken Vite+ test adapter on this checkout.
import { expect, it } from "vitest";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

import {
  resolveJjWorkspacePath,
  resolveVcsWorkspacePath,
  resolveWorktreeShuv2CodeHome,
} from "./devHome.ts";

it("isolates linked JJ workspace state without classifying the default workspace", () => {
  const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "shuv2code-jj-home-"));
  const linked = NodePath.join(root, "linked");
  const primary = NodePath.join(root, "primary");
  NodeFS.mkdirSync(NodePath.join(linked, ".jj"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(linked, ".jj", "repo"), "../../primary/.jj/repo\n");
  NodeFS.mkdirSync(NodePath.join(primary, ".jj", "repo"), { recursive: true });

  return Effect.runPromise(
    Effect.gen(function* () {
      expect(yield* resolveJjWorkspacePath(linked)).toBe(NodePath.resolve(linked));
      expect(yield* resolveVcsWorkspacePath(linked)).toBe(NodePath.resolve(linked));
      expect(yield* resolveWorktreeShuv2CodeHome(linked)).toBe(
        NodePath.join(NodePath.resolve(linked), ".shuv2code"),
      );
      expect(yield* resolveJjWorkspacePath(primary)).toBe(undefined);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(root, { recursive: true, force: true }))),
    ),
  );
});
