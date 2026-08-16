import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { ThreadEnvMode } from "./environment.ts";
import { ProjectScriptIcon } from "./orchestration.ts";

/** File name of the checked-in shuv2code project file, resolved at the workspace root. */
export const SHUV2CODE_PROJECT_FILE_NAME = "shuv2code.json";

/** Stable identifier of the checked-in JSON Schema for {@link Shuv2CodeProjectFile}. */
export const SHUV2CODE_PROJECT_FILE_SCHEMA_URL = "urn:shuv2code:schema:project-file";

const SHUV2CODE_PROJECT_FILE_PATH_MAX_LENGTH = 512;
const SHUV2CODE_PROJECT_FILE_MAX_SCRIPTS = 50;

// Annotations go on the encoded (string) side so they survive into the
// published JSON Schema; decoding still trims and re-validates non-emptiness.
const trimmedNonEmpty = (annotations: { readonly description: string }, maxLength?: number) => {
  const annotated = Schema.String.annotate(annotations);
  const encoded =
    maxLength === undefined
      ? annotated.check(Schema.isNonEmpty())
      : annotated.check(Schema.isNonEmpty(), Schema.isMaxLength(maxLength));
  return encoded.pipe(Schema.decodeTo(encoded, SchemaTransformation.trim()));
};

export const Shuv2CodeProjectFileScript = Schema.Struct({
  name: trimmedNonEmpty({
    description: "Display name for the script, shown in the shuv2code scripts menu.",
  }),
  command: trimmedNonEmpty({
    description: "Shell command executed in a shuv2code terminal at the project root.",
  }),
  icon: Schema.optionalKey(
    ProjectScriptIcon.annotate({
      description: 'Icon shown next to the script in the scripts menu. Defaults to "play".',
    }),
  ),
  runOnWorktreeCreate: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, the script runs automatically after a worktree is created for a new thread.",
    }),
  ),
  previewUrl: Schema.optionalKey(
    trimmedNonEmpty({
      description:
        "URL opened in the in-app browser preview when this script runs. Only honored on the desktop build.",
    }),
  ),
  autoOpenPreview: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "When true, automatically open the preview panel at `previewUrl` the moment the script starts.",
    }),
  ),
}).annotate({
  description: "A project script that team members can import into shuv2code.",
});
export type Shuv2CodeProjectFileScript = typeof Shuv2CodeProjectFileScript.Type;

export const Shuv2CodeProjectFile = Schema.Struct({
  $schema: Schema.optionalKey(
    Schema.String.annotate({
      description: `URL of the JSON Schema for this file, typically "${SHUV2CODE_PROJECT_FILE_SCHEMA_URL}".`,
    }),
  ),
  iconPath: Schema.optionalKey(
    trimmedNonEmpty(
      {
        description:
          'Workspace-relative path to the project icon (e.g. "assets/logo.svg"). Checked before shuv2code\'s built-in icon locations.',
      },
      SHUV2CODE_PROJECT_FILE_PATH_MAX_LENGTH,
    ),
  ),
  defaultThreadEnvMode: Schema.optionalKey(
    ThreadEnvMode.annotate({
      description:
        'Where new threads start for this repository: "worktree" for a fresh git worktree, "local" for the current checkout. A per-project setting in shuv2code overrides this; when neither is set, the global default applies.',
    }),
  ),
  scripts: Schema.optionalKey(
    Schema.Array(Shuv2CodeProjectFileScript)
      .annotate({
        description: "Project scripts shared with everyone who opens this repository in shuv2code.",
      })
      .check(Schema.isMaxLength(SHUV2CODE_PROJECT_FILE_MAX_SCRIPTS)),
  ),
}).annotate({
  title: "shuv2code project file",
  description:
    "Checked-in project configuration for shuv2code (shuv2code.json at the repository root).",
});
export type Shuv2CodeProjectFile = typeof Shuv2CodeProjectFile.Type;
