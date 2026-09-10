import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";

type BunMetafile = {
  inputs?: Record<string, unknown>;
};

type PackageMetadata = {
  name: string;
  version: string;
  license: string;
  repository?: string | { url?: string };
};

export type ReleaseSupplyChainArtifacts = {
  sbomPath: string;
  noticesPath: string;
  licenseDirectory: string;
  bundledPackages: Array<{ name: string; version: string; license: string }>;
};

type Component = {
  name: string;
  version: string;
  license: string;
  downloadLocation: string;
  licenseSource: string;
  licenseFilename: string;
  kind: "runtime" | "library" | "native";
};

type BunEmbeddedComponent = {
  name: string;
  license: string;
};

export const BUN_EMBEDDED_COMPONENTS: readonly BunEmbeddedComponent[] = [
  { name: "BoringSSL", license: "NOASSERTION" },
  { name: "brotli", license: "MIT" },
  { name: "libarchive", license: "NOASSERTION" },
  { name: "lol-html", license: "BSD-3-Clause" },
  { name: "ls-hpack", license: "MIT" },
  { name: "ls-qpack", license: "MIT" },
  { name: "lsquic", license: "MIT AND BSD-3-Clause" },
  { name: "mimalloc", license: "MIT" },
  { name: "picohttpparser", license: "Artistic-1.0-Perl OR MIT" },
  { name: "zstd", license: "BSD-3-Clause OR GPL-2.0-only" },
  { name: "simdutf", license: "Apache-2.0" },
  { name: "tinycc", license: "LGPL-2.1-only" },
  { name: "uSockets", license: "Apache-2.0" },
  { name: "zlib-ng", license: "Zlib" },
  { name: "c-ares", license: "MIT" },
  { name: "ICU", license: "ICU" },
  { name: "libbase64", license: "BSD-2-Clause" },
  { name: "libdeflate", license: "MIT" },
  { name: "libjpeg-turbo", license: "NOASSERTION" },
  { name: "libspng", license: "BSD-2-Clause" },
  { name: "libwebp", license: "BSD-3-Clause" },
  { name: "highway", license: "Apache-2.0" },
  { name: "uucode", license: "MIT" },
  { name: "uWebSockets fork", license: "Apache-2.0" },
  { name: "LLVM libc++abi fallback", license: "Apache-2.0 WITH LLVM-exception" },
  { name: "esbuild-derived source", license: "MIT" },
  { name: "assert polyfill", license: "MIT" },
  { name: "browserify-zlib polyfill", license: "MIT" },
  { name: "buffer polyfill", license: "MIT" },
  { name: "constants-browserify polyfill", license: "MIT" },
  { name: "crypto-browserify polyfill", license: "MIT" },
  { name: "domain-browser polyfill", license: "MIT" },
  { name: "events polyfill", license: "MIT" },
  { name: "https-browserify polyfill", license: "MIT" },
  { name: "os-browserify polyfill", license: "MIT" },
  { name: "path-browserify polyfill", license: "MIT" },
  { name: "process polyfill", license: "MIT" },
  { name: "punycode polyfill", license: "MIT" },
  { name: "querystring-es3 polyfill", license: "MIT" },
  { name: "stream-browserify polyfill", license: "MIT" },
  { name: "stream-http polyfill", license: "MIT" },
  { name: "string_decoder polyfill", license: "MIT" },
  { name: "timers-browserify polyfill", license: "MIT" },
  { name: "tty-browserify polyfill", license: "MIT" },
  { name: "url polyfill", license: "MIT" },
  { name: "util polyfill", license: "MIT" },
  { name: "vm-browserify polyfill", license: "MIT" },
];

const LICENSE_CANDIDATES = [
  "LICENSE",
  "LICENSE.md",
  "LICENSE.txt",
  "COPYING",
  "COPYING.md",
];

