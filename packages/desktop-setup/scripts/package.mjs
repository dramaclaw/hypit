import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { release, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkArtifact, checkExecutable, checkoutRoot, targetFor } from "./check-artifact.mjs";
import { prepareResources } from "./prepare-resources.mjs";
import { writeChecksum } from "./checksums.mjs";

const exec = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
export function packagingEnvironment(env = process.env) {
  return { ...env, CSC_IDENTITY_AUTO_DISCOVERY: "false" };
}
export function validateBuildHost(platform, host = process.platform, version = release()) {
  if (platform === "darwin" && host !== "darwin") throw new Error("DMG 构建需要 macOS；请在 Mac 上运行 npm run desktop:dist:mac。");
  if (platform === "win32" && host !== "win32" && (host !== "darwin" || Number(version.split(".")[0]) < 19)) {
    throw new Error("Windows 交叉构建需要 macOS 10.15 及以上（内置 NSIS 解包器），或在 Windows 上运行 npm run desktop:dist:win。");
  }
}
async function run(command, args, options = {}) {
  const result = await exec(command, args, { cwd: root, env: packagingEnvironment(), maxBuffer: 32 * 1024 * 1024, ...options });
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout;
}
export async function checkBuildPrerequisites(platform, { host = process.platform, arch = process.arch, execute = run } = {}) {
  if (host !== "darwin") return;
  try { await execute("/usr/bin/xcrun", ["--find", "clang"]); }
  catch { throw new Error("缺少 macOS 构建工具；请运行 xcode-select --install 安装 Command Line Tools，然后重新打包。"); }
  if (platform === "win32" && arch === "arm64") {
    // The pinned NSIS mac/makensis binary is x86_64.
    try { await execute("/usr/bin/arch", ["-x86_64", "/usr/bin/true"]); }
    catch { throw new Error("Windows 打包所需的 NSIS 需要 Rosetta；请运行 softwareupdate --install-rosetta 安装后重试。"); }
  }
}
async function npmCli() {
  for (const path of [process.env.npm_execpath, join(dirname(process.execPath), "npm"), join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")].filter(Boolean)) {
    const actual = await realpath(path).catch(() => "");
    if (actual.endsWith("npm-cli.js")) return actual;
  }
  throw new Error("找不到 npm，请安装 Node.js（含 npm）后重新打包。");
}
export async function inspectApp(appRoot, platform, arch) {
  const resources = platform === "darwin" ? join(appRoot, "Contents/Resources") : join(appRoot, "resources");
  const executable = platform === "darwin" ? join(appRoot, "Contents/MacOS/Hypit Setup") : join(appRoot, "Hypit Setup.exe");
  checkExecutable(await readFile(executable), { platform, arch });
  // Electron's app.asar is separate from the independently inventoried runtime.
  const temporary = await mkdtemp(join(tmpdir(), "hypit-inspect-"));
  try {
    const { cp } = await import("node:fs/promises");
    for (const name of ["runtime", "skill", "bin", "resource-manifest.json"]) await cp(join(resources, name), join(temporary, name), { recursive: true, verbatimSymlinks: true });
    await checkArtifact({ out: temporary, platform, arch });
    const asar = require(require.resolve("@electron/asar", { paths: [dirname(require.resolve("electron-builder/package.json"))] }));
    const archive = join(resources, "app.asar");
    assert.ok(!asar.listPackage(archive).some(path => /^[/\\]node_modules[/\\]/.test(path)), "Development dependencies must not be copied into app.asar");
    const pkg = JSON.parse(asar.extractFile(archive, "package.json").toString());
    assert.equal(pkg.main, "dist/main.cjs");
    assert.ok(asar.extractFile(archive, pkg.main).length);
    for (const dependency of ["ali-oss", "koffi"]) assert.ok((await readFile(join(resources, "runtime/node_modules", dependency, "package.json"))).length);
    assert.ok((await readFile(join(resources, "app.asar.unpacked/dist/credential-store/runtime/windows-credential.ps1"))).length);
  } finally { await rm(temporary, { recursive: true, force: true }); }
}
export async function packageDesktop(platform, arch) {
  targetFor({ platform, arch });
  validateBuildHost(platform);
  const npm = await npmCli();
  const builder = require.resolve("electron-builder/cli.js");
  const target = platform === "darwin" ? "mac" : "win";
  const version = JSON.parse(await readFile(join(root, "package.json"), "utf8")).version;
  const artifact = join(root, "release", `Hypit-Setup-${version}-${arch}.${platform === "darwin" ? "dmg" : "exe"}`);
  // Check macOS tooling before packing or downloading dependencies. Current
  // electron-builder extracts the NSIS uninstaller natively on macOS >= 10.15.
  await checkBuildPrerequisites(platform);
  console.log(`Preparing ${platform}/${arch} installer…`);
  // A failed rebuild must not leave a checksum claiming the new artifact passed.
  await rm(`${artifact}.sha256`, { force: true });
  const packed = JSON.parse((await run(process.execPath, [npm, "--silent", "run", "pack:distribution", "--", "--json-path"], { cwd: checkoutRoot })).trim());
  const out = join(root, "resources", `${target}-${arch}`);
  // This fixed, generated target directory never contains user configuration.
  await rm(out, { recursive: true, force: true });
  await prepareResources({ platform, arch, hypitTgz: packed, out });
  await run(process.execPath, [join(root, "scripts/build.mjs")]);
  console.log(await run(process.execPath, [builder, `--${target}`, platform === "darwin" ? "dmg" : "nsis", `--${arch}`, "--publish", "never"]));
  if (platform === "darwin") {
    const mount = await mkdtemp(join(tmpdir(), "hypit-dmg-"));
    let mounted = false;
    try {
      await run("/usr/bin/hdiutil", ["attach", artifact, "-readonly", "-nobrowse", "-mountpoint", mount]); mounted = true;
      await inspectApp(join(mount, "Hypit Setup.app"), platform, arch);
    } finally {
      if (mounted) await run("/usr/bin/hdiutil", ["detach", mount]);
      await rm(mount, { recursive: true, force: true });
    }
  } else {
    const toolModule = require.resolve("app-builder-lib/out/toolsets/7zip.js", { paths: [dirname(require.resolve("electron-builder/package.json"))] });
    const seven = await require(toolModule).getPath7za();
    const extracted = await mkdtemp(join(tmpdir(), "hypit-nsis-"));
    try {
      await run(seven, ["x", "-y", `-o${extracted}`, artifact]);
      await mkdir(join(extracted, "app"));
      await run(seven, ["x", "-y", `-o${join(extracted, "app")}`, join(extracted, "$PLUGINSDIR/app-64.7z")]);
      await inspectApp(join(extracted, "app"), platform, arch);
    } finally { await rm(extracted, { recursive: true, force: true }); }
  }
  console.log(`${artifact}\nSHA-256: ${await writeChecksum(artifact)}`);
  return artifact;
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await packageDesktop(process.argv[2], process.argv[3]); }
  catch (error) { console.error(error.message); if (error.stdout) console.error(error.stdout); if (error.stderr) console.error(error.stderr); process.exitCode = 1; }
}
