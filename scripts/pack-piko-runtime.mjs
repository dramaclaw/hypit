import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPikoRuntimeManifest } from "./piko-runtime-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const output = resolve(process.argv[2] ?? join(root, "dist/release"));
await mkdir(output, { recursive: true });
const expected = `hypit-hypit-${packageManifest.version}.tgz`;
// Always rebuild the versioned archive. Reusing a same-named file can pair a
// stale tarball with a fresh fork/provider manifest after a local rerun.
await rm(join(output, expected), { force: true });
const npmArgs = ["run", "pack:distribution", "--", "--json-path", "--output", output];
const npmCli = process.env.npm_execpath;
if (!npmCli?.endsWith("npm-cli.js")) throw new Error("Run npm run pack:piko-runtime to prepare the Piko Runtime release");
execFileSync(process.execPath, [npmCli, ...npmArgs], { cwd: root, stdio: "inherit" });
const artifacts = (await readdir(output)).filter((name) => name === expected);
if (artifacts.length !== 1) throw new Error(`Expected exactly one ${expected} in ${output}`);
const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
const manifest = await createPikoRuntimeManifest({
  sourceRoot: root,
  repository: "https://github.com/dramaclaw/hypit",
  revision,
  version: packageManifest.version,
  artifactPath: join(output, expected),
});
const manifestPath = join(output, `hypit-runtime-${packageManifest.version}.json`);
await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log(JSON.stringify({ artifact: join(output, expected), manifest: manifestPath, revision }));
