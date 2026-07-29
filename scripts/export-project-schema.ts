// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Deterministic build-time schema exporter uses direct filesystem and CLI output.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import { buildShuv2CodeProjectFileJsonSchema } from "@shuv2code/shared/shuv2codeProjectFile";

const outputPath = resolve(process.cwd(), "schemas/shuv2code.schema.json");
const output = `${JSON.stringify(buildShuv2CodeProjectFileJsonSchema(), null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = readFileSync(outputPath, "utf8");
  if (current !== output) {
    console.error("schemas/shuv2code.schema.json is stale; run `vp run schema:export`.");
    process.exitCode = 1;
  }
} else {
  writeFileSync(outputPath, output);
  console.log(`wrote ${outputPath}`);
}
