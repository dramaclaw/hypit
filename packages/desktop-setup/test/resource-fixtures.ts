import { mkdir, mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { create as createTar } from "tar";
import { createHash } from "node:crypto";

export const checkout = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
export const distributionPath = "runtime/node_modules/@hypit/hypit";
export const loadScript = (name: string) => import(pathToFileURL(join(checkout, "packages/desktop-setup/scripts", name)).href);
export async function put(root: string, path: string, value: string | Buffer) {
  await mkdir(dirname(join(root, path)), { recursive: true });
  await writeFile(join(root, path), value);
}
export function executable(platform: "darwin" | "win32", wrongArch = false) {
  const data = Buffer.alloc(256);
  data.write("fps_mode\0--enable-gpl\0", 200);
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
  await put(packageRoot, "packages/whisperx/src/index.ts", "export const alignment = true;\n");
  for (const [path, value] of Object.entries(extra)) await put(packageRoot, path, value);
  const tarball = join(root, "hypit.tgz");
  await createTar({ file: tarball, cwd: root, gzip: true, portable: true }, ["package"]);
  for (const [path, value] of Object.entries({ "SKILL.md": "# Hypit\nRead references/guide.md", "agents/openai.yaml": "display_name: Hypit", "references/guide.md": "Complete guide", "references/nested/example.svml": "<Video />" })) {
    await put(source, `skills/hypit/${path}`, value);
  }
  const runtime = { name: "hypit-desktop-runtime", version: "1.0.0", private: true, dependencies: {} };
  await put(source, "packages/desktop-setup/runtime-lock/package.json", JSON.stringify(runtime));
  await put(source, "packages/desktop-setup/runtime-lock/package-lock.json", JSON.stringify({ name: runtime.name, version: runtime.version, lockfileVersion: 3, packages: { "": runtime } }));
  const mediaLock = JSON.parse(await readFile(join(checkout, "packages/desktop-setup/media-lock.json"), "utf8"));
  const uvLock: any = { schemaVersion: 1, name: "astral-sh/uv", version: "0.12.20", license: "MIT OR Apache-2.0", targets: {} };
  for (const [platform, arch] of [["darwin", "arm64"], ["win32", "x64"]] as const) {
    const bytes = executable(platform);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    for (const tool of ["ffmpeg", "ffprobe"]) mediaLock.targets[`${platform}-${arch}`][tool] = { url: `https://example.invalid/${tool}`, sha256, bytes: bytes.length };
    await put(source, `packages/desktop-setup/node_modules/.cache/hypit-media/${sha256}`, bytes);
    for (const name of ["COPYING", "SOURCES.md", "VERSIONS.txt"]) await put(source, `packages/desktop-setup/media-licenses/${platform}-${arch}/${name}`, `Fixture ${name}`);
    const archive = platform === "darwin" ? "uv-aarch64-apple-darwin.tar.gz" : "uv-x86_64-pc-windows-msvc.zip";
    uvLock.targets[`${platform}-${arch}`] = {
      url: `https://github.com/astral-sh/uv/releases/download/0.12.20/${archive}`,
      entry: platform === "darwin" ? "uv-aarch64-apple-darwin/uv" : "uv.exe",
      members: platform === "darwin" ? ["uv-aarch64-apple-darwin/", "uv-aarch64-apple-darwin/uv", "uv-aarch64-apple-darwin/uvx"] : ["uv.exe", "uvw.exe", "uvx.exe"],
      archiveSha256: "1".repeat(64), sha256, bytes: bytes.length,
    };
    await put(source, `packages/desktop-setup/node_modules/.cache/hypit-uv/${sha256}`, bytes);
  }
  await put(source, "packages/desktop-setup/uv-lock.json", JSON.stringify(uvLock));
  for (const name of ["LICENSE-APACHE", "LICENSE-MIT"]) await put(source, `packages/desktop-setup/uv-licenses/${name}`, `Fixture ${name}`);
  await put(source, "packages/desktop-setup/media-lock.json", JSON.stringify(mediaLock));
  // Fake only the external process: archive, binary header, hash, inventory and
  // artifact validation remain real. Fixtures are deliberately tiny executables.
  const executeUv = async () => ({ stdout: "uv 0.12.20 (fixture)\n", stderr: "" });
  return { root, checkoutRoot: source, hypitTgz: tarball, out: join(root, "out"), source, executeUv };
}
export async function manifest(out: string) {
  return JSON.parse(await readFile(join(out, "resource-manifest.json"), "utf8"));
}
