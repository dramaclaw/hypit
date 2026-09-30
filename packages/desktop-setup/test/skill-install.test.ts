import assert from "node:assert/strict";
import { promises as mutableFsPromises } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { desktopPaths } from "../src/paths.js";
import type { AgentSkillTarget } from "../src/agent-targets.js";
import { canRefreshManagedSkill, installManagedSkill, isManagedSkillInstalled, prepareLegacyCodexMigration, prepareSkillInstall, prepareSkillRemoval, removeManagedSkill, SKILL_MARKER } from "../src/skill-install.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "hypit 技能 space-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home: root, appData: join(root, "Application Support") });
  const sourceDirectory = join(root, "source");
  await mkdir(join(sourceDirectory, "references", "环境"), { recursive: true });
  await writeFile(join(sourceDirectory, "SKILL.md"), "# Hypit\n");
  await writeFile(join(sourceDirectory, "references", "环境", "guide.md"), Buffer.from([0, 255, 13, 10]));
  const portable: AgentSkillTarget = { id: "portable", label: "通用 Agent Skill", skillDirectory: paths.portableSkill,
    backupDirectory: paths.portableSkillBackup, required: true, detectedAgents: [] };
  const claude: AgentSkillTarget = { id: "claude", label: "Claude Code Skill", skillDirectory: paths.claudeSkill,
    backupDirectory: paths.claudeSkillBackup, required: false, detectedAgents: [] };
  return { paths, target: portable, portable, claude, sourceDirectory, installedVersion: "1.0.0" };
}

test("fresh Skill install validates the entire tree and writes a digest marker; upgrade is idempotent", async (t) => {
  const f = await fixture(t);
  const first = await installManagedSkill(f);
  assert.equal(first.format, "hypit.desktop-managed@2");
  assert.equal(first.target, "portable");
  assert.match(first.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(first.backupDirectory, undefined);
  assert.deepEqual(await readFile(join(f.target.skillDirectory, "references", "环境", "guide.md")), Buffer.from([0, 255, 13, 10]));
  const next = await installManagedSkill({ ...f, installedVersion: "2.0.0" });
  assert.equal(next.installedVersion, "2.0.0");
  assert.equal(next.sourceDigest, first.sourceDigest);
  assert.deepEqual(await readdir(dirname(f.target.skillDirectory)), ["hypit"]);
  assert.equal(await removeManagedSkill(f), true);
  assert.equal(await removeManagedSkill(f), false);
});

test("old Skill stays intact until the complete staging tree is ready", async (t) => {
  const f = await fixture(t);
  await installManagedSkill(f);
  await writeFile(join(f.sourceDirectory, "SKILL.md"), "# New Skill");
  await installManagedSkill({ ...f, copyDirectory: async (source, destination) => {
    assert.equal(dirname(destination), dirname(f.target.skillDirectory));
    assert.equal(await readFile(join(f.target.skillDirectory, "SKILL.md"), "utf8"), "# Hypit\n");
    await cp(source, destination, { recursive: true });
    assert.equal(await readFile(join(f.target.skillDirectory, "SKILL.md"), "utf8"), "# Hypit\n");
  } });
  assert.equal(await readFile(join(f.target.skillDirectory, "SKILL.md"), "utf8"), "# New Skill");
});

test("external Skill backup survives managed upgrades and restores exact original bytes", async (t) => {
  const f = await fixture(t);
  await mkdir(f.target.skillDirectory, { recursive: true });
  const original = Buffer.from([0, 255, 13, 10, 99]);
  await writeFile(join(f.target.skillDirectory, "SKILL.md"), original);
  await writeFile(join(f.target.skillDirectory, "user-file"), "custom");
  const marker = await installManagedSkill(f);
  assert.equal(marker.backupDirectory, f.target.backupDirectory);
  assert.deepEqual(await readFile(join(f.target.backupDirectory, "SKILL.md")), original);
  await installManagedSkill({ ...f, installedVersion: "2" });
  await removeManagedSkill(f);
  assert.deepEqual(await readFile(join(f.target.skillDirectory, "SKILL.md")), original);
  assert.deepEqual((await readdir(f.target.skillDirectory)).sort(), ["SKILL.md", "user-file"]);
  assert.equal(await removeManagedSkill(f), false);
});

test("interrupted or incomplete copy never changes an existing Skill or creates a backup", async (t) => {
  for (const interrupt of [true, false]) {
    const f = await fixture(t);
    await mkdir(f.target.skillDirectory, { recursive: true });
    await writeFile(join(f.target.skillDirectory, "SKILL.md"), "original");
    let interruptedStage: string | undefined;
    await assert.rejects(installManagedSkill({ ...f, copyDirectory: async (_source, destination) => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SKILL.md"), "# Hypit\n");
      if (interrupt) { interruptedStage = destination; throw new Error("submitted-secret"); }
    } }), /SKILL_INSTALL_FAILED/);
    assert.equal(await readFile(join(f.target.skillDirectory, "SKILL.md"), "utf8"), "original");
    if (interrupt) {
      assert.ok(interruptedStage);
      assert.equal(await readFile(join(interruptedStage, "SKILL.md"), "utf8"), "# Hypit\n");
    } else assert.deepEqual(await readdir(dirname(f.target.skillDirectory)), ["hypit"]);
    await assert.rejects(readFile(join(f.target.backupDirectory, "SKILL.md")), { code: "ENOENT" });
  }
});

