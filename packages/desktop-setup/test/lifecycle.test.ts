import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs, { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { promisify } from "node:util";
import { desktopPaths } from "../src/paths.js";
import { installDesktopIntegration, removeDesktopIntegration } from "../src/lifecycle.js";
import { installManagedSkill, SKILL_MARKER } from "../src/skill-install.js";
import type { AgentSkillTarget } from "../src/agent-targets.js";

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "hypit lifecycle-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home, appData: join(home, "appdata") });
  const sourceDirectory = join(home, "source");
  await mkdir(join(sourceDirectory, "references"), { recursive: true });
  await writeFile(join(sourceDirectory, "SKILL.md"), "# Skill");
  await writeFile(join(sourceDirectory, "references", "guide.md"), "guide");
  const electronExecutable = join(home, "electron");
  const cliEntry = join(home, "cli.mjs");
  await writeFile(electronExecutable, "fake");
  await writeFile(cliEntry, "fake");
  const portable: AgentSkillTarget = { id: "portable", label: "通用 Agent Skill", skillDirectory: paths.portableSkill,
    backupDirectory: paths.portableSkillBackup, required: true, detectedAgents: [] };
  const claude: AgentSkillTarget = { id: "claude", label: "Claude Code Skill", skillDirectory: paths.claudeSkill,
    backupDirectory: paths.claudeSkillBackup, required: false, detectedAgents: [] };
  return { paths, portable, claude, targets: [portable], home, platform: "darwin" as const, sourceDirectory, installedVersion: "1", electronExecutable, cliEntry };
}

async function seedLegacyManagedSkill(f: Awaited<ReturnType<typeof fixture>>, backup?: string) {
  const marker = await installManagedSkill({ ...f, target: f.portable });
  await mkdir(dirname(f.paths.legacyCodexSkill), { recursive: true });
  await cp(f.portable.skillDirectory, f.paths.legacyCodexSkill, { recursive: true });
  await rm(f.portable.skillDirectory, { recursive: true });
  if (backup !== undefined) {
    await mkdir(f.paths.legacyCodexSkillBackup, { recursive: true });
    await writeFile(join(f.paths.legacyCodexSkillBackup, "SKILL.md"), backup);
  }
  await writeFile(join(f.paths.legacyCodexSkill, SKILL_MARKER), JSON.stringify({
    format: "hypit.desktop-managed@1", installedVersion: marker.installedVersion, sourceDigest: marker.sourceDigest,
    ...(backup === undefined ? {} : { backupDirectory: f.paths.legacyCodexSkillBackup }),
  }));
}

for (const backup of [undefined, "user Codex Skill"]) {
  test(`v1 Codex install migrates only after every target commits (${backup})`, async (t) => {
    const f = await fixture(t);
    await seedLegacyManagedSkill(f, backup);
    const rename = fs.rename;
    let migrated = false;
    const mock = t.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
      if (source === f.paths.legacyCodexSkill) {
        migrated = true;
        for (const target of [f.portable, f.claude]) assert.equal(await readFile(join(target.skillDirectory, "SKILL.md"), "utf8"), "# Skill");
      }
      return rename(source, destination);
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    await installDesktopIntegration({ ...f, targets: [f.portable, f.claude] });
    assert.equal(migrated, true);
    if (backup === undefined) await assert.rejects(readFile(join(f.paths.legacyCodexSkill, "SKILL.md")), { code: "ENOENT" });
    else assert.equal(await readFile(join(f.paths.legacyCodexSkill, "SKILL.md"), "utf8"), backup);
    await assert.rejects(readFile(join(f.paths.legacyCodexSkillBackup, "SKILL.md")), { code: "ENOENT" });
  });
}

test("unmanaged legacy Codex tree and backup stay untouched", async (t) => {
  const f = await fixture(t);
  for (const path of [f.paths.legacyCodexSkill, f.paths.legacyCodexSkillBackup]) {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, "SKILL.md"), path);
  }
  await installDesktopIntegration(f);
  await removeDesktopIntegration(f);
  for (const path of [f.paths.legacyCodexSkill, f.paths.legacyCodexSkillBackup]) assert.equal(await readFile(join(path, "SKILL.md"), "utf8"), path);
});

