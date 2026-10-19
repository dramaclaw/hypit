import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createPikoRuntimeManifest } from "./piko-runtime-manifest.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packageManifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const output = resolve(process.argv[2] ?? join(root, "dist/release"));
await mkdir(output, { recursive: true });
const expected = `hypit-hypit-${packageManifest.version}.tgz`;
let artifacts = (await readdir(output)).filter((name) => name === expected);
if (artifacts.length === 0) {
  execFileSync("npm", ["run", "pack:distribution", "--", "--json-path"], { cwd: root, stdio: "inherit" });
  artifacts = (await readdir(output)).filter((name) => name === expected);
}
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
