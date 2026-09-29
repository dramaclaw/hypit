import { execFile } from "node:child_process";
import { chmod, copyFile, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { checkArtifact, checkExecutable, checkoutRoot, cliOptions, digest, distributionPath, inventory, knownProfiles, resourceDigests, targetFor } from "./check-artifact.mjs";

const exec = promisify(execFile);
async function npmCliPath() {
  const candidates = [process.env.npm_execpath, join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"), join(dirname(process.execPath), "npm")].filter(Boolean);
  for (const candidate of candidates) {
    const path = await realpath(candidate).catch(() => "");
    if (path.endsWith("npm-cli.js")) return path;
  }
  throw new Error("npm CLI not found; run through npm or install npm alongside Node.js");
}

export async function prepareResources({ platform, arch, hypitTgz, out, checkoutRoot: sourceRoot = checkoutRoot }) {
  const target = targetFor({ platform, arch });
  const output = resolve(out);
  if (await lstat(output).catch(error => { if (error.code === "ENOENT") return null; throw error; })) throw new Error(`Output already exists: ${output}`);
  const tarball = resolve(hypitTgz);
  const tarballDigest = digest(await readFile(tarball));
  const ffmpegRoot = join(sourceRoot, "packages/desktop-setup/node_modules", target.name);
  const ffmpeg = JSON.parse(await readFile(join(ffmpegRoot, "package.json"), "utf8"));
  if (ffmpeg.name !== target.name || ffmpeg.version !== target.version || !ffmpeg.os?.includes(platform) || !ffmpeg.cpu?.includes(arch)) throw new Error(`FFmpeg must match pinned target package ${target.name}@${target.version}`);
  const executable = join(ffmpegRoot, target.executable);
  checkExecutable(await readFile(executable), target);
  // Validate the entire source Skill before copying anything, including links.
  await inventory(join(sourceRoot, "skills/hypit"));
  await mkdir(dirname(output), { recursive: true });
  const stage = await mkdtemp(join(dirname(output), ".hypit-resources-"));
  try {
    await mkdir(join(stage, "runtime"));
    // Target flags select optional native dependencies for the artifact, not the
    // build host. No lock/save files: those would embed local temporary tgz paths.
    await exec(process.execPath, [await npmCliPath(), "install", "--prefix", join(stage, "runtime"), "--omit=dev", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", "--no-save", `--os=${platform}`, `--cpu=${arch}`, tarball], { cwd: stage, maxBuffer: 8 * 1024 * 1024 });
    const strippedProfiles = [];
    for (const path of knownProfiles) {
      const fullPath = join(stage, path);
      const info = await lstat(fullPath).catch(error => { if (error.code === "ENOENT") return null; throw error; });
      if (info) {
        if (!info.isFile()) throw new Error(`Forbidden non-file example profile: ${path}`);
        await rm(fullPath);
        strippedProfiles.push(path);
      }
    }
    await mkdir(join(stage, "skill"));
    await cp(join(sourceRoot, "skills/hypit"), join(stage, "skill/hypit"), { recursive: true, dereference: false });
    await mkdir(join(stage, "bin"));
    await copyFile(executable, join(stage, "bin", target.executable));
    await chmod(join(stage, "bin", target.executable), 0o755);
    const files = await inventory(stage, { target, allowBinLinks: true });
    const installed = JSON.parse(await readFile(join(stage, distributionPath, "package.json"), "utf8"));
    const manifest = { schemaVersion: 1, platform, arch, hypit: { name: installed.name, version: installed.version, tarball: tarballDigest }, ffmpeg: { name: target.name, version: target.version }, strippedProfiles, files, resources: resourceDigests(files) };
    await writeFile(join(stage, "resource-manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
    await checkArtifact({ out: stage, platform, arch, checkoutRoot: sourceRoot });
    await rename(stage, output);
    return manifest;
  } finally { await rm(stage, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { const options = cliOptions(true); await prepareResources(options); console.log(`Desktop resources staged at ${resolve(options.out)}`); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
