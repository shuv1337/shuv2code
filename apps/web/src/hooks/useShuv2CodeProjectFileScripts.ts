import {
  SHUV2CODE_PROJECT_FILE_NAME,
  type EnvironmentId,
  type Shuv2CodeProjectFile,
  type Shuv2CodeProjectFileScript,
} from "@shuv2code/contracts";
import { parseShuv2CodeProjectFile } from "@shuv2code/shared/shuv2codeProjectFile";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const NO_SCRIPTS: ReadonlyArray<Shuv2CodeProjectFileScript> = [];

export interface Shuv2CodeProjectFileState {
  /**
   * - `valid`: shuv2code.json exists and decoded.
   * - `invalid`: shuv2code.json exists but fails to decode (the server then ignores
   *   the whole file, including `iconPath` and every script).
   * - `missing`: no readable shuv2code.json at the workspace root.
   * - `loading`: the file query has not settled yet.
   */
  status: "loading" | "missing" | "invalid" | "valid";
  /** The decoded file when status is `valid`, null otherwise. */
  file: Shuv2CodeProjectFile | null;
  scripts: ReadonlyArray<Shuv2CodeProjectFileScript>;
}

/**
 * Decoded state of the project's checked-in `shuv2code.json`, including whether the
 * file exists but is broken — which the runtime otherwise swallows silently.
 */
export function useShuv2CodeProjectFileState(
  environmentId: EnvironmentId,
  cwd: string | null,
): Shuv2CodeProjectFileState {
  const query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    SHUV2CODE_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  const isPending = query.isPending;
  return useMemo(() => {
    if (contents === null) {
      return {
        status: isPending ? "loading" : "missing",
        file: null,
        scripts: NO_SCRIPTS,
      } as const;
    }
    const file = parseShuv2CodeProjectFile(contents);
    if (file === null) {
      return { status: "invalid", file: null, scripts: NO_SCRIPTS } as const;
    }
    return { status: "valid", file, scripts: file.scripts ?? NO_SCRIPTS } as const;
  }, [contents, isPending]);
}

/**
 * Scripts declared in the project's checked-in `shuv2code.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useShuv2CodeProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<Shuv2CodeProjectFileScript> {
  return useShuv2CodeProjectFileState(environmentId, cwd).scripts;
}
