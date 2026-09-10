import {
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

export type PayloadManifestEntry = {
  path: string;
  sha256: string;
  mode: string;
  bytes: number;
} | {
  path: string;
  type: "symlink";
  target: string;
};

export function readPayloadManifestEntries(portableRoot: string): PayloadManifestEntry[] {
  const parsed = parsePayloadManifest(portableRoot);
  return parsed.entries;
}

export function payloadManifestPath(portableRoot: string): string {
  return join(portableRoot, "Afternote.app/Contents/Resources/AFTERNOTE_PAYLOAD_MANIFEST.json");
}

export function collectPayloadEntries(portableRoot: string): PayloadManifestEntry[] {
  return collectEntries(portableRoot, true);
}

function collectEntries(
  portableRoot: string,
  includePortablePayload: boolean,
): PayloadManifestEntry[] {
  const entries: PayloadManifestEntry[] = [];
  const visit = (directory: string, includeApplication = false) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = relative(portableRoot, path);
      if (!includeApplication &&
        (relativePath === "Afternote.app" || relativePath.startsWith("Afternote.app/"))) continue;
      if (includeApplication && isExcludedApplicationEntry(relativePath)) continue;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) {
        const resolvedTarget = realpathSync(path);
        const fromRoot = relative(realpathSync(portableRoot), resolvedTarget);
        if (fromRoot === "" || fromRoot.startsWith("..") || fromRoot.startsWith("/")) {
          throw new Error(`Release payload symlink escapes its payload root: ${relativePath}`);
        }
        entries.push({ path: relativePath, type: "symlink", target: readlinkSync(path) });
      } else if (info.isDirectory()) visit(path, includeApplication);
      else if (info.isFile()) entries.push({
        path: relativePath,
        sha256: sha256(path),
        mode: (info.mode & 0o777).toString(8).padStart(3, "0"),
        bytes: info.size,
      });
      else throw new Error(`Release payload contains a non-regular path: ${relativePath}`);
    }
  };
  if (includePortablePayload) visit(portableRoot);
  visit(join(portableRoot, "Afternote.app"), true);
  return entries;
}

export function collectEmbeddedRuntimeEntries(ownerApplicationPath: string): PayloadManifestEntry[] {
  return collectApplicationEntries(ownerApplicationPath).filter((entry) =>
    entry.path.startsWith("Afternote.app/Contents/Resources/AfternoteRuntime/"),
  );
}

export function collectApplicationEntries(ownerApplicationPath: string): PayloadManifestEntry[] {
  const portableRoot = join(ownerApplicationPath, "..");
  return collectEntries(portableRoot, false).filter((entry) =>
    entry.path.startsWith("Afternote.app/"),
  );
}

export function assertEmbeddedRuntimeMatchesPortable(portableRoot: string): void {
  const prefix = "Afternote.app/Contents/Resources/AfternoteRuntime/";
  const entries = collectPayloadEntries(portableRoot);
  const outer = new Map(entries
    .filter((entry) => !entry.path.startsWith(prefix))
    .map((entry) => [entry.path, entry]));
  for (const embedded of entries.filter((entry) => entry.path.startsWith(prefix))) {
    const relativePath = embedded.path.slice(prefix.length);
    const expected = outer.get(relativePath);
    const normalizedEmbedded = { ...embedded, path: relativePath };
    if (!expected || JSON.stringify(expected) !== JSON.stringify(normalizedEmbedded)) {
      throw new Error(`Embedded runtime differs from the reviewed portable payload: ${relativePath}`);
    }
  }
}

export function writePayloadManifest(portableRoot: string): string {
  const path = payloadManifestPath(portableRoot);
  writeFileSync(path, `${JSON.stringify({
    format: "afternote-signed-payload-manifest",
    version: 3,
    entries: collectPayloadEntries(portableRoot),
  }, null, 2)}\n`, { mode: 0o644 });
  return path;
}

