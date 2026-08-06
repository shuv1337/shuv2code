import { EnvironmentId, type VcsStatusResult } from "@shuv2code/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("../state/use-atom-command", () => ({
  useAtomCommand: () => vi.fn(),
}));

import { BranchToolbarVcsSelector } from "./BranchToolbarVcsSelector";

function status(kind: "git" | "jj", availableKinds: ReadonlyArray<"git" | "jj">): VcsStatusResult {
  return {
    kind,
    selection: {
      availableKinds,
      projectKind: null,
      defaultKind: "git",
      source: "user-default",
    },
  } as VcsStatusResult;
}

describe("BranchToolbarVcsSelector", () => {
  it("renders the active colocated VCS as persistent composer context", () => {
    const markup = renderToStaticMarkup(
      <BranchToolbarVcsSelector
        environmentId={EnvironmentId.make("local")}
        cwd="/repo"
        status={status("jj", ["git", "jj"])}
      />,
    );

    expect(markup).toContain('aria-label="Version control: Jujutsu"');
    expect(markup).not.toContain(">Jujutsu<");
    expect(markup).not.toContain(">JJ<");
  });

  it("stays hidden when the repository has no VCS choice", () => {
    const markup = renderToStaticMarkup(
      <BranchToolbarVcsSelector
        environmentId={EnvironmentId.make("local")}
        cwd="/repo"
        status={status("jj", ["jj"])}
      />,
    );

    expect(markup).toBe("");
  });
});
