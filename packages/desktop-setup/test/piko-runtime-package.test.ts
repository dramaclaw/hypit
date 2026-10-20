import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));

test("Piko Runtime packaging writes both artifacts to the requested output directory", async (t) => {
  const output = await mkdtemp(join(tmpdir(), "hypit-piko-runtime-package-"));
  t.after(() => rm(output, { recursive: true, force: true }));

  const npmCli = process.env.npm_execpath;
  const npmInvocation = npmCli?.endsWith("npm-cli.js")
    ? [process.execPath, npmCli]
    : [process.platform === "win32" ? "npm.cmd" : "npm"];
  const result = spawnSync(npmInvocation[0]!, [...npmInvocation.slice(1), "run", "pack:piko-runtime", "--", output], {
    cwd: root,
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);

  const manifest = JSON.parse(await readFile(join(output, "hypit-runtime-0.2.16.json"), "utf8"));
  assert.equal(manifest.artifact.file, "hypit-hypit-0.2.16.tgz");
  assert.equal(manifest.artifact.bytes > 0, true);
});
