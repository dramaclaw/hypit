import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { runIntegrationCleanup } from "../src/cleanup-entry.js";
import { desktopPaths } from "../src/paths.js";
import { scanAgentTargets } from "../src/agent-targets.js";
import { installManagedSkill, SKILL_MARKER } from "../src/skill-install.js";
import { removeDesktopIntegration } from "../src/lifecycle.js";

const require = createRequire(new URL("../package.json", import.meta.url));

test("explicit uninstall enumerates every managed target and legacy tree without Agent detection", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hypit-uninstall-all-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home, appData: join(home, "appdata") });
  const { targets } = await scanAgentTargets({ paths, exists: async () => true });
  const sourceDirectory = join(home, "source");
  await mkdir(join(sourceDirectory, "references"), { recursive: true });
  await writeFile(join(sourceDirectory, "SKILL.md"), "# Hypit");
  for (const target of targets) {
    await mkdir(target.skillDirectory, { recursive: true });
    await writeFile(join(target.skillDirectory, "SKILL.md"), `user ${target.id}`);
    await installManagedSkill({ target, sourceDirectory, installedVersion: "1" });
  }
  await mkdir(dirname(paths.legacyCodexSkill), { recursive: true });
  await cp(paths.portableSkill, paths.legacyCodexSkill, { recursive: true });
  const markerPath = join(paths.legacyCodexSkill, SKILL_MARKER);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  await writeFile(markerPath, JSON.stringify({ format: "hypit.desktop-managed@1", installedVersion: "1", sourceDigest: marker.sourceDigest }));
  const noAgents = { ...paths, agentProbePaths: { codex: [], "claymore-piko": [], cursor: [], "claude-code": [] } };
  assert.deepEqual((await scanAgentTargets({ paths: noAgents })).targets.map(target => target.id), ["portable"]);
  await removeDesktopIntegration({ paths: noAgents, home, platform: "darwin" });
  for (const target of targets) {
    assert.equal(await readFile(join(target.skillDirectory, "SKILL.md"), "utf8"), `user ${target.id}`);
    await assert.rejects(readFile(join(target.backupDirectory, "SKILL.md")), { code: "ENOENT" });
  }
  await assert.rejects(readFile(join(paths.legacyCodexSkill, "SKILL.md")), { code: "ENOENT" });
});

function cleanupCallsInHook(hook: string, updated: boolean): number {
  const body = hook.match(/!macro customUnInstall\s*([\s\S]*?)!macroend/)?.[1];
  assert.ok(body, "customUnInstall macro must exist");
  const active = [true];
  let calls = 0;
  for (const rawLine of body.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === "${IfNot} ${isUpdated}") active.push(active.at(-1)! && !updated);
    else if (line === "${If} $0 != 0") active.push(false);
    else if (line === "${EndIf}") {
      assert.ok(active.length > 1, "unexpected NSIS EndIf");
      active.pop();
    } else if (line.includes("nsExec::ExecToStack") && active.at(-1)) calls++;
  }
  assert.equal(active.length, 1, "NSIS conditional blocks must be balanced");
  return calls;
}

test("headless cleanup only accepts exact integration-only operation and never invokes credential cleanup", async () => {
  let count = 0;
  for (const args of [[], ["--clear"], ["--integration-only", "/arbitrary"], ["--integration-only", "--delete-projects"]]) {
    await assert.rejects(runIntegrationCleanup(args, async () => { count++; }));
  }
  await runIntegrationCleanup(["--integration-only"], async () => { count++; });
  assert.equal(count, 1);
});

test("NSIS cleans managed integration before uninstall and reports failure without deleting user data", async () => {
  const hook = await readFile(new URL("../build/installer.nsh", import.meta.url), "utf8");
  assert.match(hook, /customUnInstall/); assert.match(hook, /cleanup\.cjs/); assert.match(hook, /--integration-only/);
  assert.match(hook, /ExecToStack \/TIMEOUT=30000/); assert.match(hook, /MessageBox/);
  assert.doesNotMatch(hook, /RMDir|Delete\s|--clear/);
});

test("NSIS cleanup executes on ordinary uninstall and is skipped during an update", async () => {
  const hook = await readFile(new URL("../build/installer.nsh", import.meta.url), "utf8");
  const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
  const template = await readFile(join(dirname(builderRequire.resolve("app-builder-lib/package.json")), "templates/nsis/uninstaller.nsh"), "utf8");
  const hookInsertion = template.indexOf("!insertmacro customUnInstall");
  const appRemoval = template.indexOf("# delete the installed files");
  assert.ok(hookInsertion > 0 && appRemoval > hookInsertion, "electron-builder must call this hook before deleting app files");
  assert.match(template, /\$\{if\} \$\{isUpdated\}/, "the include context must expose electron-builder's update flag");
  assert.equal(cleanupCallsInHook(hook, false), 1, "ordinary uninstall runs cleanup once");
  assert.equal(cleanupCallsInHook(hook, true), 0, "update must preserve the managed launcher and Skill");
});