test("an existing backup is never overwritten and a forged backup location is never restored", async (t) => {
  const f = await fixture(t);
  await mkdir(f.target.skillDirectory, { recursive: true });
  await writeFile(join(f.target.skillDirectory, "SKILL.md"), "original");
  await mkdir(f.target.backupDirectory, { recursive: true });
  await writeFile(join(f.target.backupDirectory, "SKILL.md"), "previous backup");
  await assert.rejects(installManagedSkill(f), /SKILL_INSTALL_FAILED/);
  assert.equal(await readFile(join(f.target.backupDirectory, "SKILL.md"), "utf8"), "previous backup");
  await writeFile(join(f.target.skillDirectory, SKILL_MARKER), JSON.stringify({ format: "hypit.desktop-managed@2", target: "portable", installedVersion: "1", sourceDigest: "a".repeat(64), backupDirectory: f.sourceDirectory }));
  assert.equal(await removeManagedSkill(f), false);
  assert.equal(await readFile(join(f.target.skillDirectory, "SKILL.md"), "utf8"), "original");
});

test("source symlinks are rejected; external symlink Skill is backed up and restored as a link", async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.target.skillDirectory), { recursive: true });
  await symlink(f.sourceDirectory, f.target.skillDirectory, "dir");
  await installManagedSkill(f);
  await removeManagedSkill(f);
  assert.equal(await readFile(join(f.target.skillDirectory, "SKILL.md"), "utf8"), "# Hypit\n");
  await symlink(join(f.sourceDirectory, "SKILL.md"), join(f.sourceDirectory, "references", "link"));
  await assert.rejects(installManagedSkill(f), /SKILL_INSTALL_FAILED/);
});

test("a v2 marker is owned only by its exact target", async (t) => {
  const f = await fixture(t);
  await installManagedSkill(f);
  assert.equal(await isManagedSkillInstalled(f.portable), true);
  assert.equal(await isManagedSkillInstalled({ ...f.portable, id: "claude" }), false);
  assert.equal(await canRefreshManagedSkill({ ...f.portable, id: "claude" }), false);
  assert.equal(await removeManagedSkill({ target: { ...f.portable, id: "claude" } }), false);
});

test("unmanaged content is backed up independently for each target", async (t) => {
  const f = await fixture(t);
  for (const target of [f.portable, f.claude]) {
    await mkdir(target.skillDirectory, { recursive: true });
    await writeFile(join(target.skillDirectory, "SKILL.md"), target.id);
    await installManagedSkill({ target, sourceDirectory: f.sourceDirectory, installedVersion: "1" });
    assert.equal(await readFile(join(target.backupDirectory, "SKILL.md"), "utf8"), target.id);
  }
});

test("a v2 marker with a changed target or backup path is unmanaged", async (t) => {
  const f = await fixture(t);
  const marker = await installManagedSkill(f);
  const markerPath = join(f.portable.skillDirectory, SKILL_MARKER);
  await writeFile(markerPath, JSON.stringify({ ...marker, target: "claude" }));
  assert.equal(await isManagedSkillInstalled(f.portable), false);
  assert.equal(await removeManagedSkill({ target: f.portable }), false);
  await writeFile(markerPath, JSON.stringify({ ...marker, backupDirectory: f.claude.backupDirectory }));
  assert.equal(await isManagedSkillInstalled(f.portable), false);
  assert.equal(await canRefreshManagedSkill(f.portable), false);
  assert.equal(await removeManagedSkill({ target: f.portable }), false);
});