for (const marker of [undefined, { format: "hypit.desktop-managed@1", installedVersion: "1", sourceDigest: "0".repeat(64), backupDirectory: "/not-the-legacy-backup" }]) {
  test(`unmanaged legacy FIFO is never traversed during install or uninstall (${marker ? "unproven marker" : "no marker"})`, { skip: process.platform === "win32" }, async (t) => {
    const f = await fixture(t);
    await mkdir(f.paths.legacyCodexSkill, { recursive: true });
    const fifo = join(f.paths.legacyCodexSkill, "user-pipe");
    await promisify(execFile)("mkfifo", [fifo]);
    await writeFile(join(f.paths.legacyCodexSkill, "SKILL.md"), "user legacy Skill");
    if (marker) await writeFile(join(f.paths.legacyCodexSkill, SKILL_MARKER), JSON.stringify(marker));
    const before = await stat(fifo);
    const originalReaddir = fs.readdir;
    let traversals = 0;
    const mock = t.mock.method(fs, "readdir", (...args: Parameters<typeof fs.readdir>) => {
      if (String(args[0]) === f.paths.legacyCodexSkill) traversals++;
      return originalReaddir(...args);
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    await installDesktopIntegration(f);
    assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "# Skill");
    await removeDesktopIntegration(f);
    await assert.rejects(readFile(join(f.portable.skillDirectory, "SKILL.md")), { code: "ENOENT" });
    assert.equal(traversals, 0);
    const after = await stat(fifo);
    assert.equal(after.isFIFO(), true);
    assert.equal(after.ino, before.ino);
    assert.equal(await readFile(join(f.paths.legacyCodexSkill, "SKILL.md"), "utf8"), "user legacy Skill");
    if (marker) assert.deepEqual(JSON.parse(await readFile(join(f.paths.legacyCodexSkill, SKILL_MARKER), "utf8")), marker);
  });
}

for (const change of ["format", "version", "digest", "backup", "content"] as const) {
  test(`legacy migration leaves an unproven ${change} marker and backup untouched`, async (t) => {
    const f = await fixture(t);
    await seedLegacyManagedSkill(f, "legacy user backup");
    const markerPath = join(f.paths.legacyCodexSkill, SKILL_MARKER);
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (change === "format") marker.format = "hypit.desktop-managed@2";
    if (change === "version") marker.installedVersion = " ";
    if (change === "digest") marker.sourceDigest = "0".repeat(64);
    if (change === "backup") marker.backupDirectory = f.paths.portableSkillBackup;
    if (change === "content") await writeFile(join(f.paths.legacyCodexSkill, "SKILL.md"), "user edit");
    await writeFile(markerPath, JSON.stringify(marker));
    const files = [markerPath, join(f.paths.legacyCodexSkill, "SKILL.md"), join(f.paths.legacyCodexSkillBackup, "SKILL.md")];
    const before = await Promise.all(files.map(path => readFile(path)));
    await installDesktopIntegration(f);
    await removeDesktopIntegration(f);
    assert.deepEqual(await Promise.all(files.map(path => readFile(path))), before);
  });
}

test("target preparation failure precedes any launcher write or legacy migration", async (t) => {
  const f = await fixture(t);
  await seedLegacyManagedSkill(f);
  const copied: string[] = [];
  await assert.rejects(installDesktopIntegration({ ...f, targets: [f.portable, f.claude], copyDirectory: async (source, destination) => {
    copied.push(dirname(destination));
    if (dirname(destination) === dirname(f.portable.skillDirectory)) throw new Error("copy failed");
    await cp(source, destination, { recursive: true });
  } }), /INTEGRATION_INSTALL_FAILED\]$/u);
  assert.deepEqual(copied, [dirname(f.claude.skillDirectory), dirname(f.portable.skillDirectory)]);
  for (const file of [f.paths.launcher, f.paths.managedState, join(f.home, ".zprofile"), join(f.claude.skillDirectory, SKILL_MARKER)]) await assert.rejects(readFile(file), { code: "ENOENT" });
  assert.equal(JSON.parse(await readFile(join(f.paths.legacyCodexSkill, SKILL_MARKER), "utf8")).format, "hypit.desktop-managed@1");
  assert.deepEqual(await readdir(dirname(f.claude.skillDirectory)), []);
});

