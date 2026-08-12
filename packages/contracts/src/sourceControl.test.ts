import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { SourceControlDiscoveryResult } from "./sourceControl.ts";

const decodeDiscovery = Schema.decodeUnknownSync(SourceControlDiscoveryResult);

describe("SourceControlDiscoveryResult", () => {
  it("defaults additive companion tools for older server payloads", () => {
    expect(
      decodeDiscovery({
        versionControlSystems: [],
        sourceControlProviders: [],
      }),
    ).toEqual({
      versionControlSystems: [],
      companionTools: [],
      sourceControlProviders: [],
    });
  });
});