export function bundledPackageRoots(
  repositoryRoot: string,
  metafilePaths: string[],
): string[] {
  const roots = new Set<string>();
  for (const metafilePath of metafilePaths) {
    const metafile = JSON.parse(readFileSync(metafilePath, "utf8")) as BunMetafile;
    for (const input of Object.keys(metafile.inputs ?? {})) {
      const normalized = input.replaceAll("\\", "/");
      const matches = [...normalized.matchAll(
        /(?:^|\/)node_modules\/(?!\.bun\/)((?:@[^/]+\/)?[^/]+)/g,
      )];
      const match = matches.at(-1);
      if (!match) continue;
      const packageName = match[1];
      const marker = `node_modules/${packageName}`;
      const markerIndex = normalized.lastIndexOf(marker);
      if (markerIndex < 0) continue;
      const packageRoot = resolve(
        repositoryRoot,
        normalized.slice(0, markerIndex + marker.length),
      );
      if (!existsSync(join(packageRoot, "package.json"))) {
        throw new Error(`Bundled package metadata is missing: ${packageName}`);
      }
      roots.add(packageRoot);
    }
  }
  return [...roots].sort();
}

export function writeReleaseSupplyChainArtifacts(options: {
  repositoryRoot: string;
  portableDirectory: string;
  metafilePaths: string[];
  version: string;
  release: boolean;
  semanticRuntimeIncluded: boolean;
}): ReleaseSupplyChainArtifacts {
  const packagingRoot = join(options.repositoryRoot, "apps/local/packaging");
  const applicationMetadata = JSON.parse(
    readFileSync(join(options.repositoryRoot, "package.json"), "utf8"),
  ) as Partial<PackageMetadata>;
  const licenseDirectory = join(options.portableDirectory, "LICENSES");
  rmSync(licenseDirectory, { recursive: true, force: true });
  mkdirSync(licenseDirectory, { recursive: false, mode: 0o755 });

  const components: Component[] = bundledPackageRoots(
    options.repositoryRoot,
    options.metafilePaths,
  ).map((packageRoot) => packageComponent(packageRoot, packagingRoot));
  const nativeInputs = JSON.parse(readFileSync(
    join(options.repositoryRoot, "scripts/native-release-inputs.json"),
    "utf8",
  )) as Record<string, unknown>;
  const nativeReleaseDependencies = join(
    options.repositoryRoot,
    "apps/local/native/release-deps",
  );

  const bunVersion = verifiedVersion("Bun", process.versions.bun, "1.3.14");
  const sqlcipherVersion = requiredVersion(nativeInputs.sqlcipherVersion, "SQLCipher");
  const opensslVersion = requiredVersion(nativeInputs.opensslVersion, "OpenSSL");
  const sparkleVersion = requiredVersion(nativeInputs.sparkleVersion, "Sparkle");

  components.push(
    {
      name: "Bun",
      version: bunVersion,
      license: "MIT",
      downloadLocation: `https://github.com/oven-sh/bun/tree/bun-v${bunVersion}`,
      licenseSource: join(packagingRoot, "BUN_LICENSE.md"),
      licenseFilename: "BUN_LICENSE.md",
      kind: "runtime",
    },
    {
      name: "JavaScriptCore (Bun runtime component)",
      version: `bun-${bunVersion}`,
      license: "LGPL-2.1-only",
      downloadLocation: "https://github.com/oven-sh/webkit",
      licenseSource: join(packagingRoot, "LGPL-2.1.txt"),
      licenseFilename: "LGPL-2.1.txt",
      kind: "runtime",
    },
    {
      name: "SQLCipher Community",
      version: sqlcipherVersion,
      license: "BSD-3-Clause",
      downloadLocation: `https://github.com/sqlcipher/sqlcipher/tree/v${sqlcipherVersion}`,
      licenseSource: join(nativeReleaseDependencies, "SQLCIPHER_LICENSE.txt"),
      licenseFilename: "SQLCIPHER_LICENSE.md",
      kind: "native",
    },
    {
      name: "OpenSSL",
      version: opensslVersion,
      license: "Apache-2.0",
      downloadLocation: `https://github.com/openssl/openssl/tree/openssl-${opensslVersion}`,
      licenseSource: join(nativeReleaseDependencies, "OPENSSL_LICENSE.txt"),
      licenseFilename: "OPENSSL_LICENSE.txt",
      kind: "native",
    },
  );
  if (options.release) {
    components.push({
      name: "Sparkle",
      version: sparkleVersion,
      license: "MIT",
      downloadLocation: `https://github.com/sparkle-project/Sparkle/tree/${sparkleVersion}`,
      licenseSource: join(nativeReleaseDependencies, "SPARKLE_LICENSE.txt"),
      licenseFilename: "SPARKLE_LICENSE.txt",
      kind: "native",
    });
  }
  components.push(...BUN_EMBEDDED_COMPONENTS.map((component) => ({
    name: `Bun embedded: ${component.name}`,
    version: `bundled-with-bun-${bunVersion}`,
    license: component.license,
    downloadLocation: `https://github.com/oven-sh/bun/tree/bun-v${bunVersion}`,
    licenseSource: join(packagingRoot, "BUN_LICENSE.md"),
    licenseFilename: "BUN_LICENSE.md",
    kind: "runtime" as const,
  })));
  if (options.semanticRuntimeIncluded) {
    components.push({
      name: "ONNX Runtime",
      version: "1.21.0",
      license: "MIT",
      downloadLocation: "https://github.com/microsoft/onnxruntime/tree/v1.21.0",
      licenseSource: join(packagingRoot, "ONNXRUNTIME_LICENSE.txt"),
      licenseFilename: "ONNXRUNTIME_LICENSE.txt",
      kind: "native",
    });
  }

  const unique = new Map<string, Component>();
  for (const component of components) {
    const key = `${component.name}@${component.version}`;
    const existing = unique.get(key);
    if (existing && existing.licenseSource !== component.licenseSource) {
      throw new Error(`Conflicting license sources for ${key}`);
    }
    unique.set(key, component);
  }
  const ordered = [...unique.values()].sort((a, b) =>
    `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)
  );

  for (const component of ordered) {
    if (!existsSync(component.licenseSource)) {
      throw new Error(
        `Release license source is missing for ${component.name}: ${component.licenseSource}`,
      );
    }
    copyFileSync(
      component.licenseSource,
      join(licenseDirectory, component.licenseFilename),
    );
  }

  const noticesPath = join(options.portableDirectory, "THIRD_PARTY_NOTICES.md");
  writeFileSync(noticesPath, renderNotices(ordered, options.semanticRuntimeIncluded), {
    mode: 0o644,
  });

  const sbomPath = join(options.portableDirectory, "SBOM.spdx.json");
  writeFileSync(sbomPath, `${JSON.stringify(
    spdxDocument(ordered, options.version, applicationMetadata.license),
    null,
    2,
  )}\n`, { mode: 0o644 });

  return {
    sbomPath,
    noticesPath,
    licenseDirectory,
    bundledPackages: ordered
      .filter((component) => component.kind === "library")
      .map(({ name, version, license }) => ({ name, version, license })),
  };
}

function requiredVersion(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^\d+\.\d+\.\d+$/.test(value)) {
    throw new Error(`Pinned ${name} version is invalid`);
  }
  return value;
}

function packageComponent(packageRoot: string, packagingRoot: string): Component {
  const metadata = JSON.parse(
    readFileSync(join(packageRoot, "package.json"), "utf8"),
  ) as Partial<PackageMetadata>;
  if (!metadata.name || !metadata.version || !metadata.license) {
    throw new Error(`Bundled package lacks name, version, or license: ${packageRoot}`);
  }
  const installedLicenseSource = LICENSE_CANDIDATES
    .map((candidate) => join(packageRoot, candidate))
    .find(existsSync);
  const licenseSource = installedLicenseSource ??
    (metadata.name.startsWith("onnxruntime-")
      ? join(packagingRoot, "ONNXRUNTIME_LICENSE.txt")
      : undefined);
  if (!licenseSource) {
    throw new Error(`Bundled package has no distributable license file: ${metadata.name}`);
  }
  const repository = typeof metadata.repository === "string"
    ? metadata.repository
    : metadata.repository?.url;
  return {
    name: metadata.name,
    version: metadata.version,
    license: metadata.license,
    downloadLocation: normalizeRepository(repository) ?? "NOASSERTION",
    licenseSource,
    licenseFilename: `${safeName(metadata.name)}-${metadata.version}-${basename(licenseSource)}`,
    kind: "library",
  };
}

function normalizeRepository(repository: string | undefined): string | undefined {
  return repository
    ?.replace(/^git\+/, "")
    .replace(/\.git$/, "");
}

function safeName(value: string): string {
  return value.replace(/^@/, "").replaceAll("/", "-").replace(/[^A-Za-z0-9._-]/g, "-");
}

function renderNotices(components: Component[], semantic: boolean): string {
  const lines = [
    "# Third-party notices",
    "",
    "This file is generated from the exact JavaScript module graphs and native libraries",
    "assembled directly by Afternote. Bun and each component identified by Bun's pinned",
    "upstream composite notice are separate packages in the SBOM. Their exact upstream",
    "component revisions are represented by the pinned Bun 1.3.14 source tag when Bun does",
    "not publish a separate version. JavaScriptCore is called out under LGPL-2.1.",
    "The corresponding license texts are in `LICENSES/`; machine-readable inventory is in",
    "`SBOM.spdx.json`.",
    "",
    ...components.flatMap((component) => [
      `- **${component.name} ${component.version}** - ${component.license}`,
      `  License: \`LICENSES/${component.licenseFilename}\``,
    ]),
  ];
  if (semantic) {
    lines.push(
      "",
      "The optional `onnx-community/GIST-all-MiniLM-L6-v2-ONNX` model is not bundled.",
      "Afternote downloads the MIT-licensed model only after an explicit semantic install",
      "and pins revision `c0339fdc3b6e11b7a7e7213695e36e55fcc732d8`.",
    );
  }
  return `${lines.join("\n")}\n`;
}

