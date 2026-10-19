import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
const manifestScript = () => import(new URL("../../../scripts/piko-runtime-manifest.mjs", import.meta.url).href) as Promise<{
  createPikoRuntimeManifest: (options: Record<string, unknown>) => Promise<Record<string, unknown>>;
}>;

test("runtime manifest pins the fork, package, provider and immutable asset", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypit-piko-runtime-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const artifact = Buffer.from("fork-runtime");
  await writeFile(join(root, "package.json"), JSON.stringify({
    name: "@hypit/hypit", version: "0.2.16", engines: { node: ">=22.15.0" },
  }));
  await mkdir(join(root, "packages/provider-newapi/src"), { recursive: true });
  await writeFile(join(root, "packages/provider-newapi/package.json"), JSON.stringify({ name: "@dramaclaw/provider-newapi" }));
  await writeFile(join(root, "packages/provider-newapi/src/provider.ts"), "export {}\n");
  await mkdir(join(root, "packages/browser-capture"), { recursive: true });
  await writeFile(join(root, "packages/browser-capture/package.json"), JSON.stringify({ hypit: { captureBrowser: { version: "153.0.8010.12" } } }));
  await writeFile(join(root, "hypit-hypit-0.2.16.tgz"), artifact);
  const { createPikoRuntimeManifest } = await manifestScript();
  const manifest = await createPikoRuntimeManifest({
    sourceRoot: root,
    repository: "https://github.com/dramaclaw/hypit",
    revision: "7cdc9866e8672bb96229df8371e80378b66a615e",
    version: "0.2.16",
    artifactPath: join(root, "hypit-hypit-0.2.16.tgz"),
  });
  assert.deepEqual(manifest, {
    schemaVersion: 1,
    repository: "https://github.com/dramaclaw/hypit",
    revision: "7cdc9866e8672bb96229df8371e80378b66a615e",
    package: "@hypit/hypit",
    version: "0.2.16",
    artifact: {
      url: "https://github.com/dramaclaw/hypit/releases/download/v0.2.16/hypit-hypit-0.2.16.tgz",
      file: "hypit-hypit-0.2.16.tgz",
      sha256: createHash("sha256").update(artifact).digest("hex"),
      bytes: artifact.length,
    },
    provider: "@dramaclaw/provider-newapi",
    node: ">=22.15.0",
    browser: "153.0.8010.12",
  });
});

test("runtime manifest rejects the official Hypit source", async () => {
  const { createPikoRuntimeManifest } = await manifestScript();
  await assert.rejects(
    createPikoRuntimeManifest({
      sourceRoot: process.cwd(),
      repository: "https://github.com/hypit-ai/hypit",
      revision: "7cdc9866e8672bb96229df8371e80378b66a615e",
      version: "0.2.16",
      artifactPath: "/tmp/missing-runtime.tgz",
    }),
    /dramaclaw\/hypit/,
  );
});
