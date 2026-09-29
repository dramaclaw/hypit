import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import type { TestContext } from "node:test";
import { desktopPaths } from "../src/paths.js";
import { createWindowsUserPath, installLauncher, removeLauncher, renderLauncher } from "../src/launcher-install.js";

async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "hypit 中文 space-$-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home, appData: join(home, "Application Support") });
  const electronExecutable = join(home, 'Fake Electron "app"');
  const cliEntry = join(home, "resources", "hypit.mjs");
  await mkdir(dirname(cliEntry));
  await writeFile(cliEntry, "");
  await writeFile(electronExecutable, '#!/bin/sh\nprintf "%s\\n" "$ELECTRON_RUN_AS_NODE" "$@"\nexit 7\n', { mode: 0o755 });
  return { platform: "darwin" as const, home, paths, electronExecutable, cliEntry };
}

test("Windows command uses quoted Windows-relative paths and preserves forwarded arguments", () => {
  const paths = desktopPaths({ platform: "win32", home: "C:\\Users\\王 明", appData: "C:\\Users\\王 明\\AppData\\Local" });
  const content = renderLauncher({ platform: "win32", home: "C:\\Users\\王 明", paths,
    electronExecutable: "C:\\Users\\王 明\\AppData\\Local\\Programs\\Hypit Setup\\Hypit Setup.exe",
    cliEntry: "C:\\Users\\王 明\\AppData\\Local\\Programs\\Hypit Setup\\resources\\runtime\\node_modules\\@hypit\\hypit\\bin\\hypit.mjs" });
  assert.ok(content.includes('"%~dp0..\\..\\Programs\\Hypit Setup\\Hypit Setup.exe"'));
  assert.ok(content.includes('"%~dp0..\\..\\Programs\\Hypit Setup\\resources\\runtime\\node_modules\\@hypit\\hypit\\bin\\hypit.mjs" %*'));
});

test("Windows PATH adapter preserves raw registry values and encodes writes as data", async () => {
  const calls: { script: string; value?: string }[] = [];
  const adapter = createWindowsUserPath(async (script, value) => {
    calls.push({ script, ...(value === undefined ? {} : { value }) });
    return "C:\\中文;%USERPROFILE%\\bin";
  });
  assert.equal(await adapter.read(), "C:\\中文;%USERPROFILE%\\bin");
  await adapter.write("C:\\中文;%USERPROFILE%\\bin;$doNotExecute");
  assert.match(calls[0]!.script, /DoNotExpandEnvironmentNames/);
  assert.match(calls[0]!.script, /OutputEncoding/);
  assert.match(calls[1]!.script, /GetValueKind/);
  assert.match(calls[1]!.script, /CurrentUser/);
  assert.equal(calls[1]!.script.includes("$doNotExecute"), false);
  assert.equal(Buffer.from(calls[1]!.value!, "base64").toString("utf8"), "C:\\中文;%USERPROFILE%\\bin;$doNotExecute");
});

test("macOS launcher quotes absolute paths, preserves arguments and exit status", async (t) => {
  const f = await fixture(t);
  await installLauncher(f);
  const launcher = await readFile(f.paths.launcher, "utf8");
  assert.match(launcher, /export ELECTRON_RUN_AS_NODE=1/);
  assert.match(launcher, /"\$@"/);
  await assert.rejects(promisify(execFile)(f.paths.launcher, ["hello 中文", "$(touch forbidden)"]), (error: any) => {
    assert.equal(error.code, 7);
    assert.equal(error.stdout, `1\n${f.cliEntry}\nhello 中文\n$(touch forbidden)\n`);
    return true;
  });
  assert.equal((await stat(dirname(f.paths.launcher))).mode & 0o777, 0o700);
  assert.equal((await stat(f.paths.launcher)).mode & 0o777, 0o755);
});

