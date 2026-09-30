import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { runIntegrationCleanup } from "../src/cleanup-entry.js";
import { desktopPaths, whisperXProgramPaths } from "../src/paths.js";
import { scanAgentTargets } from "../src/agent-targets.js";
import { installManagedSkill, SKILL_MARKER } from "../src/skill-install.js";
import { removeDesktopIntegration } from "../src/lifecycle.js";
import * as desktopMain from "../src/main.js";

const require = createRequire(new URL("../package.json", import.meta.url));

test("ordinary integration removal retains Program Home, shared caches and either local or future alignment binding", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hypit-retain-whisperx-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home, appData: join(home, "appdata") });
  const program = whisperXProgramPaths(paths);
  await mkdir(join(program.home, ".venv"), { recursive: true });
  await mkdir(dirname(paths.profile), { recursive: true });
  const shared = join(home, "shared-cache");
  await mkdir(shared);
  await symlink(shared, join(program.home, "user-cache"));
  const retained = [join(program.home, ".venv", "python"), program.installationLog, program.serviceLog,
    join(program.home, "unknown-user-file"), join(shared, "model.bin"), program.state];
  for (const path of retained) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, "retain exact bytes"); }
  for (const binding of ["whisperx.local", "newapi.personal"]) {
    const profile = JSON.stringify({ endpoints: { "whisperx.local": { use: "@hypit/provider-whisperx-local" } },
      bindings: { "@hypit/whisperx@1#whisperx-alignment": binding } });
    await writeFile(paths.profile, profile);
    await runIntegrationCleanup(["--integration-only"], () => removeDesktopIntegration({ paths, home, platform: "darwin" }));
    assert.equal(await readFile(paths.profile, "utf8"), profile);
    for (const path of retained) assert.equal(await readFile(path, "utf8"), "retain exact bytes");
    assert.equal(await readlink(join(program.home, "user-cache")), shared);
  }
});

test("successful native cleanup prints retained local speech resources and safe manual guidance", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hypit-cleanup-message-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const { build } = require("esbuild");
  const built = await build({ entryPoints: [fileURLToPath(new URL("../src/cleanup-entry.ts", import.meta.url))], bundle: true, platform: "node", format: "cjs", write: false });
  let output = "";
  const processStub = { platform: "darwin", env: {}, argv: ["node", "cleanup.cjs", "--integration-only"], stderr: { write: (value: string) => { output += value; } }, exitCode: 0 };
  const module = { exports: {} as { startIntegrationCleanup(): Promise<void> } };
  runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, process: processStub,
    require: (name: string) => name === "node:os" ? { homedir: () => home } : require(name) });
  await module.exports.startIntegrationCleanup();
  assert.equal(processStub.exitCode, 0);
  assert.match(output, /本地语音资源.*已保留/);
  assert.match(output, /Program Home/);
  assert.match(output, /人工检查/);
});

test("desktop guidance states optional preparation, upstream caches, retention and provider-neutral future binding", async () => {
  for (const path of ["../../../docs/zh/guide/desktop-installer.md", "../README.md"]) {
    const guide = await readFile(new URL(path, import.meta.url), "utf8");
    for (const text of ["本地语音识别与字幕对齐（可选）", "small", "int8", "Program Home", "Hugging Face", "uv", "模型缓存", "newapi.personal", "@hypit/whisperx@1#whisperx-alignment", "逐词", "句子级", "人工检查"]) assert.ok(guide.includes(text), `${path}: missing ${text}`);
  }
});

test("integration confirmation names every supported destination and explicit legacy recovery on both platforms", () => {
  assert.equal(typeof desktopMain.integrationConfirmationTargets, "function");
  for (const platform of ["darwin", "win32"] as const) {
    const home = platform === "darwin" ? "/Users/test" : "C:\\Users\\test";
    const paths = desktopPaths({ platform, home, appData: home });
    assert.deepEqual(desktopMain.integrationConfirmationTargets({ paths, platform, home }), [
      paths.launcher, paths.portableSkill, paths.claudeSkill,
      `旧版迁移／手动恢复：${paths.legacyCodexSkill}`, paths.managedState,
      platform === "darwin" ? join(home, ".zprofile") : "HKCU\\Environment\\Path",
    ]);
  }
});

