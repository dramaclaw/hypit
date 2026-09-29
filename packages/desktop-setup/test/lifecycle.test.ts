import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { desktopPaths } from "../src/paths.js";
import { installDesktopIntegration, removeDesktopIntegration } from "../src/lifecycle.js";
import { SKILL_MARKER } from "../src/skill-install.js";

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
  return { paths, home, platform: "darwin" as const, sourceDirectory, installedVersion: "1", electronExecutable, cliEntry };
}

test("integration installs, upgrades and removes owned files while retaining profile and unrelated host data", async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.paths.profile), { recursive: true });
  await writeFile(f.paths.profile, "profile without secrets");
  await installDesktopIntegration(f);
  await installDesktopIntegration({ ...f, installedVersion: "2" });
  await removeDesktopIntegration(f);
  assert.equal(await readFile(f.paths.profile, "utf8"), "profile without secrets");
  await assert.rejects(readFile(join(f.paths.skill, "SKILL.md")), { code: "ENOENT" });
  await assert.rejects(readFile(f.paths.launcher), { code: "ENOENT" });
});

test("failed integration restores the previous Skill and launcher with no partial installation", async (t) => {
  const f = await fixture(t);
  await mkdir(f.paths.skill, { recursive: true });
  await writeFile(join(f.paths.skill, "SKILL.md"), "external original");
  await mkdir(dirname(f.paths.launcher), { recursive: true });
  await writeFile(f.paths.launcher, "external launcher");
  await assert.rejects(installDesktopIntegration(f), /INTEGRATION_INSTALL_FAILED/);
  assert.equal(await readFile(join(f.paths.skill, "SKILL.md"), "utf8"), "external original");
  assert.equal(await readFile(f.paths.launcher, "utf8"), "external launcher");
  await assert.rejects(readFile(join(f.paths.skillBackup, "SKILL.md")), { code: "ENOENT" });
});

test("Skill copy failure after launcher upgrade restores all prior integration bytes", async (t) => {
  const f = await fixture(t);
  await installDesktopIntegration(f);
  const files = [f.paths.launcher, f.paths.managedState, join(f.home, ".zprofile"), join(f.paths.skill, "SKILL.md")];
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
  await mkdir(f.paths.skill, { recursive: true });
  await writeFile(join(f.paths.skill, "SKILL.md"), "external original");
  await installDesktopIntegration(f);
  await writeFile(f.paths.launcher, "user replacement");
  const files = [f.paths.launcher, f.paths.managedState, join(f.home, ".zprofile"),
    join(f.paths.skill, "SKILL.md"), join(f.paths.skill, SKILL_MARKER), join(f.paths.skillBackup, "SKILL.md")];
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
      await mkdir(f.paths.skill, { recursive: true });
      await writeFile(join(f.paths.skill, "SKILL.md"), "external original");
    }
    let value = "C:\\Original";
    let fail = false;
    const options = { ...f, platform: "win32" as const, userPath: {
      async read() { return value; },
      async write(next: string) { value = next; if (fail) { fail = false; throw new Error("submitted-secret"); } },
    } };
    await installDesktopIntegration(options);
    const files = [f.paths.launcher, f.paths.managedState, join(f.paths.skill, "SKILL.md"), join(f.paths.skill, SKILL_MARKER),
      ...(external ? [join(f.paths.skillBackup, "SKILL.md")] : [])];
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
    if (external) assert.equal(await readFile(join(f.paths.skill, "SKILL.md"), "utf8"), "external original");
    else await assert.rejects(readFile(join(f.paths.skill, "SKILL.md")), { code: "ENOENT" });
  });
}

for (const failure of ["profile", "skill"] as const) {
  test(`uninstall restores every component after a ${failure} commit failure`, async (t) => {
    const f = await fixture(t);
    await mkdir(f.paths.skill, { recursive: true });
    await writeFile(join(f.paths.skill, "SKILL.md"), "external original");
    await installDesktopIntegration(f);
    const profile = join(f.home, ".zprofile");
    const files = [f.paths.launcher, f.paths.managedState, profile, join(f.paths.skill, "SKILL.md"),
      join(f.paths.skill, SKILL_MARKER), join(f.paths.skillBackup, "SKILL.md")];
    const before = await Promise.all(files.map((path) => readFile(path)));
    const originalRename = fs.rename;
    let injected = false;
    const renameMock = t.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
      const target = failure === "profile" ? profile : f.paths.skill;
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
    assert.deepEqual(await readdir(dirname(f.paths.skill)), ["hypit"]);
    await removeDesktopIntegration(f);
    assert.equal(await readFile(join(f.paths.skill, "SKILL.md"), "utf8"), "external original");
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
  const markerPath = join(f.paths.skill, SKILL_MARKER);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  await writeFile(markerPath, JSON.stringify({ ...marker, backupDirectory: f.paths.skillBackup }));
  const files = [f.paths.launcher, f.paths.managedState, markerPath, join(f.paths.skill, "SKILL.md")];
  const before = await Promise.all(files.map((path) => readFile(path)));
  const oldPath = value;
  const oldWrites = writes;
  await assert.rejects(removeDesktopIntegration(options), /INTEGRATION_REMOVE_FAILED\]$/);
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
  const files = [f.paths.launcher, f.paths.managedState, join(f.paths.skill, "SKILL.md"), join(f.paths.skill, SKILL_MARKER)];
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
