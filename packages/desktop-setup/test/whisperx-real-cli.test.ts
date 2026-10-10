import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

test("real distribution CLI prepares with isolated HOME and no npm until the controlled uv boundary", { skip: process.platform === "win32" }, async t => {
  const root = await mkdtemp(join(tmpdir(), "hypit-no-npm-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const bin = join(root, "bin"); await mkdir(bin);
  // The only PATH executable records the boundary and exits before any network or Python operation.
  await writeFile(join(bin, "uv"), '#!/bin/sh\nprintf "uv boundary reached\\n"\nexit 37\n', { mode: 0o755 });
  const profile = join(root, "profile.json");
  await writeFile(profile, JSON.stringify({ format: "hypit.runtime-local@1", dataRoot: "./data", endpoints: {
    "whisperx.local": { use: "@hypit/provider-whisperx-local", config: { expectedModel: "small", expectedDevice: "cpu", expectedCompute: "int8", alignmentLanguages: ["zh", "en"] } },
  }, bindings: {} }));
  const executable = process.env.HYPIT_TEST_BUNDLED_EXECUTABLE ?? process.execPath;
  const cli = process.env.HYPIT_TEST_BUNDLED_CLI ?? fileURLToPath(new URL("../../../bin/hypit.mjs", import.meta.url));
  const hostState = join(root, "state");
  const result = await promisify(execFile)(executable, [cli, "programs", "prepare", "--runtime", profile, "--endpoint", "whisperx.local", "--json"], {
    cwd: root, env: { HOME: root, PATH: bin, HYPIT_STATE_HOME: hostState, ELECTRON_RUN_AS_NODE: "1" }, timeout: 30_000,
  }).catch((error: { stdout: string; stderr: string }) => error);
  const log = join(hostState, "programs", "whisperx-whisperx.local-127.0.0.1%3A8765", "install.log");
  assert.match(await readFile(log, "utf8").catch(() => `${result.stdout}\n${result.stderr}`), /uv boundary reached/);
  assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /Cannot start npm|npm install/);
  assert.equal(await readdir(join(hostState, "packages")).catch(() => undefined), undefined);
});