test("a v1 marker is unmanaged in a new target", async (t) => {
  const f = await fixture(t);
  const marker = await installManagedSkill(f);
  await writeFile(join(f.portable.skillDirectory, SKILL_MARKER), JSON.stringify({ ...marker, format: "hypit.desktop-managed@1" }));
  assert.equal(await isManagedSkillInstalled(f.portable), false);
  assert.equal(await canRefreshManagedSkill(f.portable), false);
  assert.equal(await removeManagedSkill({ target: f.portable }), false);
  await assert.rejects(installManagedSkill({ ...f, preserveExisting: true }), /SKILL_INSTALL_FAILED/);
});

test("preparation leaves the live Skill and backup untouched until commit", async (t) => {
  const f = await fixture(t);
  await mkdir(f.portable.skillDirectory, { recursive: true });
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "user copy");
  const prepared = await prepareSkillInstall(f);
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "user copy");
  assert.equal(await isManagedSkillInstalled(f.portable), false);
  await assert.rejects(readFile(join(f.portable.backupDirectory, "SKILL.md")), { code: "ENOENT" });
  await prepared.commit();
  assert.equal(await isManagedSkillInstalled(f.portable), true);
  assert.equal(await readFile(join(f.portable.backupDirectory, "SKILL.md"), "utf8"), "user copy");
  assert.equal(await prepared.rollback(), false);
  await prepared.dispose(false);
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "user copy");
  await assert.rejects(readFile(join(f.portable.backupDirectory, "SKILL.md")), { code: "ENOENT" });
});

test("a backup created after preparation is never replaced at commit", async (t) => {
  const f = await fixture(t);
  await mkdir(f.portable.skillDirectory, { recursive: true });
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "user copy");
  const prepared = await prepareSkillInstall(f);
  await mkdir(f.portable.backupDirectory, { recursive: true });
  await assert.rejects(prepared.commit());
  assert.equal(await prepared.rollback(), false);
  await prepared.dispose(false);
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "user copy");
  assert.deepEqual(await readdir(f.portable.backupDirectory), []);
});

test("a modified v2 Skill is backed up in full before installation", async (t) => {
  const f = await fixture(t);
  await installManagedSkill(f);
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "user edited Skill");
  await installManagedSkill(f);
  assert.equal(await readFile(join(f.portable.backupDirectory, "SKILL.md"), "utf8"), "user edited Skill");
  await removeManagedSkill({ target: f.portable });
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "user edited Skill");
});

test("a modified v2 Skill is unmanaged for removal", async (t) => {
  const f = await fixture(t);
  await installManagedSkill(f);
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "user edited Skill");
  assert.equal(await removeManagedSkill({ target: f.portable }), false);
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "user edited Skill");
});

test("removal commit refuses a Skill modified after preparation", async (t) => {
  const f = await fixture(t);
  await installManagedSkill(f);
  const prepared = await prepareSkillRemoval({ target: f.portable });
  assert.ok(prepared);
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "user edited later");
  await assert.rejects(prepared.commit());
  assert.equal(await prepared.rollback(), false);
  await prepared.dispose(false);
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "user edited later");
});

test("commit refuses content created after an empty-target preparation", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareSkillInstall(f);
  await mkdir(f.portable.skillDirectory, { recursive: true });
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "arrived later");
  await assert.rejects(prepared.commit());
  assert.equal(await prepared.rollback(), false);
  await prepared.dispose(false);
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "arrived later");
  await assert.rejects(readFile(join(f.portable.backupDirectory, "SKILL.md")), { code: "ENOENT" });
});

test("commit refuses changed content after backup staging", async (t) => {
  const f = await fixture(t);
  await mkdir(f.portable.skillDirectory, { recursive: true });
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "before prepare");
  const prepared = await prepareSkillInstall(f);
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "after prepare");
  await assert.rejects(prepared.commit());
  assert.equal(await prepared.rollback(), false);
  await prepared.dispose(false);
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "after prepare");
  await assert.rejects(readFile(join(f.portable.backupDirectory, "SKILL.md")), { code: "ENOENT" });
});

