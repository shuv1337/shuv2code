import * as Schema from "effect/Schema";

import { Shuv2CodeProjectFile, SHUV2CODE_PROJECT_FILE_SCHEMA_URL } from "@shuv2code/contracts";

import { fromLenientJson } from "./schemaJson.ts";

/**
 * Codec between the raw `shuv2code.json` file contents (lenient JSONC string) and the
 * decoded {@link Shuv2CodeProjectFile}.
 */
export const Shuv2CodeProjectFileFromJson = fromLenientJson(Shuv2CodeProjectFile);

/**
 * Build the checked-in JSON Schema document for `shuv2code.json` (draft 2020-12).
 * A future explicitly configured marketing deployment may serve the same
 * document, but local editor support does not depend on public hosting.
 */
export function buildShuv2CodeProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(Shuv2CodeProjectFile);
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: SHUV2CODE_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
