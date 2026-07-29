import {
  SHUV2CODE_PROJECT_FILE_NAME,
  type EnvironmentId,
  type Shuv2CodeProjectFileScript,
} from "@shuv2code/contracts";
import { Shuv2CodeProjectFileFromJson } from "@shuv2code/shared/shuv2codeProjectFile";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const decodeShuv2CodeProjectFile = Schema.decodeExit(Shuv2CodeProjectFileFromJson);

const NO_SCRIPTS: ReadonlyArray<Shuv2CodeProjectFileScript> = [];

/**
 * Scripts declared in the project's checked-in `shuv2code.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useShuv2CodeProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<Shuv2CodeProjectFileScript> {
  const query = useProjectFileQuery(
    environmentId,
    cwd ?? "",
    SHUV2CODE_PROJECT_FILE_NAME,
    cwd !== null,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  return useMemo(() => {
    if (contents === null) return NO_SCRIPTS;
    const decoded = decodeShuv2CodeProjectFile(contents);
    if (Exit.isFailure(decoded)) return NO_SCRIPTS;
    return decoded.value.scripts ?? NO_SCRIPTS;
  }, [contents]);
}
