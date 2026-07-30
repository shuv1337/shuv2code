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
const STRICT_RELEASE_VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

function isPositiveIntegerString(value: string): boolean {
  return /^\d+$/.test(value) && Number.parseInt(value, 10) >= 1;
}

function hasInvalidNumericPrereleaseIdentifier(identifiers: ReadonlyArray<string>): boolean {
  return identifiers.some(
    (identifier) => /^\d+$/.test(identifier) && identifier.length > 1 && identifier.startsWith("0"),
  );
}

export function formatCoreVersion(major: number, minor: number, patch: number): string {
  return `${major}.${minor}.${patch}`;
}

export function classifyReleaseVersion(version: string): ParsedReleaseVersion {
  const candidate = version.trim();
  const match = STRICT_RELEASE_VERSION.exec(candidate);
  if (candidate !== version || !match) {
    throw new InvalidReleaseVersionError(version);
  }

  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  const prerelease = match[4]?.split(".") ?? [];
  if (hasInvalidNumericPrereleaseIdentifier(prerelease)) {
    throw new InvalidReleaseVersionError(version);
  }

  const coreVersion = formatCoreVersion(major, minor, patch);

  if (prerelease.length === 0) {
    return {
      version: candidate,
      major,
      minor,
      patch,
      prerelease: [],
      coreVersion,
      class: "stable",
      npmDistTag: "latest",
      githubPrerelease: false,
      githubMakeLatest: true,
    };
  }

  if (prerelease[0] === "nightly") {
    const nightlyLabel = prerelease.join(".");
    const nightlyMatch = NIGHTLY_DATE_RUN.exec(nightlyLabel);
    const runNumber = nightlyMatch?.[2];
    if (!nightlyMatch || runNumber === undefined || !isPositiveIntegerString(runNumber)) {
      throw new InvalidReleaseVersionError(version);
    }

    return {
      version: candidate,
      major,
      minor,
      patch,
      prerelease,
      coreVersion,
      class: "nightly",
      npmDistTag: "nightly",
      githubPrerelease: true,
      githubMakeLatest: false,
    };
  }

  return {
    version: candidate,
    major,
    minor,
    patch,
    prerelease,
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
