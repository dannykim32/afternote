import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import { join, relative } from "node:path";

export function sha256DirectoryTree(root: string): string {
  const hash = createHash("sha256");
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const entry = relative(root, path);
      const info = lstatSync(path);
      const mode = (info.mode & 0o777).toString(8).padStart(3, "0");
      if (info.isSymbolicLink()) {
        hash.update(`link\0${entry}\0${mode}\0${readlinkSync(path)}\0`);
      } else if (info.isDirectory()) {
        hash.update(`directory\0${entry}\0${mode}\0`);
        visit(path);
      } else if (info.isFile()) {
        const contents = readFileSync(path);
        hash.update(`file\0${entry}\0${mode}\0${contents.byteLength}\0`);
        hash.update(contents);
        hash.update("\0");
      } else {
        throw new Error(`Release input is not a regular file, directory, or symlink: ${path}`);
      }
    }
  };
  visit(root);
  return hash.digest("hex");
}