test("outer rollback preserves a committed Skill edited afterward", async (t) => {
  const f = await fixture(t);
  await mkdir(f.portable.skillDirectory, { recursive: true });
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "original user copy");
  await installManagedSkill(f);
  const prepared = await prepareSkillInstall({ ...f, installedVersion: "2" });
  await prepared.commit();
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "user edit after commit");
  assert.equal(await prepared.rollback(), true);
  await prepared.dispose(false);
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "user edit after commit");
  assert.equal(await readFile(join(f.portable.backupDirectory, "SKILL.md"), "utf8"), "original user copy");
});

test("outer rollback preserves a replacement at a freshly committed path", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareSkillInstall(f);
  await prepared.commit();
  await rm(f.portable.skillDirectory, { recursive: true });
  await mkdir(f.portable.skillDirectory, { recursive: true });
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "replacement");
  assert.equal(await prepared.rollback(), true);
  await prepared.dispose(false);
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "replacement");
});

test("outer rollback preserves a published backup edited after install commit", async (t) => {
  const f = await fixture(t);
  await mkdir(f.portable.skillDirectory, { recursive: true });
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "original user copy");
  const prepared = await prepareSkillInstall(f);
  await prepared.commit();
  await writeFile(join(f.portable.backupDirectory, "SKILL.md"), "user edited backup");
  assert.equal(await prepared.rollback(), true);
  await prepared.dispose(false);
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "# Hypit\n");
  assert.equal(await readFile(join(f.portable.backupDirectory, "SKILL.md"), "utf8"), "user edited backup");
  assert.equal((await readdir(dirname(f.portable.skillDirectory))).some((name) => name.startsWith("hypit.previous-")), true);
});

test("successful install cleanup preserves a changed previous tree", async (t) => {
  const f = await fixture(t);
  await installManagedSkill(f);
  const prepared = await prepareSkillInstall({ ...f, installedVersion: "2" });
  await prepared.commit();
  const previous = (await readdir(dirname(f.portable.skillDirectory))).find((name) => name.startsWith("hypit.previous-"));
  assert.ok(previous);
  await writeFile(join(dirname(f.portable.skillDirectory), previous, "SKILL.md"), "user edit to previous");
  assert.ok((await prepared.dispose(true)).some(item => item.reason === "CLEANUP_INCOMPLETE" && item.path === join(dirname(f.portable.skillDirectory), previous)));
  assert.equal(await readFile(join(dirname(f.portable.skillDirectory), previous, "SKILL.md"), "utf8"), "user edit to previous");
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "# Hypit\n");
});

test("install disposal preserves a changed prepared stage", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareSkillInstall(f);
  const stage = (await readdir(dirname(f.portable.skillDirectory))).find((name) => name.startsWith("hypit.stage-"));
  assert.ok(stage);
  await writeFile(join(dirname(f.portable.skillDirectory), stage, "SKILL.md"), "user edit to stage");
  assert.ok((await prepared.dispose(false)).some(item => item.reason === "CLEANUP_INCOMPLETE" && item.path === join(dirname(f.portable.skillDirectory), stage)));
  assert.equal(await readFile(join(dirname(f.portable.skillDirectory), stage, "SKILL.md"), "utf8"), "user edit to stage");
});

test("install commit and disposal preserve a changed backup stage", async (t) => {
  const f = await fixture(t);
  await mkdir(f.portable.skillDirectory, { recursive: true });
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "original user copy");
  const prepared = await prepareSkillInstall(f);
  const backupStage = (await readdir(dirname(f.portable.backupDirectory))).find((name) => name.startsWith("hypit.stage-"));
  assert.ok(backupStage);
  const stagedPath = join(dirname(f.portable.backupDirectory), backupStage);
  await writeFile(join(stagedPath, "SKILL.md"), "user edit to backup stage");
  await assert.rejects(prepared.commit());
  assert.equal(await prepared.rollback(), false);
  assert.ok((await prepared.dispose(false)).some(item => item.reason === "CLEANUP_INCOMPLETE" && item.path === stagedPath));
  assert.equal(await readFile(join(stagedPath, "SKILL.md"), "utf8"), "user edit to backup stage");
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "original user copy");
});

