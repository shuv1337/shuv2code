import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as AzureDevOpsCli from "./AzureDevOpsCli.ts";
import * as AzureDevOpsSourceControlProvider from "./AzureDevOpsSourceControlProvider.ts";

function makeProvider(azure: Partial<AzureDevOpsCli.AzureDevOpsCli["Service"]>) {
  return AzureDevOpsSourceControlProvider.make.pipe(
    Effect.provide(Layer.mock(AzureDevOpsCli.AzureDevOpsCli)(azure)),
  );
}

it.effect("maps Azure DevOps PR summaries into provider-neutral change requests", () =>
  Effect.gen(function* () {
    const provider = yield* makeProvider({
      getPullRequest: () =>
        Effect.succeed({
          number: 42,
          title: "Add Azure provider",
          url: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
          baseRefName: "main",
          headRefName: "feature/source-control",
          state: "open",
          updatedAt: Option.none(),
        }),
    });

    const changeRequest = yield* provider.getChangeRequest({
      cwd: "/repo",
      reference: "42",
    });

    assert.deepStrictEqual(changeRequest, {
      provider: "azure-devops",
      number: 42,
      title: "Add Azure provider",
      url: "https://dev.azure.com/acme/project/_git/repo/pullrequest/42",
      baseRefName: "main",
      headRefName: "feature/source-control",
      state: "open",
      updatedAt: Option.none(),
      isCrossRepository: false,
    });
  }),
);

it.effect("adds change-request context while retaining Azure CLI causes", () =>
  Effect.gen(function* () {
    const cause = new AzureDevOpsCli.AzureDevOpsCommandFailedError({
      operation: "execute",
      command: "az",
      cwd: "/repo",
      argumentCount: 2,
      cause: new Error("raw upstream detail that should remain in the cause"),
    });
    const provider = yield* makeProvider({
      checkoutPullRequest: () => Effect.fail(cause),
    });

    const error = yield* provider
      .checkoutChangeRequest({ cwd: "/repo", reference: "#42" })
      .pipe(Effect.flip);

    assert.deepStrictEqual(
      {
        provider: error.provider,
        operation: error.operation,
        command: error.command,
        cwd: error.cwd,
        reference: error.reference,
        detail: error.detail,
      },
      {
        provider: "azure-devops",
        operation: "checkoutChangeRequest",
        command: "az",
        cwd: "/repo",
        reference: "#42",
        detail: "Azure DevOps CLI command failed.",
      },
    );
    assert.strictEqual(error.cause, cause);
    assert.equal(error.message.includes("raw upstream detail"), false);
  }),
);

it.effect("creates Azure DevOps PRs through provider-neutral input names", () =>
  Effect.gen(function* () {
    let createInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["createPullRequest"]>[0]
      | null = null;
    const provider = yield* makeProvider({
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
    });

    yield* provider.createChangeRequest({
      cwd: "/repo",
      baseRefName: "main",
      headSelector: "feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });

    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "main",
      headSelector: "feature/provider",
      title: "Provider PR",
      bodyFile: "/tmp/body.md",
    });
  }),
);

it.effect("uses Azure CLI repository detection for default branch lookup", () =>
  Effect.gen(function* () {
    let cwdInput: string | null = null;
    const provider = yield* makeProvider({
      getDefaultBranch: (input) => {
        cwdInput = input.cwd;
        return Effect.succeed("main");
      },
    });

    const defaultBranch = yield* provider.getDefaultBranch({ cwd: "/repo" });

    assert.strictEqual(defaultBranch, "main");
    assert.strictEqual(cwdInput, "/repo");
  }),
);

it.effect("routes Azure DevOps change requests through the explicitly selected repository", () =>
  Effect.gen(function* () {
    let listInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["listPullRequests"]>[0]
      | null = null;
    let createInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["createPullRequest"]>[0]
      | null = null;
    let defaultInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["getDefaultBranch"]>[0]
      | null = null;
    const provider = yield* makeProvider({
      listPullRequests: (input) => {
        listInput = input;
        return Effect.succeed([]);
      },
      createPullRequest: (input) => {
        createInput = input;
        return Effect.void;
      },
      getDefaultBranch: (input) => {
        defaultInput = input;
        return Effect.succeed("develop");
      },
    });
    const context = {
      provider: {
        kind: "azure-devops",
        name: "Azure DevOps",
        baseUrl: "https://dev.azure.com/acme",
      },
      remoteName: "upstream",
      remoteUrl: "https://dev.azure.com/acme/selected-project/_git/selected-repo",
    } as const;

    yield* provider.listChangeRequests({
      cwd: "/repo",
      context,
      source: {
        refName: "feature/provider",
        repository: "acme/selected-project/_git/selected-repo",
      },
      target: { refName: "release", repository: "wrong/project/_git/repo" },
      headSelector: "feature/provider",
      state: "open",
      limit: 1,
    });
    yield* provider.createChangeRequest({
      cwd: "/repo",
      context,
      source: {
        refName: "feature/provider",
        repository: "acme/selected-project/_git/selected-repo",
      },
      baseRefName: "develop",
      headSelector: "feature/provider",
      title: "Selected repository PR",
      bodyFile: "/tmp/body.md",
    });
    const defaultBranch = yield* provider.getDefaultBranch({ cwd: "/repo", context });
    const repository = {
      repository: "selected-repo",
      project: "selected-project",
      organization: "https://dev.azure.com/acme",
    };

    assert.deepStrictEqual(listInput, {
      cwd: "/repo",
      headSelector: "feature/provider",
      source: {
        refName: "feature/provider",
        repository: "acme/selected-project/_git/selected-repo",
      },
      target: { refName: "release", repository: "wrong/project/_git/repo" },
      repository,
      state: "open",
      limit: 1,
    });
    assert.deepStrictEqual(createInput, {
      cwd: "/repo",
      baseBranch: "develop",
      headSelector: "feature/provider",
      source: {
        refName: "feature/provider",
        repository: "acme/selected-project/_git/selected-repo",
      },
      repository,
      title: "Selected repository PR",
      bodyFile: "/tmp/body.md",
    });
    assert.deepStrictEqual(defaultInput, { cwd: "/repo", repository });
    assert.strictEqual(defaultBranch, "develop");
  }),
);

it.effect("parses the project after DefaultCollection in legacy Azure DevOps URLs", () =>
  Effect.gen(function* () {
    let defaultInput:
      | Parameters<AzureDevOpsCli.AzureDevOpsCli["Service"]["getDefaultBranch"]>[0]
      | null = null;
    const provider = yield* makeProvider({
      getDefaultBranch: (input) => {
        defaultInput = input;
        return Effect.succeed("main");
      },
    });
    const context = {
      provider: {
        kind: "azure-devops",
        name: "Azure DevOps",
        baseUrl: "https://acme.visualstudio.com",
      },
      remoteName: "legacy",
      remoteUrl:
        "https://acme.visualstudio.com/DefaultCollection/selected-project/_git/selected-repo",
    } as const;

    const defaultBranch = yield* provider.getDefaultBranch({ cwd: "/repo", context });

    assert.strictEqual(defaultBranch, "main");
    assert.deepStrictEqual(defaultInput, {
      cwd: "/repo",
      repository: {
        repository: "selected-repo",
        project: "selected-project",
        organization: "https://acme.visualstudio.com",
      },
    });
  }),
);
