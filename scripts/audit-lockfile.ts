import { readFileSync } from "node:fs";
import { resolve } from "node:path";

export type LockedPackage = {
  name: string;
  version: string;
};

type OsvVulnerability = {
  id?: string;
  summary?: string;
};

type OsvBatchResponse = {
  results?: Array<{ vulns?: OsvVulnerability[] }>;
};

type FetchImplementation = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export function packagesFromBunLock(contents: string): LockedPackage[] {
  const packages = new Map<string, LockedPackage>();
  const entry = /^\s+"[^"]+":\s+\["((?:@[^/"@]+\/)?[^"@]+)@([0-9][^"]*)"/gm;
  for (const match of contents.matchAll(entry)) {
    const locked = { name: match[1], version: match[2] };
    packages.set(`${locked.name}@${locked.version}`, locked);
  }
  return [...packages.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)
  );
}

export async function queryOsv(
  packages: LockedPackage[],
  fetchImplementation: FetchImplementation = fetch,
): Promise<Array<{ package: LockedPackage; vulnerabilities: OsvVulnerability[] }>> {
  const response = await fetchImplementation("https://api.osv.dev/v1/querybatch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      queries: packages.map((locked) => ({
        package: { ecosystem: "npm", name: locked.name },
        version: locked.version,
      })),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`OSV audit request failed with HTTP ${response.status}`);
  }
  const payload = await response.json() as OsvBatchResponse;
  if (!Array.isArray(payload.results) || payload.results.length !== packages.length) {
    throw new Error("OSV audit returned an incomplete response");
  }
  return payload.results.flatMap((result, index) => {
    const vulnerabilities = result.vulns ?? [];
    return vulnerabilities.length > 0
      ? [{ package: packages[index], vulnerabilities }]
      : [];
  });
}

async function main(): Promise<void> {
  const lockPath = resolve(import.meta.dir, "../bun.lock");
  const packages = packagesFromBunLock(readFileSync(lockPath, "utf8"));
  if (packages.length === 0) {
    throw new Error("No registry packages were found in bun.lock");
  }
  const vulnerable = await queryOsv(packages);
  if (vulnerable.length > 0) {
    for (const finding of vulnerable) {
      const advisories = finding.vulnerabilities
        .map((vulnerability) => vulnerability.id ?? "unknown advisory")
        .join(", ");
      console.error(`${finding.package.name}@${finding.package.version}: ${advisories}`);
    }
    throw new Error(`OSV found vulnerabilities in ${vulnerable.length} locked package(s)`);
  }
  console.log(`OSV audit passed for ${packages.length} locked npm packages.`);
}

if (import.meta.main) {
  await main();
}
