import { randomUUID } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  type Stats,
  writeFileSync,
} from "node:fs";

export function privateRegularFileInfo(path: string): Stats | null {
  if (!existsSync(path)) return null;
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink()) return null;
  if (process.platform !== "win32") {
    if ((info.mode & 0o077) !== 0) return null;
    if (typeof process.getuid === "function" && info.uid !== process.getuid()) {
      return null;
    }
  }
  return info;
}

export function readPrivateText(path: string): string | null {
  return privateRegularFileInfo(path) ? readFileSync(path, "utf8") : null;
}

export function writePrivateFile(path: string, contents: string): void {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomUUID()}`;
  writeFileSync(temporaryPath, contents, { flag: "wx", mode: 0o600 });
  chmodSync(temporaryPath, 0o600);
  renameSync(temporaryPath, path);
}
