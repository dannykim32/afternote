import {
  lstatSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { join, relative } from "node:path";

export type PayloadManifestEntry = {
  path: string;
  sha256: string;
  mode: string;
  bytes: number;
};

export function payloadManifestPath(portableRoot: string): string {
  return join(portableRoot, "Afternote.app/Contents/Resources/AFTERNOTE_PAYLOAD_MANIFEST.json");
}

export function collectPayloadEntries(portableRoot: string): PayloadManifestEntry[] {
  const entries: PayloadManifestEntry[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const relativePath = relative(portableRoot, path);
      if (relativePath === "Afternote.app" || relativePath.startsWith("Afternote.app/")) continue;
      const info = lstatSync(path);
      if (info.isSymbolicLink()) throw new Error(`Release payload contains a symlink: ${relativePath}`);
      if (info.isDirectory()) visit(path);
      else if (info.isFile()) entries.push({
        path: relativePath,
        sha256: sha256(path),
        mode: (info.mode & 0o777).toString(8).padStart(3, "0"),
        bytes: info.size,
      });
      else throw new Error(`Release payload contains a non-regular path: ${relativePath}`);
    }
  };
  visit(portableRoot);
  return entries;
}

export function writePayloadManifest(portableRoot: string): string {
  const path = payloadManifestPath(portableRoot);
  writeFileSync(path, `${JSON.stringify({
    format: "afternote-signed-payload-manifest",
    version: 1,
    entries: collectPayloadEntries(portableRoot),
  }, null, 2)}\n`, { mode: 0o644 });
  return path;
}

export function verifyPayloadManifest(portableRoot: string): void {
  const parsed = JSON.parse(readFileSync(payloadManifestPath(portableRoot), "utf8")) as {
    format?: unknown;
    version?: unknown;
    entries?: unknown;
  };
  if (parsed.format !== "afternote-signed-payload-manifest" ||
    parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    throw new Error("Signed payload manifest is invalid");
  }
  if (JSON.stringify(parsed.entries) !== JSON.stringify(collectPayloadEntries(portableRoot))) {
    throw new Error("Release payload does not match its signed manifest");
  }
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
