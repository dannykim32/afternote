const SEMANTIC_VERSION_PATTERN =
  /^(\d+)\.\d+\.\d+(?:-[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:[.-][0-9A-Za-z]+)*)?$/;

export function assertApplicationVersion(version: unknown): asserts version is string {
  if (
    typeof version !== "string" ||
    version.length > 100 ||
    !SEMANTIC_VERSION_PATTERN.test(version)
  ) {
    throw new Error("Application version must be a bounded semantic version");
  }
}

export function applicationMajor(version: unknown): number {
  assertApplicationVersion(version);
  return Number(version.match(SEMANTIC_VERSION_PATTERN)![1]);
}
