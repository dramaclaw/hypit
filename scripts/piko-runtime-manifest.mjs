import { createHash } from "node:crypto";
import { basename, join } from "node:path";
import { readFile, stat } from "node:fs/promises";

export const FORK_REPOSITORY = "https://github.com/dramaclaw/hypit";
export const PROVIDER_PACKAGE = "@dramaclaw/provider-newapi";

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function fullRevision(revision) {
  if (!/^[0-9a-f]{40}$/u.test(revision)) throw new Error("Runtime revision must be a full 40-character Git SHA");
}

export async function createPikoRuntimeManifest({ sourceRoot, repository, revision, version, artifactPath }) {
  if (repository !== FORK_REPOSITORY) throw new Error(`Runtime source must be ${FORK_REPOSITORY}`);
  fullRevision(revision);
  const packageManifest = JSON.parse(await readFile(join(sourceRoot, "package.json"), "utf8"));
  if (packageManifest.name !== "@hypit/hypit") throw new Error("Runtime package must be @hypit/hypit");
  if (packageManifest.version !== version) throw new Error("Runtime version does not match package.json");
  if (packageManifest.engines?.node !== ">=22.15.0") throw new Error("Runtime must require Node.js >=22.15.0");
  const provider = JSON.parse(await readFile(join(sourceRoot, "packages/provider-newapi/package.json"), "utf8"));
  if (provider.name !== PROVIDER_PACKAGE) throw new Error(`Runtime provider must be ${PROVIDER_PACKAGE}`);
  await stat(join(sourceRoot, "packages/provider-newapi/src/provider.ts"));
  const browserPackage = JSON.parse(await readFile(join(sourceRoot, "packages/browser-capture/package.json"), "utf8"));
  const browser = browserPackage.hypit?.captureBrowser?.version;
  if (browser !== "153.0.8010.12") throw new Error("Runtime must pin Chrome for Testing 153.0.8010.12");
  const bytes = await readFile(artifactPath);
  const file = basename(artifactPath);
  if (file !== `hypit-hypit-${version}.tgz`) throw new Error("Runtime artifact filename does not match package version");
  return {
    schemaVersion: 1,
    repository,
    revision,
    package: packageManifest.name,
    version,
    artifact: {
      url: `${FORK_REPOSITORY}/releases/download/v${version}/${file}`,
      file,
      sha256: sha256(bytes),
      bytes: bytes.length,
    },
    provider: PROVIDER_PACKAGE,
    node: packageManifest.engines.node,
    browser,
  };
}
