// @effect-diagnostics nodeBuiltinImport:off globalConsole:off - Repository guard script uses synchronous git/file traversal and CLI output.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import allowlistJson from "./brand-identity-allowlist.json" with { type: "json" };

export type BrandPattern = {
  readonly id: string;
  readonly expression: RegExp;
};

export type BrandMatch = {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly patternId: string;
  readonly match: string;
};

export type AllowlistEntry = {
  readonly path: string;
  readonly patternId: string;
  readonly reason: string;
};

export const BRAND_PATTERNS: ReadonlyArray<BrandPattern> = [
  { id: "legacy-display", expression: /shuv2code/gu },
  { id: "legacy-slug", expression: /shuv2code|t3-code/gu },
  { id: "legacy-package-scope", expression: /@shuv2code/gu },
  { id: "legacy-environment", expression: /T3CODE_/gu },
  { id: "legacy-app-id", expression: /com\.t3tools/gu },
  { id: "legacy-host", expression: /(?:^|[./])(?:app\.)?t3\.codes/gu },
  { id: "legacy-owner-slug", expression: /\bt3tools\b/giu },
  { id: "upstream-owner", expression: /T3 Tools(?:,? Inc\.?)?/gu },
  {
    id: "legacy-observable-prefix",
    expression: /\bt3_(?:rpc|orchestration|provider|git|db|session)/gu,
  },
  { id: "legacy-relay-kind", expression: /\bt3_relay\b/gu },
  { id: "legacy-environment-credential", expression: /\bt3env_/gu },
  { id: "legacy-showcase-identity", expression: /\bT3Showcase/gu },
  { id: "invalid-operator", expression: /\bshuv2code Tools(?:,? Inc\.?)?/gu },
  { id: "legacy-fork-owner", expression: /\b(?:pingdotgg|t3dotgg)\/shuv2code\b/gu },
  { id: "legacy-command", expression: /(?<![.\w])t3(?!\w)/gu },
  { id: "legacy-visible-word", expression: /\bT3\b/gu },
  {
    id: "legacy-state",
    expression: /\.t3(?=\/|\\|["'`\s]|$)/gu,
  },
];

const INTERNAL_EXCLUSIONS = new Set([
  "scripts/brand-identity-allowlist.json",
  "scripts/check-brand-identity.test.ts",
  "scripts/check-brand-identity.ts",
]);

function lineAndColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const lines = before.split("\n");
  return { line: lines.length, column: (lines.at(-1)?.length ?? 0) + 1 };
}

export function scanText(path: string, text: string): ReadonlyArray<BrandMatch> {
  const matches: Array<BrandMatch> = [];
  for (const pattern of BRAND_PATTERNS) {
    for (const match of text.matchAll(pattern.expression)) {
      const offset = match.index;
      if (offset === undefined) continue;
      matches.push({
        path,
        ...lineAndColumn(text, offset),
        patternId: pattern.id,
        match: match[0],
      });
    }
  }
  return matches.sort(
    (left, right) =>
      left.line - right.line ||
      left.column - right.column ||
      left.patternId.localeCompare(right.patternId),
  );
}

export function isAllowed(match: BrandMatch, entries: ReadonlyArray<AllowlistEntry>): boolean {
  return entries.some((entry) => entry.path === match.path && entry.patternId === match.patternId);
}

function isBinary(contents: Buffer): boolean {
  return contents.subarray(0, 8_000).includes(0);
}

function listGitFiles(root: string): ReadonlyArray<string> {
  const output = NodeChildProcess.execFileSync(
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    { cwd: root, maxBuffer: 32 * 1024 * 1024 },
  ).toString("utf8");
  return output
    .split("\0")
    .filter(Boolean)
    .filter((path) => !path.startsWith(".repos/"))
    .filter((path) => !INTERNAL_EXCLUSIONS.has(path));
}

function walk(root: string, entryPath: string): ReadonlyArray<string> {
  const absolutePath = NodePath.resolve(root, entryPath);
  const info = NodeFS.statSync(absolutePath);
  if (info.isFile()) return [NodePath.relative(root, absolutePath)];
  if (!info.isDirectory()) return [];
  return NodeFS.readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const child = NodePath.resolve(absolutePath, entry.name);
    const childRelative = NodePath.relative(root, child);
    if (entry.isDirectory()) return walk(root, childRelative);
    return entry.isFile() ? [childRelative] : [];
  });
}

export function scanPaths(root: string, paths: ReadonlyArray<string>): ReadonlyArray<BrandMatch> {
  const matches: Array<BrandMatch> = [];
  for (const path of paths) {
    if (INTERNAL_EXCLUSIONS.has(path)) continue;
    const absolutePath = NodePath.resolve(root, path);
    if (!NodeFS.existsSync(absolutePath) || !NodeFS.statSync(absolutePath).isFile()) continue;
    const contents = NodeFS.readFileSync(absolutePath);
    if (isBinary(contents)) continue;
    matches.push(...scanText(path, contents.toString("utf8")));
  }
  return matches;
}

function main(): void {
  const root = process.cwd();
  const requestedPaths = process.argv.slice(2);
  const paths =
    requestedPaths.length === 0
      ? listGitFiles(root)
      : requestedPaths.flatMap((path) => walk(root, path));
  const entries = allowlistJson.entries satisfies ReadonlyArray<AllowlistEntry>;
  const matches = scanPaths(root, [...new Set(paths)].sort());
  const unexpected = matches.filter((match) => !isAllowed(match, entries));

  for (const match of unexpected) {
    console.error(
      `${match.path}:${match.line}:${match.column} ${match.patternId} ${JSON.stringify(match.match)}`,
    );
  }
  for (const entry of entries) {
    if (
      !matches.some((match) => match.path === entry.path && match.patternId === entry.patternId)
    ) {
      console.error(`stale allowlist entry: ${entry.path} ${entry.patternId} (${entry.reason})`);
      process.exitCode = 1;
    }
  }
  if (unexpected.length > 0) {
    console.error(`brand identity check failed with ${unexpected.length} unexpected match(es)`);
    process.exitCode = 1;
    return;
  }
  if (process.exitCode !== 1) {
    console.log(`brand identity check passed across ${paths.length} file(s)`);
  }
}

if (import.meta.main) {
  main();
}
