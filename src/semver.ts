export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: Array<{
    raw: string;
    numeric: boolean;
    numericValue: number | null;
  }>;
}

export function parseSemver(version: string): ParsedSemver | null {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version.trim());

  if (match === null) {
    return null;
  }

  const prerelease = match[4] === undefined
    ? []
    : match[4].split(".").map((raw) => ({
      raw,
      numeric: /^(0|[1-9]\d*)$/.test(raw),
      numericValue: /^(0|[1-9]\d*)$/.test(raw) ? Number(raw) : null,
    }));

  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease,
  };
}

export function compareSemver(left: string, right: string): number | null {
  const leftParsed = parseSemver(left);
  const rightParsed = parseSemver(right);

  if (leftParsed === null || rightParsed === null) {
    return null;
  }

  if (leftParsed.major !== rightParsed.major) {
    return leftParsed.major > rightParsed.major ? 1 : -1;
  }

  if (leftParsed.minor !== rightParsed.minor) {
    return leftParsed.minor > rightParsed.minor ? 1 : -1;
  }

  if (leftParsed.patch !== rightParsed.patch) {
    return leftParsed.patch > rightParsed.patch ? 1 : -1;
  }

  if (leftParsed.prerelease.length === 0 && rightParsed.prerelease.length === 0) {
    return 0;
  }

  if (leftParsed.prerelease.length === 0) {
    return 1;
  }

  if (rightParsed.prerelease.length === 0) {
    return -1;
  }

  const maxLength = Math.max(leftParsed.prerelease.length, rightParsed.prerelease.length);

  for (let index = 0; index < maxLength; index += 1) {
    const leftIdentifier = leftParsed.prerelease[index];
    const rightIdentifier = rightParsed.prerelease[index];

    if (leftIdentifier === undefined) {
      return -1;
    }

    if (rightIdentifier === undefined) {
      return 1;
    }

    if (leftIdentifier.numeric && rightIdentifier.numeric) {
      if (leftIdentifier.numericValue !== rightIdentifier.numericValue) {
        return leftIdentifier.numericValue! > rightIdentifier.numericValue! ? 1 : -1;
      }
      continue;
    }

    if (leftIdentifier.numeric !== rightIdentifier.numeric) {
      return leftIdentifier.numeric ? -1 : 1;
    }

    if (leftIdentifier.raw !== rightIdentifier.raw) {
      return leftIdentifier.raw > rightIdentifier.raw ? 1 : -1;
    }
  }

  return 0;
}
