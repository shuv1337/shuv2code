import type { EnvironmentId } from "@shuv2code/contracts";
import { describe, expect, it } from "vite-plus/test";

import { canSubmitFirstProject } from "./CaptainIndexPane";

const ENVIRONMENT = "env-1" as EnvironmentId;

const input = (overrides: Partial<Parameters<typeof canSubmitFirstProject>[0]> = {}) => ({
  environmentId: ENVIRONMENT,
  name: "Ledger",
  repoPath: "~/repos/ledger",
  busy: false,
  ...overrides,
});

describe("canSubmitFirstProject (#212)", () => {
  it("accepts a named project bound to a repository", () => {
    expect(canSubmitFirstProject(input())).toBe(true);
  });

  it("requires a repository path", () => {
    // The field used to be labelled optional and was not: a repo-less ADE
    // project can never start a chat, and nothing in the app can bind a
    // repository to it afterwards. Refusing here is the only moment the
    // captain can still act on it.
    expect(canSubmitFirstProject(input({ repoPath: "" }))).toBe(false);
    expect(canSubmitFirstProject(input({ repoPath: "   " }))).toBe(false);
  });

  it("still requires a name", () => {
    expect(canSubmitFirstProject(input({ name: "  " }))).toBe(false);
  });

  it("refuses while there is no environment or a request is in flight", () => {
    expect(canSubmitFirstProject(input({ environmentId: null }))).toBe(false);
    // Double-submit would create a second project, or race the idempotency
    // lookup on the same repo.
    expect(canSubmitFirstProject(input({ busy: true }))).toBe(false);
  });
});