test("uninstall rejects an unrelated PATH block in edited ownership state", async (t) => {
  const f = await fixture(t);
  const profile = join(f.home, ".zprofile");
  await writeFile(profile, "# keep user content\n");
  await installLauncher(f);
  const state = JSON.parse(await readFile(f.paths.managedState, "utf8"));
  await writeFile(f.paths.managedState, JSON.stringify({ ...state, zprofileBlock: "# keep user content\n" }));
  const before = await readFile(profile);
  await assert.rejects(removeLauncher(f), /LAUNCHER_REMOVE_FAILED/);
  assert.deepEqual(await readFile(profile), before);
});

test("macOS PATH block is idempotent and uninstall preserves unrelated shell bytes", async (t) => {
  const f = await fixture(t);
  const profile = join(f.home, ".zprofile");
  const original = "# 用户配置\nexport SOMETHING='keep'";
  await writeFile(profile, original);
  const result = await installLauncher(f);
  assert.match(result.restartMessage, /Codex.*Terminal/);
  const installed = await readFile(profile, "utf8");
  await installLauncher(f);
  assert.equal(await readFile(profile, "utf8"), installed);
  await writeFile(profile, installed + "\n# user addition\n");
  await removeLauncher(f);
  assert.equal(await readFile(profile, "utf8"), original + "\n# user addition\n");
  assert.equal(await removeLauncher(f), false);
});

test("unmanaged launchers are preserved and modified managed launchers are not removed", async (t) => {
  const f = await fixture(t);
  await mkdir(dirname(f.paths.launcher), { recursive: true });
  await writeFile(f.paths.launcher, "external");
  await assert.rejects(installLauncher(f), /LAUNCHER_INSTALL_FAILED/);
  assert.equal(await removeLauncher(f), false);
  assert.equal(await readFile(f.paths.launcher, "utf8"), "external");
});

for (const present of [true, false]) {
  test(`Windows launcher statically quotes dp0 paths and owns only an added user PATH segment (${present})`, async (t) => {
    const f = await fixture(t);
    const paths = { ...f.paths, launcher: join(f.home, "bin 中文", "hypit.cmd") };
    const electronExecutable = join(f.home, "Hypit Setup.exe");
    await writeFile(electronExecutable, "fake");
    const entry = dirname(paths.launcher);
    const original = present ? `C:\\Other;${entry};%USERPROFILE%\\tools` : "C:\\Other;%USERPROFILE%\\tools";
    let value = original;
    const options = { ...f, paths, electronExecutable, platform: "win32" as const, userPath: {
      async read() { return value; }, async write(next: string) { value = next; },
    } };
    await installLauncher(options);
    const command = await readFile(paths.launcher, "utf8");
    assert.match(command, /setlocal DisableDelayedExpansion/);
    assert.match(command, /"%~dp0[^\r\n]+"/);
    assert.match(command, / %\*/);
    assert.match(command, /exit \/b %errorlevel%/i);
    await installLauncher(options);
    assert.equal(value, present ? original : `${original};${entry}`);
    value += ";C:\\Later";
    await removeLauncher(options);
    assert.equal(value, original + ";C:\\Later");
  });
}

test("edited managed launcher is retained on uninstall", async (t) => {
  const f = await fixture(t);
  await installLauncher(f);
  await writeFile(f.paths.launcher, "user replacement");
  await assert.rejects(removeLauncher(f), /LAUNCHER_REMOVE_FAILED/);
  assert.equal(await readFile(f.paths.launcher, "utf8"), "user replacement");
});

test("failed user PATH write rolls back even when the write mutated before rejecting", async (t) => {
  const f = await fixture(t);
  const electronExecutable = join(f.home, "Hypit Setup.exe");
  await writeFile(electronExecutable, "fake");
  let value = "C:\\Original";
  let writes = 0;
  await assert.rejects(installLauncher({ ...f, electronExecutable, platform: "win32", userPath: {
    async read() { return value; },
    async write(next) { value = next; if (++writes === 1) throw new Error("secret"); },
  } }), /LAUNCHER_INSTALL_FAILED/);
  assert.equal(value, "C:\\Original");
  await assert.rejects(readFile(f.paths.launcher), { code: "ENOENT" });
  await assert.rejects(readFile(f.paths.managedState), { code: "ENOENT" });
});