test("ownership doubt on rollback preserves a committed target, its previous tree and backup", async (t) => {
  const f = await fixture(t);
  await mkdir(f.claude.skillDirectory, { recursive: true });
  await writeFile(join(f.claude.skillDirectory, "SKILL.md"), "original user Claude");
  const rename = fs.rename;
  const mock = t.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (destination === f.portable.skillDirectory) {
      await writeFile(join(f.claude.skillDirectory, "SKILL.md"), "concurrent user edit");
      throw new Error("submitted-secret");
    }
    return rename(source, destination);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(installDesktopIntegration({ ...f, targets: [f.portable, f.claude] }), /INTEGRATION_INSTALL_FAILED_ROLLBACK_FAILED\]$/u);
  assert.equal(await readFile(join(f.claude.skillDirectory, "SKILL.md"), "utf8"), "concurrent user edit");
  assert.equal(await readFile(join(f.claude.backupDirectory, "SKILL.md"), "utf8"), "original user Claude");
  const previous = (await readdir(dirname(f.claude.skillDirectory))).find(name => name.startsWith("hypit.previous-"));
  assert.ok(previous);
  assert.equal(await readFile(join(dirname(f.claude.skillDirectory), previous, "SKILL.md"), "utf8"), "original user Claude");
  await assert.rejects(readFile(f.paths.launcher), { code: "ENOENT" });
});

test("uninstall rolls earlier target removals back when a later target restoration fails", async (t) => {
  const f = await fixture(t);
  for (const target of [f.portable, f.claude]) {
    await mkdir(target.skillDirectory, { recursive: true });
    await writeFile(join(target.skillDirectory, "SKILL.md"), `original ${target.id}`);
  }
  await installDesktopIntegration({ ...f, targets: [f.portable, f.claude] });
  const files = [f.paths.launcher, f.paths.managedState, ...[f.portable, f.claude].flatMap(target =>
    [join(target.skillDirectory, SKILL_MARKER), join(target.backupDirectory, "SKILL.md")])];
  const before = await Promise.all(files.map(path => readFile(path)));
  const rename = fs.rename;
  let injected = false;
  const mock = t.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
    if (!injected && destination === f.portable.skillDirectory) {
      injected = true;
      assert.equal(await readFile(join(f.claude.skillDirectory, "SKILL.md"), "utf8"), "original claude");
      throw new Error("restore failed");
    }
    return rename(source, destination);
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(removeDesktopIntegration(f), /INTEGRATION_REMOVE_FAILED\]$/u);
  assert.equal(injected, true);
  assert.deepEqual(await Promise.all(files.map(path => readFile(path))), before);
});

test("a portable-only rescan retains managed Claude and uninstall restores every independent backup", async (t) => {
  const f = await fixture(t);
  for (const target of [f.portable, f.claude]) {
    await mkdir(target.skillDirectory, { recursive: true });
    await writeFile(join(target.skillDirectory, "SKILL.md"), `user ${target.id}`);
  }
  await installDesktopIntegration({ ...f, targets: [f.portable, f.claude] });
  const claudeMarker = await readFile(join(f.claude.skillDirectory, SKILL_MARKER));
  await installDesktopIntegration({ ...f, targets: [f.portable], installedVersion: "2" });
  assert.deepEqual(await readFile(join(f.claude.skillDirectory, SKILL_MARKER)), claudeMarker);
  await removeDesktopIntegration(f);
  for (const target of [f.portable, f.claude]) {
    assert.equal(await readFile(join(target.skillDirectory, "SKILL.md"), "utf8"), `user ${target.id}`);
    await assert.rejects(readFile(join(target.backupDirectory, "SKILL.md")), { code: "ENOENT" });
  }
});

