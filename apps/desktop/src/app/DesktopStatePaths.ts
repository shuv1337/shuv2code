import * as Option from "effect/Option";

export type JoinPath = (first: string, ...segments: string[]) => string;

function normalizeConfiguredBaseDir(shuv2codeHome: Option.Option<string>): Option.Option<string> {
  if (Option.isNone(shuv2codeHome)) {
    return Option.none();
  }
  const trimmed = shuv2codeHome.value.trim();
  return trimmed.length > 0 ? Option.some(trimmed) : Option.none();
}

export function resolveDesktopBaseDir(input: {
  readonly homeDirectory: string;
  readonly joinPath: JoinPath;
  readonly shuv2codeHome: Option.Option<string>;
}): string {
  return Option.getOrElse(normalizeConfiguredBaseDir(input.shuv2codeHome), () =>
    input.joinPath(input.homeDirectory, ".shuv2code"),
  );
}

export function resolveDesktopStateDir(input: {
  readonly baseDir: string;
  readonly isDevelopment: boolean;
  readonly joinPath: JoinPath;
  readonly shuv2codeHome: Option.Option<string>;
}): string {
  const useDevSubdir =
    input.isDevelopment && Option.isNone(normalizeConfiguredBaseDir(input.shuv2codeHome));
  return input.joinPath(input.baseDir, useDevSubdir ? "dev" : "userdata");
}
