import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { desktopPaths } from "../src/paths.js";
import { installDesktopIntegration, removeDesktopIntegration } from "../src/lifecycle.js";

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