export function verifyPayloadManifest(portableRoot: string): void {
  const parsed = parsePayloadManifest(portableRoot);
  if (JSON.stringify(parsed.entries) !== JSON.stringify(collectPayloadEntries(portableRoot))) {
    throw new Error("Release payload does not match its signed manifest");
  }
}

export function verifyEmbeddedRuntimeManifest(ownerApplicationPath: string): void {
  const path = join(
    ownerApplicationPath,
    "Contents/Resources/AFTERNOTE_PAYLOAD_MANIFEST.json",
  );
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    format?: unknown;
    version?: unknown;
    entries?: unknown;
  };
  if (parsed.format !== "afternote-signed-payload-manifest" ||
    parsed.version !== 3 || !Array.isArray(parsed.entries)) {
    throw new Error("Signed payload manifest is invalid");
  }
  const expected = (parsed.entries as PayloadManifestEntry[]).filter((entry) =>
    typeof entry?.path === "string" &&
      entry.path.startsWith("Afternote.app/Contents/Resources/AfternoteRuntime/"),
  );
  if (expected.length === 0 ||
    JSON.stringify(expected) !== JSON.stringify(collectEmbeddedRuntimeEntries(ownerApplicationPath))) {
    throw new Error("Embedded runtime does not match its signed manifest");
  }
}

export function verifyApplicationPayloadManifest(ownerApplicationPath: string): void {
  const path = join(
    ownerApplicationPath,
    "Contents/Resources/AFTERNOTE_PAYLOAD_MANIFEST.json",
  );
  const parsed = JSON.parse(readFileSync(path, "utf8")) as {
    format?: unknown;
    version?: unknown;
    entries?: unknown;
  };
  if (parsed.format !== "afternote-signed-payload-manifest" ||
    parsed.version !== 3 || !Array.isArray(parsed.entries)) {
    throw new Error("Signed payload manifest is invalid");
  }
  const expected = (parsed.entries as PayloadManifestEntry[]).filter((entry) =>
    typeof entry?.path === "string" && entry.path.startsWith("Afternote.app/"),
  );
  if (expected.length === 0 ||
    JSON.stringify(expected) !== JSON.stringify(collectApplicationEntries(ownerApplicationPath))) {
    throw new Error("Application does not match its signed payload manifest");
  }
}

export function assertOnlyAllowedPayloadChanges(
  before: PayloadManifestEntry[],
  after: PayloadManifestEntry[],
  allowedPrefixes: string[],
): void {
  const allowed = (path: string) => allowedPrefixes.some((prefix) =>
    path === prefix || path.startsWith(`${prefix}/`),
  );
  const stable = (entries: PayloadManifestEntry[]) => entries.filter((entry) => !allowed(entry.path));
  if (JSON.stringify(stable(before)) !== JSON.stringify(stable(after))) {
    throw new Error("Release payload changed outside the finalizer's allowed mutation set");
  }
}

function parsePayloadManifest(portableRoot: string): {
  format: string;
  version: number;
  entries: PayloadManifestEntry[];
} {
  const parsed = JSON.parse(readFileSync(payloadManifestPath(portableRoot), "utf8")) as {
    format?: unknown;
    version?: unknown;
    entries?: unknown;
  };
  if (parsed.format !== "afternote-signed-payload-manifest" ||
    parsed.version !== 3 || !Array.isArray(parsed.entries)) {
    throw new Error("Signed payload manifest is invalid");
  }
  return parsed as { format: string; version: number; entries: PayloadManifestEntry[] };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function isExcludedApplicationEntry(relativePath: string): boolean {
  return relativePath ===
      "Afternote.app/Contents/Resources/AFTERNOTE_PAYLOAD_MANIFEST.json" ||
    relativePath === "Afternote.app/Contents/MacOS/Afternote" ||
    relativePath === "Afternote.app/Contents/CodeResources" ||
    relativePath === "Afternote.app/Contents/_CodeSignature" ||
    relativePath.startsWith("Afternote.app/Contents/_CodeSignature/");
}