function spdxDocument(
  components: Component[],
  version: string,
  applicationLicense: string | undefined,
): unknown {
  const dependencyPackages = components.map((component) => ({
    SPDXID: `SPDXRef-Package-${safeName(component.name)}-${safeName(component.version)}`,
    name: component.name,
    versionInfo: component.version,
    downloadLocation: component.downloadLocation,
    filesAnalyzed: false,
    licenseConcluded: "NOASSERTION",
    licenseDeclared: component.license,
    copyrightText: "NOASSERTION",
    externalRefs: component.kind === "library"
      ? [{
          referenceCategory: "PACKAGE-MANAGER",
          referenceType: "purl",
          referenceLocator: npmPackagePurl(component.name, component.version),
        }]
      : [],
  }));
  const digest = createHash("sha256")
    .update(JSON.stringify(dependencyPackages))
    .digest("hex")
    .slice(0, 24);
  const appId = "SPDXRef-Package-Afternote-Local";
  return {
    spdxVersion: "SPDX-2.3",
    dataLicense: "CC0-1.0",
    SPDXID: "SPDXRef-DOCUMENT",
    name: `afternote-local-${version}`,
    documentNamespace: `https://afternote.dev/spdx/afternote-local/${version}/${digest}`,
    creationInfo: {
      created: new Date().toISOString(),
      creators: ["Tool: Afternote release builder"],
    },
    packages: [
      {
        SPDXID: appId,
        name: "Afternote Local",
        versionInfo: version,
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared: applicationLicense ?? "NOASSERTION",
        copyrightText: "Copyright Danny Kim",
      },
      ...dependencyPackages,
    ],
    relationships: [
      { spdxElementId: "SPDXRef-DOCUMENT", relationshipType: "DESCRIBES", relatedSpdxElement: appId },
      ...dependencyPackages.map((component) => ({
        spdxElementId: appId,
        relationshipType: "DEPENDS_ON",
        relatedSpdxElement: component.SPDXID,
      })),
    ],
  };
}

export function npmPackagePurl(name: string, version: string): string {
  if (name.startsWith("@")) {
    const separator = name.indexOf("/");
    if (separator < 2 || separator === name.length - 1) {
      throw new Error(`Invalid scoped npm package name: ${name}`);
    }
    const scope = encodeURIComponent(name.slice(0, separator));
    const packageName = encodeURIComponent(name.slice(separator + 1));
    return `pkg:npm/${scope}/${packageName}@${encodeURIComponent(version)}`;
  }
  return `pkg:npm/${encodeURIComponent(name)}@${encodeURIComponent(version)}`;
}

function verifiedVersion(
  name: string,
  actual: string | undefined,
  expected: string,
  strict = true,
): string {
  if (!actual || (strict && actual !== expected)) {
    throw new Error(
      `${name} release version mismatch: expected ${expected}, received ${actual ?? "missing"}`,
    );
  }
  return actual;
}
