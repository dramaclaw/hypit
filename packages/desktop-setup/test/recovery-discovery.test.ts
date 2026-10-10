import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { desktopPaths } from "../src/paths.js";
import { transactionRecoveryWarnings, whisperXRecoveryIncomplete } from "../src/recovery-discovery.js";

test("transaction recovery discovery reports only exact approved siblings in sorted order", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hypit-recovery-scan-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home, appData: join(home, "appdata") });
  const approved = [paths.launcher, paths.managedState, join(home, ".zprofile"), paths.profile];
  for (const path of approved) {
    await mkdir(`${path}.recovery-Z9a8B7`, { recursive: true });
    await mkdir(`${path}.recovery-A1b2C3`, { recursive: true });
    await mkdir(`${path}.recovery-A1b2C3-extra`, { recursive: true });
    await writeFile(`${path}.recovery-Q9w8E7`, "unrelated file");
  }
  await mkdir(join(home, "unrelated", `${basename(paths.launcher)}.recovery-A1b2C3`), { recursive: true });
  const warnings = await transactionRecoveryWarnings({ paths, home, platform: "darwin" });
  assert.deepEqual(warnings.map(item => item.path), approved.flatMap(path => [`${path}.recovery-A1b2C3`, `${path}.recovery-Z9a8B7`]));
  assert.ok(warnings.every(item => item.reason === "CLEANUP_INCOMPLETE" && item.status === "warning"));
  assert.deepEqual(warnings.map(item => item.code), ["launcher", "launcher", "launcher", "launcher", "launcher", "launcher", "profile", "profile"]);
  assert.doesNotMatch(JSON.stringify(warnings), /unrelated file|extra/u);
});

test("transaction recovery discovery reports symlinks without reading their target", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hypit-recovery-link-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home, appData: join(home, "appdata") });
  const secret = join(home, "private-secret");
  await writeFile(secret, "NEVER_DISCLOSE_THIS");
  await mkdir(dirname(paths.profile), { recursive: true });
  await symlink(secret, `${paths.profile}.recovery-A1b2C3`);
  const warnings = await transactionRecoveryWarnings({ paths, home, platform: "win32" });
  assert.deepEqual(warnings.filter(item => item.path).map(item => item.path), [`${paths.profile}.recovery-A1b2C3`]);
  assert.doesNotMatch(JSON.stringify(warnings), /NEVER_DISCLOSE_THIS|private-secret/u);
});

test("transaction recovery discovery caps per-parent work and result count", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hypit-recovery-bound-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home, appData: join(home, "appdata") });
  await mkdir(dirname(paths.profile), { recursive: true });
  for (let i = 0; i < 300; i++) await mkdir(`${paths.profile}.recovery-${String(i).padStart(6, "0")}`);
  const warnings = await transactionRecoveryWarnings({ paths, home, platform: "darwin" });
  assert.ok(warnings.length <= 9);
  assert.ok(warnings.some(item => item.code === "profile" && item.path === undefined));
  assert.ok(warnings.every(item => item.reason === "CLEANUP_INCOMPLETE"));
});

test("WhisperX recovery scans only exact siblings, never follows candidate links, and is bounded", async t => {
  const home = await mkdtemp(join(tmpdir(), "hypit-whisperx-recovery-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home, appData: home });
  await mkdir(dirname(paths.profile), { recursive: true });
  for (const name of [".whisperx-user.json", ".whisperx-00000000-0000-0000-0000-000000000000.json", ".recovery-user-edits"]) {
    await writeFile(paths.profile + name, "unrelated");
  }
  assert.equal(await whisperXRecoveryIncomplete(paths), false);
  const candidate = `${paths.profile}.whisperx-00000000-0000-4000-8000-000000000001.json`;
  await symlink(join(home, "nonexistent-secret-target"), candidate);
  assert.equal(await whisperXRecoveryIncomplete(paths), true);
  await rm(candidate);
  await mkdir(`${candidate}.zh.json.recovery-A1b2C3`);
  assert.equal(await whisperXRecoveryIncomplete(paths), true);
  await rm(`${candidate}.zh.json.recovery-A1b2C3`, { recursive: true });
  for (let index = 0; index < 260; index++) await writeFile(join(dirname(paths.profile), `unrelated-${index}`), "keep");
  assert.equal(await whisperXRecoveryIncomplete(paths), true, "an incomplete bounded scan cannot clear the warning");
});
