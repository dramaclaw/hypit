import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { desktopPaths } from "../src/paths.js";
import type { AgentSkillTarget } from "../src/agent-targets.js";
import { canRefreshManagedSkill, installManagedSkill, isManagedSkillInstalled, prepareSkillInstall, prepareSkillRemoval, removeManagedSkill, SKILL_MARKER } from "../src/skill-install.js";

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
    await assert.rejects(installManagedSkill({ ...f, copyDirectory: async (_source, destination) => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SKILL.md"), "# Hypit\n");
      if (interrupt) throw new Error("submitted-secret");
    } }), /SKILL_INSTALL_FAILED/);
    assert.equal(await readFile(join(f.target.skillDirectory, "SKILL.md"), "utf8"), "original");
    assert.deepEqual(await readdir(dirname(f.target.skillDirectory)), ["hypit"]);
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

test("the legacy bridge uses exact Codex fields instead of mutable aliases", async (t) => {
  const f = await fixture(t);
  const paths = { ...f.paths, skill: join(dirname(f.paths.skill), "wrong"),
    skillBackup: join(dirname(f.paths.skillBackup), "wrong") };
  await mkdir(paths.legacyCodexSkill, { recursive: true });
  await writeFile(join(paths.legacyCodexSkill, "SKILL.md"), "user copy");
  await installManagedSkill({ paths, sourceDirectory: f.sourceDirectory, installedVersion: "1" });
  assert.equal(await isManagedSkillInstalled(paths), true);
  assert.equal(await readFile(join(paths.legacyCodexSkill, "SKILL.md"), "utf8"), "# Hypit\n");
  assert.equal(await readFile(join(paths.legacyCodexSkillBackup, "SKILL.md"), "utf8"), "user copy");
  await assert.rejects(readFile(join(paths.skill, "SKILL.md")), { code: "ENOENT" });
  await assert.rejects(readFile(join(paths.skillBackup, "SKILL.md")), { code: "ENOENT" });
  assert.equal(await removeManagedSkill({ paths }), true);
  assert.equal(await readFile(join(paths.legacyCodexSkill, "SKILL.md"), "utf8"), "user copy");
});
