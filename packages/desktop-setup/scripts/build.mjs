import { mkdir, copyFile, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const outdir = `${root}dist`;
// Native PowerShell cannot read a path inside ASAR. Packaging must unpack this helper.
const credentialModuleUrl = String.raw`require("node:url").pathToFileURL(require("node:path").join(__dirname.replace(/([/\\])app\.asar([/\\])/, "$1app.asar.unpacked$2"), "credential-store", "src", "windows.js")).href`;
await mkdir(outdir, { recursive: true });
await build({ absWorkingDir: root, entryPoints: ["src/main.ts"], outfile: `${outdir}/main.cjs`, bundle: true, platform: "node", format: "cjs", target: "node22",
  // Native/external modules come from the target-locked runtime resources.
  banner: { js: 'if (process.resourcesPath) module.paths.unshift(require("node:path").join(process.resourcesPath, "runtime", "node_modules"));' },
  supported: { "dynamic-import": false },
  external: ["electron", "koffi", "ali-oss", "yaml"],
  plugins: [{ name: "credential-script-location", setup(context) {
    // Preserve the OS adapter's resource-relative lookup when flattening ESM into CJS.
    context.onLoad({ filter: /credential-store-os[/\\]src[/\\]windows\.ts$/ }, async ({ path }) => ({ loader: "ts",
      contents: (await readFile(path, "utf8")).replaceAll("import.meta.url", credentialModuleUrl) }));
  } }], footer: { js: 'startElectronShell(__dirname).catch(() => { process.exitCode = 1; require("electron").app.quit(); });' } });
await build({ absWorkingDir: root, entryPoints: ["src/preload.ts"], outfile: `${outdir}/preload.cjs`, bundle: true, platform: "node", format: "cjs", target: "node22", external: ["electron"] });
await build({ absWorkingDir: root, entryPoints: ["src/cleanup-entry.ts"], outfile: `${outdir}/cleanup.cjs`, bundle: true, platform: "node", format: "cjs", target: "node22",
  footer: { js: 'startIntegrationCleanup().catch(() => { process.stderr.write("本机集成清理失败，用户数据已保留。\\n"); process.exitCode = 1; });' } });
await build({ absWorkingDir: root, entryPoints: ["src/renderer.ts"], outfile: `${outdir}/renderer.js`, bundle: true, platform: "browser", format: "iife", target: "chrome132" });
await Promise.all(["index.html", "styles.css"].map((name) => copyFile(`${root}ui/${name}`, `${outdir}/${name}`)));
await mkdir(`${outdir}/credential-store/runtime`, { recursive: true });
await copyFile(`${root}../credential-store-os/runtime/windows-credential.ps1`, `${outdir}/credential-store/runtime/windows-credential.ps1`);
