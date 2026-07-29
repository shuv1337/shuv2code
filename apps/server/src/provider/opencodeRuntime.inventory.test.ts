import * as NodeAssert from "node:assert/strict";

import { it as effectIt } from "@effect/vitest";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import * as Effect from "effect/Effect";
import { describe, it } from "vite-plus/test";

import { loadOpenCodeSkills, normalizeOpenCodeSkills } from "./opencodeRuntime.ts";

describe("OpenCode skill inventory", () => {
  it("normalizes SDK skill metadata and skips unusable entries", () => {
    NodeAssert.deepEqual(
      normalizeOpenCodeSkills([
        {
          name: " review ",
          description: " Review the current changes ",
          location: " /tmp/review/SKILL.md ",
        },
        { name: "test", description: "   ", location: "/tmp/test/SKILL.md" },
        { name: " ", description: "missing name", location: "/tmp/invalid/SKILL.md" },
        { name: "invalid", description: "missing location", location: " " },
      ]),
      [
        {
          name: "review",
          description: "Review the current changes",
          path: "/tmp/review/SKILL.md",
          enabled: true,
        },
        { name: "test", path: "/tmp/test/SKILL.md", enabled: true },
      ],
    );
  });

  effectIt.effect(
    "returns no skills when an older compatibility client has no app.skills method",
    () =>
      Effect.gen(function* () {
        const client = { app: {} } as unknown as OpencodeClient;
        const skills = yield* loadOpenCodeSkills(client);

        NodeAssert.deepEqual(skills, []);
      }),
  );

  effectIt.effect("loads and normalizes legacy app.skills results", () =>
    Effect.gen(function* () {
      const client = {
        app: {
          skills: async () => ({
            data: [
              {
                name: "review",
                description: "Review the current changes",
                location: "/tmp/review/SKILL.md",
                content: "Review carefully.",
              },
            ],
          }),
        },
      } as unknown as OpencodeClient;
      const skills = yield* loadOpenCodeSkills(client);

      NodeAssert.deepEqual(skills, [
        {
          name: "review",
          description: "Review the current changes",
          path: "/tmp/review/SKILL.md",
          enabled: true,
        },
      ]);
    }),
  );
});
