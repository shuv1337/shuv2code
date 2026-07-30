// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Deterministic build-time schema exporter uses direct filesystem and CLI output.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeProcess from "node:process";

import { buildShuv2CodeProjectFileJsonSchema } from "@shuv2code/shared/shuv2codeProjectFile";

const outputPath = NodePath.resolve(NodeProcess.cwd(), "schemas/shuv2code.schema.json");
const output = `${JSON.stringify(buildShuv2CodeProjectFileJsonSchema(), null, 2)}\n`;

if (NodeProcess.argv.includes("--check")) {
  const current = NodeFS.readFileSync(outputPath, "utf8");
  if (current !== output) {
    console.error("schemas/shuv2code.schema.json is stale; run `vp run schema:export`.");
    NodeProcess.exit(1);
  }
} else {
  NodeFS.writeFileSync(outputPath, output);
  console.log(`wrote ${outputPath}`);
}
