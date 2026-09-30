import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { loadScript } from "./resource-fixtures.js";

const root = new URL("../", import.meta.url);
test("uv lock pins official 0.12.20 assets and licenses for exactly the desktop targets", async () => {
  const lock = JSON.parse(await readFile(new URL("uv-lock.json", root), "utf8"));
  assert.equal(lock.name, "astral-sh/uv"); assert.equal(lock.version, "0.12.20"); assert.equal(lock.license, "MIT OR Apache-2.0");
  assert.deepEqual(Object.keys(lock.targets).sort(), ["darwin-arm64", "win32-x64"]);
  const expected = {
    "darwin-arm64": ["uv-aarch64-apple-darwin.tar.gz", "uv-aarch64-apple-darwin/uv", "848fdeb602ff1a1baacd4f6c8b7bdc6cf1ad026a6d9cf59475fda17c179743ca"],
    "win32-x64": ["uv-x86_64-pc-windows-msvc.zip", "uv.exe", "95f9bc30fbb3574d276e28ac4a6de932d25153645853d13da8c21eec3bc88d06"],
  };
  for (const [key, [archive, entry, checksum]] of Object.entries(expected)) {
    assert.equal(lock.targets[key].url, `https://github.com/astral-sh/uv/releases/download/0.12.20/${archive}`);
    assert.equal(lock.targets[key].entry, entry); assert.equal(lock.targets[key].archiveSha256, checksum);
    assert.match(lock.targets[key].sha256, /^[a-f0-9]{64}$/); assert.ok(lock.targets[key].bytes > 0);
  }
  assert.match(await readFile(new URL("uv-licenses/LICENSE-APACHE", root), "utf8"), /Apache License/);
  assert.match(await readFile(new URL("uv-licenses/LICENSE-MIT", root), "utf8"), /Permission is hereby granted/);
});
test("internal installers use explicit architectures and per-user unsigned settings", async () => {
  const config = parse(await readFile(new URL("electron-builder.yml", root), "utf8"));
  const pkg = JSON.parse(await readFile(new URL("package.json", root), "utf8"));
  assert.equal(pkg.main, "dist/main.cjs");
  assert.equal(config.productName, "Hypit Setup");
  assert.equal(config.appId, "ai.hypit.setup");
  assert.equal(config.asar, true);
  assert.ok(config.files.includes("!node_modules/**"), "only the target-locked runtime supplies native dependencies");
  assert.ok(config.asarUnpack.includes("dist/credential-store/runtime/**"));
  assert.deepEqual(config.extraResources, [{ from: "resources/${os}-${arch}", to: ".", filter: ["**/*"] }]);
  assert.deepEqual(config.mac.target, [{ target: "dmg", arch: ["arm64"] }]);
  assert.equal(config.mac.identity, null);
  assert.equal(config.mac.notarize, false);
  assert.deepEqual(config.win.target, [{ target: "nsis", arch: ["x64"] }]);
  assert.equal(config.win.signAndEditExecutable, false);
  assert.equal(config.win.signExecutable, false, "also disable signing the NSIS installer and uninstaller");
  assert.equal(config.forceCodeSigning, false);
  assert.equal(config.nsis.oneClick, true);
  assert.equal(config.nsis.perMachine, false);
  assert.equal(config.nsis.allowElevation, false);
  assert.equal(config.nsis.packElevateHelper, false);
  assert.equal(config.nsis.runAfterFinish, true);
  assert.equal(config.mac.artifactName, "Hypit-Setup-${version}-${arch}.${ext}");
  assert.equal(config.nsis.artifactName, "Hypit-Setup-${version}-${arch}.${ext}");
});

test("main bundle resolves external dependencies from target runtime resources", async () => {
  const script = await readFile(new URL("scripts/build.mjs", root), "utf8");
  assert.match(script, /module\.paths\.unshift/);
  assert.match(script, /process\.resourcesPath/);
});

test("checksums hash artifact bytes and name the adjacent file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "hypit-checksum-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const artifact = join(directory, "Hypit-Setup-0.1.0-x64.exe");
  await writeFile(artifact, "abc");
  const { writeChecksum } = await loadScript("checksums.mjs");
  await writeChecksum(artifact);
  assert.equal(await readFile(`${artifact}.sha256`, "utf8"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  Hypit-Setup-0.1.0-x64.exe\n");
});

test("packaging disables signing discovery and rejects unsupported cross-build hosts", async () => {
  const { packagingEnvironment, validateBuildHost } = await loadScript("package.mjs");
  assert.equal(packagingEnvironment({ CSC_IDENTITY_AUTO_DISCOVERY: "true" }).CSC_IDENTITY_AUTO_DISCOVERY, "false");
  assert.doesNotThrow(() => validateBuildHost("win32", "darwin", "25.0.0"));
  assert.doesNotThrow(() => validateBuildHost("win32", "win32", "10.0.0"));
  assert.throws(() => validateBuildHost("win32", "darwin", "18.0.0"), /macOS.*10.15/);
  assert.throws(() => validateBuildHost("win32", "linux", "6.0.0"), /Windows.*macOS/);
});

test("Apple Silicon Windows builds explain a missing Rosetta prerequisite before packing", async () => {
  const { checkBuildPrerequisites } = await loadScript("package.mjs");
  await assert.rejects(checkBuildPrerequisites("win32", { host: "darwin", arch: "arm64", execute: async (command: string) => {
    if (command === "/usr/bin/arch") throw new Error("Bad CPU type");
    return "";
  } }), /Rosetta.*softwareupdate --install-rosetta/);
});
