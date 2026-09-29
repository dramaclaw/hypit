import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { create as createTar } from "tar";

export const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const distributionPath = "runtime/node_modules/@hypit/hypit";
export const loadScript = (name: string) => import(pathToFileURL(join(checkout, "packages/desktop-setup/scripts", name)).href);
export async function put(root: string, path: string, value: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value);
}
export function executable(platform: "darwin" | "win32", wrongArch = false) {
  const data = Buffer.alloc(256);
  if (platform === "darwin") {
    data.writeUInt32LE(0xfeedfacf, 0);
    data.writeUInt32LE(wrongArch ? 0x01000007 : 0x0100000c, 4);
    data.writeUInt32LE(2, 12);
  } else {
    data.write("MZ");
    data.writeUInt32LE(128, 0x3c);
    data.write("PE\0\0", 128);
    data.writeUInt16LE(wrongArch ? 0xaa64 : 0x8664, 132);
    data.writeUInt16LE(0x20b, 152);
  }
  return data;
}
export async function fixture(extra: Record<string, string> = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "hypit-resource-test-")));
  const source = join(root, "checkout");
  const packageRoot = join(root, "package");
  await put(packageRoot, "package.json", JSON.stringify({ name: "@hypit/hypit", version: "7.8.9", type: "module", bin: { hypit: "bin/hypit.mjs" }, scripts: { postinstall: "exit 99" } }));
  await put(packageRoot, "bin/hypit.mjs", "console.log('7.8.9');\n");
  for (const [path, value] of Object.entries(extra)) await put(packageRoot, path, value);
  const tarball = join(root, "hypit.tgz");
  await createTar({ file: tarball, cwd: root, gzip: true, portable: true }, ["package"]);
  for (const [path, value] of Object.entries({ "SKILL.md": "# Hypit\nRead references/guide.md", "agents/openai.yaml": "display_name: Hypit", "references/guide.md": "Complete guide", "references/nested/example.svml": "<Video />" })) {
    await put(source, `skills/hypit/${path}`, value);
  }
  const runtime = { name: "hypit-desktop-runtime", version: "1.0.0", private: true, dependencies: {} };
  await put(source, "packages/desktop-setup/runtime-lock/package.json", JSON.stringify(runtime));
  await put(source, "packages/desktop-setup/runtime-lock/package-lock.json", JSON.stringify({ name: runtime.name, version: runtime.version, lockfileVersion: 3, packages: { "": runtime } }));
  for (const [platform, arch, version] of [["darwin", "arm64", "4.1.5"], ["win32", "x64", "4.1.0"]] as const) {
    const path = `packages/desktop-setup/node_modules/@ffmpeg-installer/${platform}-${arch}`;
    await put(source, `${path}/package.json`, JSON.stringify({ name: `@ffmpeg-installer/${platform}-${arch}`, version, os: [platform], cpu: [arch] }));
    await put(source, `${path}/ffmpeg${platform === "win32" ? ".exe" : ""}`, executable(platform));
  }
  return { root, checkoutRoot: source, hypitTgz: tarball, out: join(root, "out"), source };
}
export async function manifest(out: string) {
  return JSON.parse(await readFile(join(out, "resource-manifest.json"), "utf8"));
}
