import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { desktopPaths } from "../src/paths.js";
import { installManagedSkill, removeManagedSkill, SKILL_MARKER } from "../src/skill-install.js";

async function fixture(t: TestContext) {
  const root = await mkdtemp(join(tmpdir(), "hypit 技能 space-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home: root, appData: join(root, "Application Support") });
  const sourceDirectory = join(root, "source");
  await mkdir(join(sourceDirectory, "references", "环境"), { recursive: true });
  await writeFile(join(sourceDirectory, "SKILL.md"), "# Hypit\n");
  await writeFile(join(sourceDirectory, "references", "环境", "guide.md"), Buffer.from([0, 255, 13, 10]));
  return { paths, sourceDirectory, installedVersion: "1.0.0" };
}

test("fresh Skill install validates the entire tree and writes a digest marker; upgrade is idempotent", async (t) => {
  const f = await fixture(t);
  const first = await installManagedSkill(f);
  assert.equal(first.format, "hypit.desktop-managed@1");
  assert.match(first.sourceDigest, /^[a-f0-9]{64}$/);
  assert.equal(first.backupDirectory, undefined);
  assert.deepEqual(await readFile(join(f.paths.skill, "references", "环境", "guide.md")), Buffer.from([0, 255, 13, 10]));
  const next = await installManagedSkill({ ...f, installedVersion: "2.0.0" });
  assert.equal(next.installedVersion, "2.0.0");
  assert.equal(next.sourceDigest, first.sourceDigest);
  assert.deepEqual(await readdir(dirname(f.paths.skill)), ["hypit"]);
  assert.equal(await removeManagedSkill(f), true);
  assert.equal(await removeManagedSkill(f), false);
});

test("old Skill stays intact until the complete staging tree is ready", async (t) => {
  const f = await fixture(t);
  await installManagedSkill(f);
  await writeFile(join(f.sourceDirectory, "SKILL.md"), "# New Skill");
  await installManagedSkill({ ...f, copyDirectory: async (source, destination) => {
    assert.equal(dirname(destination), dirname(f.paths.skill));
    assert.equal(await readFile(join(f.paths.skill, "SKILL.md"), "utf8"), "# Hypit\n");
    await cp(source, destination, { recursive: true });
    assert.equal(await readFile(join(f.paths.skill, "SKILL.md"), "utf8"), "# Hypit\n");
  } });
  assert.equal(await readFile(join(f.paths.skill, "SKILL.md"), "utf8"), "# New Skill");
});

test("external Skill backup survives managed upgrades and restores exact original bytes", async (t) => {
  const f = await fixture(t);
  await mkdir(f.paths.skill, { recursive: true });
  const original = Buffer.from([0, 255, 13, 10, 99]);
  await writeFile(join(f.paths.skill, "SKILL.md"), original);
  await writeFile(join(f.paths.skill, "user-file"), "custom");
  const marker = await installManagedSkill(f);
  assert.equal(marker.backupDirectory, f.paths.skillBackup);
  assert.deepEqual(await readFile(join(f.paths.skillBackup, "SKILL.md")), original);
  await installManagedSkill({ ...f, installedVersion: "2" });
  await removeManagedSkill(f);
  assert.deepEqual(await readFile(join(f.paths.skill, "SKILL.md")), original);
  assert.deepEqual((await readdir(f.paths.skill)).sort(), ["SKILL.md", "user-file"]);
  assert.equal(await removeManagedSkill(f), false);
});

test("interrupted or incomplete copy never changes an existing Skill or creates a backup", async (t) => {
  for (const interrupt of [true, false]) {
    const f = await fixture(t);
    await mkdir(f.paths.skill, { recursive: true });
    await writeFile(join(f.paths.skill, "SKILL.md"), "original");
    await assert.rejects(installManagedSkill({ ...f, copyDirectory: async (_source, destination) => {
      await mkdir(destination, { recursive: true });
      await writeFile(join(destination, "SKILL.md"), "# Hypit\n");
      if (interrupt) throw new Error("submitted-secret");
    } }), /SKILL_INSTALL_FAILED/);
    assert.equal(await readFile(join(f.paths.skill, "SKILL.md"), "utf8"), "original");
    assert.deepEqual(await readdir(dirname(f.paths.skill)), ["hypit"]);
    await assert.rejects(readFile(join(f.paths.skillBackup, "SKILL.md")), { code: "ENOENT" });
  }
});

test("an existing backup is never overwritten and a forged backup location is never restored", async (t) => {
  const f = await fixture(t);
  await mkdir(f.paths.skill, { recursive: true });
  await writeFile(join(f.paths.skill, "SKILL.md"), "original");
  await mkdir(f.paths.skillBackup, { recursive: true });
  await writeFile(join(f.paths.skillBackup, "SKILL.md"), "previous backup");
  await assert.rejects(installManagedSkill(f), /SKILL_INSTALL_FAILED/);
  assert.equal(await readFile(join(f.paths.skillBackup, "SKILL.md"), "utf8"), "previous backup");
  await writeFile(join(f.paths.skill, SKILL_MARKER), JSON.stringify({ format: "hypit.desktop-managed@1", installedVersion: "1", sourceDigest: "a".repeat(64), backupDirectory: f.sourceDirectory }));
  await assert.rejects(removeManagedSkill(f), /SKILL_REMOVE_FAILED/);
  assert.equal(await readFile(join(f.paths.skill, "SKILL.md"), "utf8"), "original");
});

test("source symlinks are rejected; external symlink Skill is backed up and restored as a link", async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.paths.skill), { recursive: true });
  await symlink(f.sourceDirectory, f.paths.skill, "dir");
  await installManagedSkill(f);
  await removeManagedSkill(f);
  assert.equal(await readFile(join(f.paths.skill, "SKILL.md"), "utf8"), "# Hypit\n");
  await symlink(join(f.sourceDirectory, "SKILL.md"), join(f.sourceDirectory, "references", "link"));
  await assert.rejects(installManagedSkill(f), /SKILL_INSTALL_FAILED/);
});
