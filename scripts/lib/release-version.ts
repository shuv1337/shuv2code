import { parseSemver } from "@shuv2code/shared/semver";

export type NpmReleaseDistTag = "latest" | "next" | "nightly";

export type ReleaseVersionClass = "stable" | "prerelease" | "nightly";

export interface ParsedReleaseVersion {
  readonly version: string;
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly prerelease: ReadonlyArray<string>;
  readonly coreVersion: string;
  readonly class: ReleaseVersionClass;
  readonly npmDistTag: NpmReleaseDistTag;
  readonly githubPrerelease: boolean;
  readonly githubMakeLatest: boolean;
}

export class InvalidReleaseVersionError extends Error {
  readonly _tag = "InvalidReleaseVersionError";
  readonly version: string;

  constructor(version: string) {
    super(`Invalid release version '${version}'.`);
    this.name = "InvalidReleaseVersionError";
    this.version = version;
  }
}

export class ReleaseChannelMismatchError extends Error {
  readonly _tag = "ReleaseChannelMismatchError";
  readonly version: string;
  readonly requestedChannel: string;
  readonly expectedChannel: NpmReleaseDistTag;

  constructor(version: string, requestedChannel: string, expectedChannel: NpmReleaseDistTag) {
    super(
      `Release version '${version}' maps to npm dist-tag '${expectedChannel}', not '${requestedChannel}'.`,
    );
    this.name = "ReleaseChannelMismatchError";
    this.version = version;
    this.requestedChannel = requestedChannel;
    this.expectedChannel = expectedChannel;
  }
}

const NIGHTLY_DATE_RUN = /^nightly\.(\d{8})\.(\d+)$/;
/** Full x.y.z with optional prerelease; rejects two-segment forms like `0.1`. */
const STRICT_RELEASE_VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/;

function isPositiveIntegerString(value: string): boolean {
  return /^\d+$/.test(value) && Number.parseInt(value, 10) >= 1;
}

export function formatCoreVersion(major: number, minor: number, patch: number): string {
  return `${major}.${minor}.${patch}`;
}

function stripBuildMetadata(version: string): string {
  const plusIndex = version.indexOf("+");
  return plusIndex === -1 ? version : version.slice(0, plusIndex);
}

export function classifyReleaseVersion(version: string): ParsedReleaseVersion {
  const withoutBuild = stripBuildMetadata(version.trim());
  if (!STRICT_RELEASE_VERSION.test(withoutBuild)) {
    throw new InvalidReleaseVersionError(version);
  }
  const parsed = parseSemver(withoutBuild);
  if (!parsed) {
    throw new InvalidReleaseVersionError(version);
  }

  const coreVersion = formatCoreVersion(parsed.major, parsed.minor, parsed.patch);
  const normalizedVersion =
    parsed.prerelease.length === 0 ? coreVersion : `${coreVersion}-${parsed.prerelease.join(".")}`;

  if (parsed.prerelease.length === 0) {
    return {
      version: normalizedVersion,
      major: parsed.major,
      minor: parsed.minor,
      patch: parsed.patch,
      prerelease: [],
      coreVersion,
      class: "stable",
      npmDistTag: "latest",
      githubPrerelease: false,
      githubMakeLatest: true,
    };
  }

  if (parsed.prerelease[0] === "nightly") {
    const nightlyLabel = parsed.prerelease.join(".");
    const nightlyMatch = NIGHTLY_DATE_RUN.exec(nightlyLabel);
    const runNumber = nightlyMatch?.[2];
    if (!nightlyMatch || runNumber === undefined || !isPositiveIntegerString(runNumber)) {
      throw new InvalidReleaseVersionError(version);
    }

    return {
      version: normalizedVersion,
      major: parsed.major,
      minor: parsed.minor,
      patch: parsed.patch,
      prerelease: parsed.prerelease,
      coreVersion,
      class: "nightly",
      npmDistTag: "nightly",
      githubPrerelease: true,
      githubMakeLatest: false,
    };
  }

  return {
    version: normalizedVersion,
    major: parsed.major,
    minor: parsed.minor,
    patch: parsed.patch,
    prerelease: parsed.prerelease,
    coreVersion,
    class: "prerelease",
    npmDistTag: "next",
    githubPrerelease: true,
    githubMakeLatest: false,
  };
}

export function resolveNpmDistTag(version: string): NpmReleaseDistTag {
  return classifyReleaseVersion(version).npmDistTag;
}

export function assertReleaseChannel(version: string, channel: string): ParsedReleaseVersion {
  const classified = classifyReleaseVersion(version);
  if (channel !== classified.npmDistTag) {
    throw new ReleaseChannelMismatchError(version, channel, classified.npmDistTag);
  }
  return classified;
}

/**
 * Nightlies keep a prerelease core (`0.1.0-alpha.2` → `0.1.0-nightly...`)
 * and advance a stable core by one patch (`0.1.0` → `0.1.1-nightly...`).
 */
export function resolveNightlyCoreVersion(version: string): string {
  const classified = classifyReleaseVersion(version);
  if (classified.class === "stable") {
    return formatCoreVersion(classified.major, classified.minor, classified.patch + 1);
  }
  return classified.coreVersion;
}