test("install commit refuses a required backup stage that disappeared", async (t) => {
  const f = await fixture(t);
  await mkdir(f.portable.skillDirectory, { recursive: true });
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "original user copy");
  const prepared = await prepareSkillInstall(f);
  const backupStage = (await readdir(dirname(f.portable.backupDirectory))).find((name) => name.startsWith("hypit.stage-"));
  assert.ok(backupStage);
  const displaced = join(dirname(f.portable.backupDirectory), "displaced-backup");
  await mutableFsPromises.rename(join(dirname(f.portable.backupDirectory), backupStage), displaced);
  await assert.rejects(prepared.commit());
  assert.equal(await prepared.rollback(), false);
  await prepared.dispose(false);
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "original user copy");
  assert.equal(await readFile(join(displaced, "SKILL.md"), "utf8"), "original user copy");
  await assert.rejects(readFile(join(f.portable.backupDirectory, "SKILL.md")), { code: "ENOENT" });
});

test("post-rename Skill mismatch never becomes rollback ownership", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareSkillInstall(f);
  const originalRename = mutableFsPromises.rename;
  mutableFsPromises.rename = async (source, destination) => {
    await originalRename(source, destination);
    if (destination === f.portable.skillDirectory && typeof source === "string" && source.includes(".stage-"))
      await writeFile(join(destination, "SKILL.md"), "user edit at publication");
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepared.commit());
  } finally {
    mutableFsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(await prepared.rollback(), true);
  await prepared.dispose(false);
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "user edit at publication");
});

test("post-rename backup mismatch never becomes deletion ownership", async (t) => {
  const f = await fixture(t);
  await mkdir(f.portable.skillDirectory, { recursive: true });
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "original user copy");
  const prepared = await prepareSkillInstall(f);
  const originalRename = mutableFsPromises.rename;
  mutableFsPromises.rename = async (source, destination) => {
    await originalRename(source, destination);
    if (destination === f.portable.backupDirectory)
      await writeFile(join(destination, "SKILL.md"), "user edit at backup publication");
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepared.commit());
  } finally {
    mutableFsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
  assert.equal(await prepared.rollback(), true);
  await prepared.dispose(false);
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "original user copy");
  assert.equal(await readFile(join(f.portable.backupDirectory, "SKILL.md"), "utf8"), "user edit at backup publication");
});

test("symlink backup publication uses exclusive creation", async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.portable.skillDirectory), { recursive: true });
  await symlink(f.sourceDirectory, f.portable.skillDirectory, "dir");
  const prepared = await prepareSkillInstall(f);
  const originalRename = mutableFsPromises.rename;
  mutableFsPromises.rename = async (source, destination) => {
    if (destination === f.portable.backupDirectory) throw new Error("symlink rename must not publish");
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try { await prepared.commit(); }
  finally { mutableFsPromises.rename = originalRename; syncBuiltinESMExports(); }
  await prepared.dispose(true);
  assert.equal((await lstat(f.portable.backupDirectory)).isSymbolicLink(), true);
});

test("symlink previous-tree moves use exclusive creation through rollback", async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.portable.skillDirectory), { recursive: true });
  await symlink(f.sourceDirectory, f.portable.skillDirectory, "dir");
  const prepared = await prepareSkillInstall(f);
  const originalRename = mutableFsPromises.rename;
  mutableFsPromises.rename = async (source, destination) => {
    if ((source === f.portable.skillDirectory && typeof destination === "string" && destination.includes(".previous-"))
      || (typeof source === "string" && source.includes(".previous-") && destination === f.portable.skillDirectory))
      throw new Error("symlink rename must not move previous tree");
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try {
    await prepared.commit();
    assert.equal(await prepared.rollback(), false);
  } finally {
    mutableFsPromises.rename = originalRename;
    syncBuiltinESMExports();
  }
  await prepared.dispose(false);
  assert.equal((await lstat(f.portable.skillDirectory)).isSymbolicLink(), true);
});