for (const failure of ["portable", "legacy", "legacy-restore"] as const) {
  test(`later ${failure} commit failure restores targets, legacy and launcher`, async (t) => {
    const f = await fixture(t);
    await seedLegacyManagedSkill(f, "user Codex Skill");
    await installDesktopIntegration({ ...f, targets: [f.portable, f.claude] });
    await seedLegacyManagedSkill(f, "user Codex Skill");
    const tracked = [f.paths.launcher, f.paths.managedState, join(f.home, ".zprofile"),
      join(f.claude.skillDirectory, SKILL_MARKER), join(f.paths.legacyCodexSkill, SKILL_MARKER)];
    const before = await Promise.all(tracked.map(path => readFile(path)));
    const rename = fs.rename;
    const rollbackOrder: string[] = [];
    let injected = false;
    const mock = t.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
      if (!injected && (failure === "portable" ? destination === f.portable.skillDirectory
        : failure === "legacy" ? source === f.paths.legacyCodexSkill : destination === f.paths.legacyCodexSkill)) {
        injected = true;
        throw new Error("submitted-secret");
      }
      if (injected && String(destination).includes(".stage-") && [f.portable.skillDirectory, f.claude.skillDirectory].includes(String(source))) rollbackOrder.push(String(source));
      return rename(source, destination);
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    await assert.rejects(installDesktopIntegration({ ...f, installedVersion: "2", targets: [f.portable, f.claude] }), /INTEGRATION_INSTALL_FAILED\]$/u);
    assert.equal(injected, true);
    assert.deepEqual(rollbackOrder, failure === "portable" ? [f.claude.skillDirectory] : [f.portable.skillDirectory, f.claude.skillDirectory]);
    assert.deepEqual(await Promise.all(tracked.map(path => readFile(path))), before);
    await assert.rejects(readFile(join(f.portable.skillDirectory, "SKILL.md")), { code: "ENOENT" });
    assert.equal(await readFile(join(f.paths.legacyCodexSkillBackup, "SKILL.md"), "utf8"), "user Codex Skill");
  });
}

test("integration installs, upgrades and removes owned files while retaining profile and unrelated host data", async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.paths.profile), { recursive: true });
  await writeFile(f.paths.profile, "profile without secrets");
  await installDesktopIntegration(f);
  await installDesktopIntegration({ ...f, installedVersion: "2" });
  await removeDesktopIntegration(f);
  assert.equal(await readFile(f.paths.profile, "utf8"), "profile without secrets");
  await assert.rejects(readFile(join(f.paths.portableSkill, "SKILL.md")), { code: "ENOENT" });
  await assert.rejects(readFile(f.paths.launcher), { code: "ENOENT" });
});

for (const resource of ["profile-before", "profile-after", "launcher-after", "windows-before", "windows-after"] as const) {
  test(`failed target commit preserves concurrent ${resource} edits`, async (t) => {
    const f = await fixture(t);
    const profile = join(f.home, ".zprofile");
    let userPath = "original PATH";
    const options = { ...f, platform: resource.startsWith("windows") ? "win32" as const : "darwin" as const,
      userPath: { read: async () => userPath, write: async (value: string) => { userPath = value; } } };
    await writeFile(profile, "original profile\n");
    const rename = fs.rename;
    const mock = t.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
      if (destination === f.portable.skillDirectory) {
        if (resource === "profile-after") await writeFile(profile, "concurrent profile\n");
        if (resource === "launcher-after") await writeFile(f.paths.launcher, "concurrent launcher\n");
        if (resource === "windows-after") userPath = "concurrent PATH";
        throw new Error("private failure");
      }
      return rename(source, destination);
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    await assert.rejects(installDesktopIntegration({ ...options, copyDirectory: async (source, destination) => {
      await cp(source, destination, { recursive: true });
      if (resource === "profile-before") await writeFile(profile, "concurrent profile\n");
      if (resource === "windows-before") userPath = "concurrent PATH";
    } }), resource.endsWith("after") ? /INTEGRATION_INSTALL_FAILED_ROLLBACK_FAILED\]$/u : /INTEGRATION_INSTALL_FAILED\]$/u);
    if (resource.startsWith("profile")) assert.equal(await readFile(profile, "utf8"), "concurrent profile\n");
    if (resource === "launcher-after") assert.equal(await readFile(f.paths.launcher, "utf8"), "concurrent launcher\n");
    if (resource.startsWith("windows")) assert.equal(userPath, "concurrent PATH");
  });
}

test("failed integration restores the previous Skill and launcher with no partial installation", async (t) => {
  const f = await fixture(t);
  await mkdir(f.paths.portableSkill, { recursive: true });
  await writeFile(join(f.paths.portableSkill, "SKILL.md"), "external original");
  await mkdir(dirname(f.paths.launcher), { recursive: true });
  await writeFile(f.paths.launcher, "external launcher");
  await assert.rejects(installDesktopIntegration(f), /INTEGRATION_INSTALL_FAILED/);
  assert.equal(await readFile(join(f.paths.portableSkill, "SKILL.md"), "utf8"), "external original");
  assert.equal(await readFile(f.paths.launcher, "utf8"), "external launcher");
  await assert.rejects(readFile(join(f.paths.portableSkillBackup, "SKILL.md")), { code: "ENOENT" });
});