test("cleanup failure names portable, compatibility and legacy manual-recovery paths on both platforms", async () => {
  const { build } = require("esbuild");
  const built = await build({ entryPoints: [fileURLToPath(new URL("../src/cleanup-entry.ts", import.meta.url))], bundle: true, platform: "node", format: "cjs", write: false });
  for (const platform of ["darwin", "win32"] as const) {
    const home = platform === "win32" ? "C:\\Users\\test" : "/Users/test";
    const appData = platform === "win32" ? "C:\\Users\\test\\AppData\\Local" : join(home, "Library", "Application Support");
    const paths = desktopPaths({ platform, home, appData });
    let output = "";
    const processStub = { platform, env: { LOCALAPPDATA: appData }, argv: ["node", "cleanup.cjs", "--invalid"], stderr: { write: (value: string) => { output += value; } }, exitCode: 0 };
    const module = { exports: {} as { startIntegrationCleanup(): Promise<void> } };
    runInNewContext(built.outputFiles[0].text, { module, exports: module.exports, process: processStub,
      require: (name: string) => name === "node:os" ? { homedir: () => home } : require(name) });
    await module.exports.startIntegrationCleanup();
    assert.equal(processStub.exitCode, 1);
    for (const path of [paths.launcher, paths.portableSkill, paths.claudeSkill]) assert.ok(output.includes(path), `missing recovery path: ${path}`);
    assert.ok(output.includes(`旧版手动恢复：${paths.legacyCodexSkill}`));
    assert.match(output, /凭据与项目已保留/);
    assert.doesNotMatch(output, /仅允许卸载托管集成/);
  }
});

test("NSIS recovery names all Skill paths and labels Codex as legacy manual recovery", async () => {
  const hook = await readFile(new URL("../build/installer.nsh", import.meta.url), "utf8");
  for (const path of ["$PROFILE\\.agents\\skills\\hypit", "$PROFILE\\.claude\\skills\\hypit", "旧版手动恢复：$PROFILE\\.codex\\skills\\hypit"]) assert.ok(hook.includes(path), `missing recovery path: ${path}`);
});

test("desktop Skill instructions explain portable discovery, absolute launchers and credential-free rescanning", async () => {
  const guide = await readFile(new URL("../../../skills/hypit/references/environment/distribution.md", import.meta.url), "utf8");
  for (const text of ["~/.agents/skills/hypit", "~/.claude/skills/hypit", "~/.local/bin/hypit", "%LOCALAPPDATA%\\Hypit\\bin\\hypit.cmd", "Codex, Claymore Piko and Cursor", "重新扫描 Agent", "does not request or rewrite model credentials"]) assert.ok(guide.includes(text), `missing installation guidance: ${text}`);
  assert.doesNotMatch(guide, /managed Codex Skill|restart Codex and Terminal/);
});

test("Chinese desktop guide explains portable and conditional Claude targets with credential-free rescan", async () => {
  const guide = await readFile(new URL("../../../docs/zh/guide/desktop-installer.md", import.meta.url), "utf8");
  for (const text of ["~/.agents/skills/hypit", "~/.claude/skills/hypit", "检测到 Claude Code", "重新扫描 Agent", "不会读取或改写凭据", "旧版", "手动恢复", "重启正在使用的 Agent 和终端"]) assert.ok(guide.includes(text), `missing guidance: ${text}`);
  assert.doesNotMatch(guide, /Codex Skill 位于|重启 Codex 和终端/);
});

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

test("NSIS displays nonempty successful cleanup output while continuing uninstall", async () => {
  const hook = await readFile(new URL("../build/installer.nsh", import.meta.url), "utf8");
  assert.match(hook, /\$\{ElseIf\} \$1 != ""\s+MessageBox MB_OK\|MB_ICONINFORMATION "\$1"/);
  assert.doesNotMatch(hook, /Abort|Quit|SetErrorLevel/);
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