test("file backup and restore publication use exclusive creation", async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.portable.skillDirectory), { recursive: true });
  await writeFile(f.portable.skillDirectory, "user file");
  const prepared = await prepareSkillInstall(f);
  const originalRename = mutableFsPromises.rename;
  mutableFsPromises.rename = async (source, destination) => {
    if (destination === f.portable.backupDirectory) throw new Error("file rename must not publish");
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try { await prepared.commit(); }
  finally { mutableFsPromises.rename = originalRename; syncBuiltinESMExports(); }
  await prepared.dispose(true);
  assert.equal(await readFile(f.portable.backupDirectory, "utf8"), "user file");
  const removal = await prepareSkillRemoval({ target: f.portable });
  assert.ok(removal);
  mutableFsPromises.rename = async (source, destination) => {
    if (destination === f.portable.skillDirectory && typeof source === "string" && source.includes(".restore-")) throw new Error("file rename must not restore");
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try { await removal.commit(); }
  finally { mutableFsPromises.rename = originalRename; syncBuiltinESMExports(); }
  await removal.dispose(true);
  assert.equal(await readFile(f.portable.skillDirectory, "utf8"), "user file");
});

test("symlink removal rollback uses exclusive restoration staging", async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.portable.skillDirectory), { recursive: true });
  await symlink(f.sourceDirectory, f.portable.skillDirectory, "dir");
  await installManagedSkill(f);
  const removal = await prepareSkillRemoval({ target: f.portable });
  assert.ok(removal);
  await removal.commit();
  const originalRename = mutableFsPromises.rename;
  mutableFsPromises.rename = async (source, destination) => {
    if (source === f.portable.skillDirectory && typeof destination === "string" && destination.includes(".restore-"))
      throw new Error("symlink rename must not stage rollback");
    return originalRename(source, destination);
  };
  syncBuiltinESMExports();
  try { assert.equal(await removal.rollback(), false); }
  finally { mutableFsPromises.rename = originalRename; syncBuiltinESMExports(); }
  await removal.dispose(false);
  assert.equal(await isManagedSkillInstalled(f.portable), true);
});

test("preparation preserves a replaced stage when copy fails", async (t) => {
  const f = await fixture(t);
  let recoveryPath = "";
  await assert.rejects(prepareSkillInstall({ ...f, copyDirectory: async (_source, destination) => {
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "SKILL.md"), "incomplete copy");
    await rm(destination, { recursive: true });
    await mkdir(destination, { recursive: true });
    await writeFile(join(destination, "SKILL.md"), "user replacement");
    recoveryPath = destination;
    throw new Error("copy failed");
  } }), (error: unknown) => error instanceof Error && error.message.includes(recoveryPath));
  assert.equal(await readFile(join(recoveryPath, "SKILL.md"), "utf8"), "user replacement");
});

test("preparation preserves an unverified backup stage when its copy fails", async (t) => {
  const f = await fixture(t);
  await mkdir(f.portable.skillDirectory, { recursive: true });
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "original user copy");
  let recoveryPath = "";
  const originalCp = mutableFsPromises.cp;
  mutableFsPromises.cp = async (source, destination, options) => {
    if (source === f.portable.skillDirectory && typeof destination === "string") {
      recoveryPath = destination;
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SKILL.md"), "partial backup");
      throw new Error("backup copy failed");
    }
    return originalCp(source, destination, options);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepareSkillInstall(f), (error: unknown) => error instanceof Error && error.message.includes(recoveryPath));
  } finally {
    mutableFsPromises.cp = originalCp;
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(join(recoveryPath, "SKILL.md"), "utf8"), "partial backup");
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "original user copy");
});

test("removal preparation preserves an unverified restore stage when copy fails", async (t) => {
  const f = await fixture(t);
  await mkdir(f.portable.skillDirectory, { recursive: true });
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "original user copy");
  await installManagedSkill(f);
  let recoveryPath = "";
  const originalCp = mutableFsPromises.cp;
  mutableFsPromises.cp = async (source, destination, options) => {
    if (source === f.portable.backupDirectory && typeof destination === "string") {
      recoveryPath = destination;
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SKILL.md"), "partial restore");
      throw new Error("restore copy failed");
    }
    return originalCp(source, destination, options);
  };
  syncBuiltinESMExports();
  try {
    await assert.rejects(prepareSkillRemoval({ target: f.portable }),
      (error: unknown) => error instanceof Error && error.message.includes(recoveryPath));
  } finally {
    mutableFsPromises.cp = originalCp;
    syncBuiltinESMExports();
  }
  assert.equal(await readFile(join(recoveryPath, "SKILL.md"), "utf8"), "partial restore");
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "# Hypit\n");
});