test("Skill copy failure after launcher upgrade restores all prior integration bytes", async (t) => {
  const f = await fixture(t);
  await installDesktopIntegration(f);
  const files = [f.paths.launcher, f.paths.managedState, join(f.home, ".zprofile"), join(f.paths.portableSkill, "SKILL.md")];
  const before = await Promise.all(files.map((path) => readFile(path)));
  const electronExecutable = join(f.home, "new electron");
  await writeFile(electronExecutable, "new fake");
  await assert.rejects(installDesktopIntegration({ ...f, electronExecutable, installedVersion: "2", copyDirectory: async () => {
    throw new Error("submitted-secret");
  } }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.match(error.message, /INTEGRATION_INSTALL_FAILED/);
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes("submitted-secret"), false);
    return true;
  });
  assert.deepEqual(await Promise.all(files.map((path) => readFile(path))), before);
});

test("integration reports an incomplete PATH rollback without echoing the OS error", async (t) => {
  const f = await fixture(t);
  await assert.rejects(installDesktopIntegration({ ...f, platform: "win32", userPath: {
    async read() { return "C:\\User Tools"; },
    async write() { throw new Error("submitted-secret"); },
  } }), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "桌面集成安装失败 [INTEGRATION_INSTALL_FAILED_ROLLBACK_FAILED]");
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes("submitted-secret"), false);
    return true;
  });
});

test("uninstall preflight preserves the managed Skill and backup when the launcher was edited", async (t) => {
  const f = await fixture(t);
  await mkdir(f.paths.portableSkill, { recursive: true });
  await writeFile(join(f.paths.portableSkill, "SKILL.md"), "external original");
  await installDesktopIntegration(f);
  await writeFile(f.paths.launcher, "user replacement");
  const files = [f.paths.launcher, f.paths.managedState, join(f.home, ".zprofile"),
    join(f.paths.portableSkill, "SKILL.md"), join(f.paths.portableSkill, SKILL_MARKER), join(f.paths.portableSkillBackup, "SKILL.md")];
  const before = await Promise.all(files.map((path) => readFile(path)));
  const identities = await Promise.all(files.map(async (path) => (await stat(path)).ino));
  await assert.rejects(removeDesktopIntegration(f), /INTEGRATION_REMOVE_FAILED\]$/);
  assert.deepEqual(await Promise.all(files.map((path) => readFile(path))), before);
  assert.deepEqual(await Promise.all(files.map(async (path) => (await stat(path)).ino)), identities);
});

for (const external of [false, true]) {
  test(`uninstall rolls back a mutated PATH write without losing the Skill or backup (${external})`, async (t) => {
    const f = await fixture(t);
    if (external) {
      await mkdir(f.paths.portableSkill, { recursive: true });
      await writeFile(join(f.paths.portableSkill, "SKILL.md"), "external original");
    }
    let value = "C:\\Original";
    let fail = false;
    const options = { ...f, platform: "win32" as const, userPath: {
      async read() { return value; },
      async write(next: string) { value = next; if (fail) { fail = false; throw new Error("submitted-secret"); } },
    } };
    await installDesktopIntegration(options);
    const files = [f.paths.launcher, f.paths.managedState, join(f.paths.portableSkill, "SKILL.md"), join(f.paths.portableSkill, SKILL_MARKER),
      ...(external ? [join(f.paths.portableSkillBackup, "SKILL.md")] : [])];
    const before = await Promise.all(files.map((path) => readFile(path)));
    const oldPath = value;
    fail = true;
    await assert.rejects(removeDesktopIntegration(options), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "桌面集成卸载失败 [INTEGRATION_REMOVE_FAILED]");
      assert.equal(`${error.stack}${JSON.stringify(error)}`.includes("submitted-secret"), false);
      return true;
    });
    assert.equal(value, oldPath);
    assert.deepEqual(await Promise.all(files.map((path) => readFile(path))), before);
    await removeDesktopIntegration(options);
    if (external) assert.equal(await readFile(join(f.paths.portableSkill, "SKILL.md"), "utf8"), "external original");
    else await assert.rejects(readFile(join(f.paths.portableSkill, "SKILL.md")), { code: "ENOENT" });
  });
}