test("removal commit preserves a backup changed after preparation", async (t) => {
  const f = await fixture(t);
  await mkdir(f.portable.skillDirectory, { recursive: true });
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "original user copy");
  await installManagedSkill(f);
  const prepared = await prepareSkillRemoval({ target: f.portable });
  assert.ok(prepared);
  await writeFile(join(f.portable.backupDirectory, "SKILL.md"), "changed user backup");
  await assert.rejects(prepared.commit());
  assert.equal(await prepared.rollback(), false);
  await prepared.dispose(false);
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "# Hypit\n");
  assert.equal(await readFile(join(f.portable.backupDirectory, "SKILL.md"), "utf8"), "changed user backup");
  assert.deepEqual(await readdir(dirname(f.portable.skillDirectory)), ["hypit"]);
});

test("outer removal rollback preserves a restored Skill edited after commit", async (t) => {
  const f = await fixture(t);
  await mkdir(f.portable.skillDirectory, { recursive: true });
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "original user copy");
  await installManagedSkill(f);
  const prepared = await prepareSkillRemoval({ target: f.portable });
  assert.ok(prepared);
  await prepared.commit();
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "user edit after removal");
  assert.equal(await prepared.rollback(), true);
  await prepared.dispose(false);
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "user edit after removal");
  assert.equal(await readFile(join(f.portable.backupDirectory, "SKILL.md"), "utf8"), "original user copy");
  assert.equal((await readdir(dirname(f.portable.skillDirectory))).some((name) => name.startsWith("hypit.removed-")), true);
});

test("successful removal cleanup preserves an original backup edited after commit", async (t) => {
  const f = await fixture(t);
  await mkdir(f.portable.skillDirectory, { recursive: true });
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "original user copy");
  await installManagedSkill(f);
  const prepared = await prepareSkillRemoval({ target: f.portable });
  assert.ok(prepared);
  await prepared.commit();
  await writeFile(join(f.portable.backupDirectory, "SKILL.md"), "user edit after removal");
  assert.ok((await prepared.dispose(true)).some(item => item.reason === "CLEANUP_INCOMPLETE" && item.path === f.portable.backupDirectory));
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "original user copy");
  assert.equal(await readFile(join(f.portable.backupDirectory, "SKILL.md"), "utf8"), "user edit after removal");
  assert.equal((await readdir(dirname(f.portable.skillDirectory))).some((name) => name.startsWith("hypit.removed-")), true);
});

test("removal disposal preserves a changed restore stage", async (t) => {
  const f = await fixture(t);
  await mkdir(f.portable.skillDirectory, { recursive: true });
  await writeFile(join(f.portable.skillDirectory, "SKILL.md"), "original user copy");
  await installManagedSkill(f);
  const prepared = await prepareSkillRemoval({ target: f.portable });
  assert.ok(prepared);
  const restore = (await readdir(dirname(f.portable.skillDirectory))).find((name) => name.startsWith("hypit.restore-"));
  assert.ok(restore);
  const restorePath = join(dirname(f.portable.skillDirectory), restore);
  await writeFile(join(restorePath, "SKILL.md"), "user edit to restore stage");
  assert.ok((await prepared.dispose(false)).some(item => item.reason === "CLEANUP_INCOMPLETE" && item.path === restorePath));
  assert.equal(await readFile(join(restorePath, "SKILL.md"), "utf8"), "user edit to restore stage");
});

test("legacy migration ignores v1 markers at portable and Claude targets", async (t) => {
  const f = await fixture(t);
  for (const target of [f.portable, f.claude]) {
    const marker = await installManagedSkill({ ...f, target });
    await writeFile(join(target.skillDirectory, SKILL_MARKER), JSON.stringify({ ...marker, format: "hypit.desktop-managed@1" }));
    assert.equal(await prepareLegacyCodexMigration(f.paths), undefined);
    assert.equal(await isManagedSkillInstalled(target), false);
    assert.equal(await prepareSkillRemoval({ target }), undefined);
    assert.equal(await readFile(join(target.skillDirectory, "SKILL.md"), "utf8"), "# Hypit\n");
  }
});