for (const failure of ["profile", "skill"] as const) {
  test(`uninstall restores every component after a ${failure} commit failure`, async (t) => {
    const f = await fixture(t);
    await mkdir(f.paths.portableSkill, { recursive: true });
    await writeFile(join(f.paths.portableSkill, "SKILL.md"), "external original");
    await installDesktopIntegration(f);
    const profile = join(f.home, ".zprofile");
    const files = [f.paths.launcher, f.paths.managedState, profile, join(f.paths.portableSkill, "SKILL.md"),
      join(f.paths.portableSkill, SKILL_MARKER), join(f.paths.portableSkillBackup, "SKILL.md")];
    const before = await Promise.all(files.map((path) => readFile(path)));
    const originalRename = fs.rename;
    let injected = false;
    const renameMock = t.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
      const target = failure === "profile" ? profile : f.paths.portableSkill;
      if (!injected && destination === target) {
        injected = true;
        if (failure === "skill") await assert.rejects(readFile(f.paths.launcher), { code: "ENOENT" });
        throw new Error("submitted-secret");
      }
      return originalRename(source, destination);
    });
    syncBuiltinESMExports();
    t.after(() => { renameMock.mock.restore(); syncBuiltinESMExports(); });
    await assert.rejects(removeDesktopIntegration(f), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message, "桌面集成卸载失败 [INTEGRATION_REMOVE_FAILED]");
      assert.equal(`${error.stack}${JSON.stringify(error)}`.includes("submitted-secret"), false);
      return true;
    });
    assert.equal(injected, true);
    assert.deepEqual(await Promise.all(files.map((path) => readFile(path))), before);
    assert.deepEqual(await readdir(dirname(f.paths.portableSkill)), ["hypit"]);
    await removeDesktopIntegration(f);
    assert.equal(await readFile(join(f.paths.portableSkill, "SKILL.md"), "utf8"), "external original");
  });
}

test("uninstall preflights the Skill backup before changing PATH or launcher files", async (t) => {
  const f = await fixture(t);
  let value = "C:\\Original";
  let writes = 0;
  const options = { ...f, platform: "win32" as const, userPath: {
    async read() { return value; }, async write(next: string) { ++writes; value = next; },
  } };
  await installDesktopIntegration(options);
  const markerPath = join(f.paths.portableSkill, SKILL_MARKER);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  await writeFile(markerPath, JSON.stringify({ ...marker, backupDirectory: f.paths.portableSkillBackup }));
  const files = [f.paths.launcher, f.paths.managedState, markerPath, join(f.paths.portableSkill, "SKILL.md")];
  const before = await Promise.all(files.map((path) => readFile(path)));
  const oldPath = value;
  const oldWrites = writes;
  await assert.rejects(removeDesktopIntegration(options), /SKILL_BACKUP_UNAVAILABLE\]$/);
  assert.deepEqual(await Promise.all(files.map((path) => readFile(path))), before);
  assert.equal(value, oldPath);
  assert.equal(writes, oldWrites);
});

test("uninstall reports a failed PATH rollback without exposing the OS error or deleting the Skill", async (t) => {
  const f = await fixture(t);
  let value = "C:\\Original";
  let fail = false;
  const options = { ...f, platform: "win32" as const, userPath: {
    async read() { return value; },
    async write(next: string) { if (fail) throw new Error("submitted-secret"); value = next; },
  } };
  await installDesktopIntegration(options);
  const files = [f.paths.launcher, f.paths.managedState, join(f.paths.portableSkill, "SKILL.md"), join(f.paths.portableSkill, SKILL_MARKER)];
  const before = await Promise.all(files.map((path) => readFile(path)));
  fail = true;
  await assert.rejects(removeDesktopIntegration(options), (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, "桌面集成卸载失败 [INTEGRATION_REMOVE_FAILED_ROLLBACK_FAILED]");
    assert.equal(`${error.stack}${JSON.stringify(error)}`.includes("submitted-secret"), false);
    return true;
  });
  assert.deepEqual(await Promise.all(files.map((path) => readFile(path))), before);
});
