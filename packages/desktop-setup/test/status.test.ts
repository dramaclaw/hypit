import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { parseHTML } from "linkedom";
import { completeNewApiSetup } from "@dramaclaw/provider-newapi";
import { createDesktopProfile } from "../src/profile.js";
import { desktopPaths } from "../src/paths.js";
import { scanAgentTargets, supportedSkillTargets } from "../src/agent-targets.js";
import { installDesktopIntegration, removeDesktopIntegration } from "../src/lifecycle.js";
import { commitDesktopSetup } from "../src/setup-core.js";
import { createSetupController, readDesktopStatus, reconcileStartupStatus, refreshDesktopStatus, rescanIntegrationTargets, serializeFailure } from "../src/main.js";
import { runDiagnostics } from "../src/diagnostics.js";
import { renderLauncher } from "../src/launcher-install.js";
import { mountWizard } from "../src/renderer.js";
import { isManagedSkillInstalled, SKILL_MARKER } from "../src/skill-install.js";
import type { SetupInput } from "../src/contracts.js";

const input: SetupInput = { baseUrl: "https://newapi.example/v1", apiKey: "SECRET_API", relay: {
  enabled: true, endpoint: "oss.example", bucket: "test-bucket", accessKeyId: "SECRET_ID", accessKeySecret: "SECRET_KEY",
} };
const profile = () => createDesktopProfile(completeNewApiSetup(input).config) as any;
async function fixture(t: TestContext) {
  const home = await mkdtemp(join(tmpdir(), "hypit-status-"));
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
  await mkdir(dirname(paths.profile), { recursive: true });
  return { paths, targets: (await scanAgentTargets({ paths })).targets, home, platform: "darwin" as const, sourceDirectory, installedVersion: "1", electronExecutable, cliEntry };
}

async function missingBackupFixture(t: TestContext) {
  const f = await fixture(t);
  await mkdir(f.paths.portableSkill, { recursive: true });
  await writeFile(join(f.paths.portableSkill, "SKILL.md"), "original private user Skill");
  await writeFile(f.paths.profile, JSON.stringify(profile()));
  await installDesktopIntegration(f);
  await rm(f.paths.portableSkillBackup, { recursive: true });
  return f;
}

test("same-version status and diagnostics reject missing recorded backup with an actionable warning", async (t) => {
  const f = await missingBackupFixture(t);
  assert.equal(await isManagedSkillInstalled(f.targets[0]!), false);
  const status = await readDesktopStatus(f);
  assert.equal(status.configured, false);
  const warning = { code: "skill", label: "通用 Agent Skill", target: "portable", status: "warning",
    path: f.paths.portableSkillBackup, reason: "SKILL_BACKUP_UNAVAILABLE" };
  assert.deepEqual(status.diagnostics.find(item => item.reason === "SKILL_BACKUP_UNAVAILABLE"), warning);
  const diagnostics = await runDiagnostics({ ...f, resources: f.sourceDirectory, arch: "arm64",
    credentialStore: { owns: () => false, resolve: async () => undefined }, execute: async () => {} });
  assert.deepEqual(diagnostics.find(item => item.reason === "SKILL_BACKUP_UNAVAILABLE"), warning);
  assert.equal(diagnostics.find(item => item.code === "skill")?.status, "fail");
  const controller = createSetupController({ getStatus: () => readDesktopStatus(f), commit: async () => status,
    install: async () => {}, diagnose: async () => diagnostics, clear: async () => status, openConfig: async () => {} });
  const result = await controller.rerunDiagnostics();
  assert.equal(result.ok, true);
  if (result.ok) assert.ok(result.value.diagnostics.some(item => item.reason === "SKILL_BACKUP_UNAVAILABLE"));
});

test("fresh status and diagnostics discover launcher, managed-state, and zprofile recovery siblings", async (t) => {
  const f = await fixture(t);
  await writeFile(f.paths.profile, JSON.stringify(profile()));
  await installDesktopIntegration(f);
  const recoveryPaths = [f.paths.launcher, f.paths.managedState, join(f.home, ".zprofile")]
    .map(path => `${path}.recovery-A1b2C3`);
  for (const path of recoveryPaths) await mkdir(path);
  const status = await readDesktopStatus(f);
  assert.equal(status.configured, true);
  assert.deepEqual(status.diagnostics.filter(item => item.code === "launcher" && item.reason === "CLEANUP_INCOMPLETE")
    .map(item => item.path), recoveryPaths);
  const diagnostics = await runDiagnostics({ ...f, resources: f.sourceDirectory, arch: "arm64",
    credentialStore: { owns: () => false, resolve: async () => undefined }, execute: async () => {} });
  assert.deepEqual(diagnostics.filter(item => item.code === "launcher" && item.reason === "CLEANUP_INCOMPLETE")
    .map(item => item.path), recoveryPaths);
  for (const path of recoveryPaths) await rm(path, { recursive: true });
  assert.ok(!(await readDesktopStatus(f)).diagnostics.some(item => item.code === "launcher" && item.reason === "CLEANUP_INCOMPLETE"));
});

test("missing backup retains an owned Claude target after Agent discovery stops finding it", async (t) => {
  const f = await fixture(t);
  const targets = supportedSkillTargets(f.paths);
  await mkdir(f.paths.claudeSkill, { recursive: true });
  await writeFile(join(f.paths.claudeSkill, "SKILL.md"), "user Claude");
  await writeFile(f.paths.profile, JSON.stringify(profile()));
  await installDesktopIntegration({ ...f, targets });
  await rm(f.paths.claudeSkillBackup, { recursive: true });
  const scan = { targets: [targets[0]!], detectedAgents: [] };
  const status = await readDesktopStatus(f, scan);
  assert.equal(status.configured, false);
  assert.deepEqual(status.skillTargets.map(target => target.id), ["portable", "claude"]);
  assert.deepEqual((await rescanIntegrationTargets(f.paths, async () => scan)).map(target => target.id), ["portable", "claude"]);
  assert.equal(status.diagnostics.find(item => item.reason === "SKILL_BACKUP_UNAVAILABLE")?.path, f.paths.claudeSkillBackup);
});

for (const version of ["1", "2"]) {
  test(`missing backup blocks explicit refresh and upgrade without losing ownership (version ${version})`, async (t) => {
    const f = await missingBackupFixture(t);
    const files = [f.paths.launcher, f.paths.managedState, f.paths.profile, join(f.paths.portableSkill, SKILL_MARKER)];
    const before = await Promise.all(files.map(path => readFile(path)));
    const options = { ...f, installedVersion: version };
    await assert.rejects(installDesktopIntegration(options), /\[SKILL_BACKUP_UNAVAILABLE\]$/u);
    assert.equal((await refreshDesktopStatus(options)).configured, false);
    await assert.rejects(removeDesktopIntegration(f), /\[SKILL_BACKUP_UNAVAILABLE\]$/u);
    assert.deepEqual(await Promise.all(files.map(path => readFile(path))), before);
    const error = serializeFailure(new Error("private detail [SKILL_BACKUP_UNAVAILABLE]"));
    assert.equal(error.code, "SKILL_BACKUP_UNAVAILABLE");
    assert.match(error.message, /恢复.*备份/);
    assert.doesNotMatch(JSON.stringify(error), /private/);
  });
}

test("status rejects missing, malformed, empty, and partial NewAPI profiles even with installed integration", async (t) => {
  const f = await fixture(t);
  await installDesktopIntegration(f);
  assert.equal((await readDesktopStatus(f)).configured, false);
  const empty = profile(); empty.endpoints["newapi.personal"].config.baseUrl = " ";
  const emptyString = profile(); emptyString.endpoints["newapi.personal"].config.baseUrl = "";
  const invalidUrl = profile(); invalidUrl.endpoints["newapi.personal"].config.baseUrl = "not-a-url";
  const wrongProvider = profile(); wrongProvider.endpoints["newapi.personal"].use = "@other/provider";
  const inlineSecret = profile(); inlineSecret.endpoints["newapi.personal"].config.apiKey = "SECRET_INLINE";
  const missingRef = profile(); delete missingRef.endpoints["newapi.personal"].config.apiKey;
  const missingOss = profile(); delete missingOss.endpoints["newapi.personal"].config.relayAccessKeySecret;
  const missingBindings = profile(); delete missingBindings.bindings;
  for (const content of ["{", "null", "{}", ...[empty, emptyString, invalidUrl, wrongProvider, inlineSecret, missingRef, missingOss, missingBindings].map((value) => JSON.stringify(value)),
    JSON.stringify({ format: "hypit.runtime-local@1", endpoints: { "newapi.personal": { config: { baseUrl: "https://api.example" } } } })]) {
    await writeFile(f.paths.profile, content);
    const status = await readDesktopStatus(f);
    assert.equal(status.configured, false, content);
    assert.equal(status.diagnostics.find((item) => item.code === "profile")?.status, "fail");
    assert.equal(JSON.stringify(status).includes("SECRET"), false);
  }
});

test("status distinguishes a pristine install from incomplete local artifacts", async (t) => {
  const f = await fixture(t);
  const pristine = await readDesktopStatus(f);
  assert.equal(pristine.configured, false);
  assert.deepEqual(pristine.diagnostics, []);

  for (const target of [f.paths.profile, f.paths.portableSkill, f.paths.portableSkillBackup, f.paths.launcher, f.paths.managedState]) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "broken");
    const partial = await readDesktopStatus(f);
    assert.equal(partial.configured, false, target);
    assert.deepEqual(partial.diagnostics.map((item) => [item.code, item.status]), [["profile", "fail"], ["skill", "fail"],
      ...(target === f.paths.portableSkillBackup ? [["skill", "warning"]] : []), ["launcher", "fail"]], target);
    await rm(target);
  }
});

test("status projects each active and retained managed Skill target separately", async (t) => {
  const f = await fixture(t);
  const targets = supportedSkillTargets(f.paths);
  await writeFile(f.paths.profile, JSON.stringify(profile()));
  await installDesktopIntegration({ ...f, targets });
  const status = await readDesktopStatus({ ...f, targets: [targets[0]!] }, { detectedAgents: [], targets: [targets[0]!] });
  assert.equal(status.configured, true);
  assert.deepEqual(status.skillTargets.map(target => target.id), ["portable", "claude"]);
  assert.deepEqual(status.diagnostics.filter(item => item.code === "skill").map(item => item.target), ["portable", "claude"]);
  assert.deepEqual(status.diagnostics.filter(item => item.code === "skill").map(item => item.label), ["通用 Agent Skill", "Claude Code Skill"]);
  assert.equal(JSON.stringify(status).includes("SECRET"), false);
  await rm(join(f.paths.claudeSkill, SKILL_MARKER));
  const stale = await readDesktopStatus({ ...f, targets: [targets[0]!] }, { detectedAgents: [], targets: [targets[0]!] });
  assert.equal(stale.configured, true);
  assert.deepEqual(stale.skillTargets.map(target => target.id), ["portable"]);
});

test("unmanaged legacy Codex Skill reports a portable warning and remains untouched", async (t) => {
  const f = await fixture(t);
  await mkdir(f.paths.legacyCodexSkill, { recursive: true });
  await writeFile(join(f.paths.legacyCodexSkill, "SKILL.md"), "user-owned SECRET legacy content");
  const status = await readDesktopStatus(f);
  assert.ok(status.diagnostics.some(item => item.code === "skill" && item.target === "portable" && item.status === "warning" && item.path === f.paths.legacyCodexSkill));
  assert.equal(await readFile(join(f.paths.legacyCodexSkill, "SKILL.md"), "utf8"), "user-owned SECRET legacy content");
  assert.equal(JSON.stringify(status).includes("SECRET"), false);
});

test("startup controller keeps a ready install configured when legacy Codex tree only adds a warning", async (t) => {
  const f = await fixture(t);
  await writeFile(f.paths.profile, JSON.stringify(profile()));
  await installDesktopIntegration(f);
  await mkdir(f.paths.legacyCodexSkill, { recursive: true });
  await writeFile(join(f.paths.legacyCodexSkill, "SKILL.md"), "user legacy Skill");
  const refreshed = await refreshDesktopStatus(f);
  assert.equal(refreshed.configured, true);
  const controller = createSetupController({ getStatus: async () => reconcileStartupStatus(await readDesktopStatus(f), refreshed),
    commit: async () => refreshed, install: async () => {}, diagnose: async () => [], openConfig: async () => {}, clear: async () => refreshed });
  const reply = await controller.getStatus();
  assert.equal(reply.ok, true);
  if (reply.ok) {
    assert.equal(reply.value.configured, true);
    assert.ok(reply.value.diagnostics.some(item => item.code === "skill" && item.target === "portable" && item.status === "warning" && item.path === f.paths.legacyCodexSkill));
  }
  const rollbackWarning = { code: "profile" as const, label: "Runtime Profile" as const, status: "warning" as const, path: f.paths.profile };
  const failedRefresh = { ...refreshed, configured: false, diagnostics: [...refreshed.diagnostics, rollbackWarning] };
  const guarded = reconcileStartupStatus(await readDesktopStatus(f), failedRefresh);
  assert.equal(guarded.configured, false);
  assert.deepEqual(guarded.diagnostics.find(item => item.code === "profile"), rollbackWarning);
});

test("completion requires a valid profile, intact managed Skill, launcher and managed state", async (t) => {
  const f = await fixture(t);
  await writeFile(f.paths.profile, JSON.stringify(profile()));
  const partial = await readDesktopStatus(f);
  assert.equal(partial.configured, false);
  assert.deepEqual(partial.diagnostics.map((item) => [item.code, item.status]), [["profile", "pass"], ["skill", "fail"], ["launcher", "fail"]]);
  await installDesktopIntegration(f);
  const complete = await readDesktopStatus(f);
  assert.equal(complete.configured, true);
  assert.equal(complete.relayVerified, false); // Startup has not performed a network probe.
  for (const target of [f.paths.managedState, f.paths.launcher, join(f.paths.portableSkill, SKILL_MARKER), join(f.paths.portableSkill, "SKILL.md"), join(f.paths.portableSkill, "references", "guide.md")]) {
    const original = await readFile(target);
    await writeFile(target, "broken");
    assert.equal((await readDesktopStatus(f)).configured, false, target);
    await writeFile(target, original);
  }
  assert.equal((await readDesktopStatus(f)).configured, true);
});

test("profile committed then real integration failure reopens setup with failed installation diagnostics", async (t) => {
  const f = await fixture(t);
  const controller = createSetupController({
    getStatus: () => readDesktopStatus(f),
    commit: (value) => commitDesktopSetup(value, { paths: f.paths, targets: f.targets, platform: f.platform,
      credentialStore: { owns: () => true, resolve: async () => undefined, put: async () => {}, delete: async () => false },
      connectionTest: { fetch: async (url) => String(url).endsWith("/models") ? Response.json({ data: [{ id: "model" }] }) : new Response("HY"),
        randomUUID: () => "00000000-0000-4000-8000-000000000001",
        createOssClient: () => ({ put: async () => {}, signatureUrl: () => "https://oss.example/probe", delete: async () => {} }) },
    }),
    install: () => installDesktopIntegration({ ...f, copyDirectory: async () => { throw new Error("SECRET_FAILURE"); } }),
    diagnose: async () => [], openConfig: async () => {}, clear: () => readDesktopStatus(f),
  });
  assert.deepEqual(await controller.submit(input), { ok: false, error: { code: "INTEGRATION_INSTALL_FAILED", message: "桌面集成安装失败" } });
  assert.equal(JSON.parse(await readFile(f.paths.profile, "utf8")).format, "hypit.runtime-local@1");
  const { document } = parseHTML("<main id='app'></main>");
  const root = document.getElementById("app")! as unknown as HTMLElement;
  const reopenedStatus = await controller.getStatus();
  const dispose = mountWizard(root, { ...controller, getStatus: async () => reopenedStatus, onProgress: controller.subscribe }, { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(root.textContent!, /安装尚未完成/);
  assert.match(root.textContent!, /命令入口.*失败/);
  assert.match(root.textContent!, /通用 Agent Skill.*失败/);
  assert.doesNotMatch(root.textContent!, /Hypit 已配置|SECRET/);
  assert.equal(root.querySelectorAll("input[required]").length, 6);
  dispose();
});

test("Windows status requires its managed launcher and user PATH entry", async (t) => {
  const f = await fixture(t);
  let path = "C:\\Existing Tools";
  const options = { ...f, platform: "win32" as const, userPath: { read: async () => path, compareAndSet: async (expected: string, value: string) => { if (path !== expected) return false; path = value; return true; } } };
  await writeFile(f.paths.profile, JSON.stringify(profile()));
  await installDesktopIntegration(options);
  assert.equal((await readDesktopStatus(options)).configured, true);
  path = "C:\\Existing Tools";
  const status = await readDesktopStatus(options);
  assert.equal(status.configured, false);
  assert.equal(status.diagnostics.find((item) => item.code === "launcher")?.status, "fail");
});

for (const platform of ["darwin", "win32"] as const) {
  test(`${platform} status detects a bundle upgrade even while the previous integration is intact`, async (t) => {
    const f = await fixture(t);
    let path = "";
    const options = { ...f, platform, userPath: { read: async () => path, compareAndSet: async (expected: string, value: string) => { if (path !== expected) return false; path = value; return true; } } };
    await writeFile(f.paths.profile, JSON.stringify(profile()));
    await installDesktopIntegration(options);
    assert.equal((await readDesktopStatus({ ...options, installedVersion: "2" })).configured, false);
    await writeFile(join(f.sourceDirectory, "references", "guide.md"), "updated bundled guide");
    const status = await readDesktopStatus(options);
    assert.equal(status.configured, false);
    assert.equal(status.diagnostics.find(item => item.code === "skill")?.status, "fail");
  });

  test(`${platform} status detects a moved app launcher even while the original target exists`, async (t) => {
    const f = await fixture(t);
    let path = "";
    const options = { ...f, platform, userPath: { read: async () => path, compareAndSet: async (expected: string, value: string) => { if (path !== expected) return false; path = value; return true; } } };
    await writeFile(f.paths.profile, JSON.stringify(profile()));
    await installDesktopIntegration(options);
    const electronExecutable = join(f.home, "moved-app", "electron");
    await mkdir(dirname(electronExecutable));
    await writeFile(electronExecutable, "fake new app");
    const status = await readDesktopStatus({ ...options, electronExecutable });
    assert.equal(status.configured, false);
    assert.equal(status.diagnostics.find(item => item.code === "launcher")?.status, "fail");
  });

  test(`${platform} startup refresh upgrades and relocates integration without changing the saved profile`, async (t) => {
    const f = await fixture(t);
    let path = "original PATH";
    const options = { ...f, platform, userPath: { read: async () => path, compareAndSet: async (expected: string, value: string) => { if (path !== expected) return false; path = value; return true; } } };
    const saved = JSON.stringify(profile());
    await writeFile(f.paths.profile, saved);
    await installDesktopIntegration(options);
    const electronExecutable = join(f.home, "new-app", "electron");
    const cliEntry = join(f.home, "new-app", "cli.mjs");
    await mkdir(dirname(electronExecutable));
    await writeFile(electronExecutable, "new app");
    await writeFile(cliEntry, "new CLI");
    await writeFile(join(f.sourceDirectory, "references", "guide.md"), "new guide");
    const current = { ...options, electronExecutable, cliEntry, installedVersion: "2" };
    const result = await refreshDesktopStatus(current);
    assert.equal(result.configured, true);
    assert.equal(await readFile(f.paths.profile, "utf8"), saved);
    assert.equal(await readFile(join(f.paths.portableSkill, "references", "guide.md"), "utf8"), "new guide");
    assert.equal(JSON.parse(await readFile(join(f.paths.portableSkill, SKILL_MARKER), "utf8")).installedVersion, "2");
    assert.equal(await readFile(f.paths.launcher, "utf8"), renderLauncher(current));
    assert.equal(result.relayVerified, false);
    assert.equal((await refreshDesktopStatus(current)).configured, true);
  });

  test(`${platform} startup refresh repairs missing integration for an already valid profile`, async (t) => {
    const f = await fixture(t);
    let path = "";
    const options = { ...f, platform, userPath: { read: async () => path, compareAndSet: async (expected: string, value: string) => { if (path !== expected) return false; path = value; return true; } } };
    await writeFile(f.paths.profile, JSON.stringify(profile()));
    assert.equal((await refreshDesktopStatus(options)).configured, true);
    await rm(f.paths.launcher);
    assert.equal((await refreshDesktopStatus(options)).configured, true);
    await rm(f.paths.portableSkill, { recursive: true });
    assert.equal((await refreshDesktopStatus(options)).configured, true);
  });

  test(`${platform} failed startup refresh rolls back launcher, Skill and PATH and reports incomplete`, async (t) => {
    const f = await fixture(t);
    let path = "original PATH";
    const options = { ...f, platform, userPath: { read: async () => path, compareAndSet: async (expected: string, value: string) => { if (path !== expected) return false; path = value; return true; } } };
    await writeFile(f.paths.profile, JSON.stringify(profile()));
    await installDesktopIntegration(options);
    const files = [f.paths.profile, f.paths.launcher, f.paths.managedState, join(f.paths.portableSkill, "SKILL.md"), join(f.paths.portableSkill, SKILL_MARKER),
      ...(platform === "darwin" ? [join(f.home, ".zprofile")] : [])];
    const before = await Promise.all(files.map(file => readFile(file)));
    const oldPath = path;
    const electronExecutable = join(f.home, "new-electron");
    await writeFile(electronExecutable, "new app");
    const status = await refreshDesktopStatus({ ...options, electronExecutable, installedVersion: "2",
      copyDirectory: async () => { throw new Error("SECRET_FAILURE"); } });
    assert.equal(status.configured, false);
    assert.equal(status.diagnostics.find(item => item.code === "launcher")?.status, "fail");
    assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
    assert.equal(path, oldPath);
    assert.doesNotMatch(JSON.stringify(status), /SECRET_FAILURE/);
  });
}

for (const modification of ["unmanaged-skill", "edited-skill", "edited-launcher", "unmanaged-launcher", "edited-path", "missing-backup"] as const) {
  test(`startup refresh preserves ${modification} and reports incomplete`, async (t) => {
    const f = await fixture(t);
    await writeFile(f.paths.profile, JSON.stringify(profile()));
    await installDesktopIntegration(f);
    if (modification === "unmanaged-skill") await rm(join(f.paths.portableSkill, SKILL_MARKER));
    if (modification === "edited-skill") await writeFile(join(f.paths.portableSkill, "references", "guide.md"), "user edits");
    if (modification === "edited-launcher") await writeFile(f.paths.launcher, "user launcher");
    if (modification === "unmanaged-launcher") await rm(f.paths.managedState);
    if (modification === "edited-path") await writeFile(join(f.home, ".zprofile"), "user PATH edits");
    if (modification === "missing-backup") {
      const markerFile = join(f.paths.portableSkill, SKILL_MARKER);
      await writeFile(markerFile, JSON.stringify({ ...JSON.parse(await readFile(markerFile, "utf8")), backupDirectory: f.paths.portableSkillBackup }));
    }
    const files = [f.paths.profile, f.paths.launcher, join(f.paths.portableSkill, "SKILL.md"), join(f.paths.portableSkill, "references", "guide.md"), join(f.home, ".zprofile"),
      ...(modification === "unmanaged-skill" ? [] : [join(f.paths.portableSkill, SKILL_MARKER)]), ...(modification === "unmanaged-launcher" ? [] : [f.paths.managedState])];
    const before = await Promise.all(files.map(file => readFile(file)));
    const result = await refreshDesktopStatus({ ...f, installedVersion: "2" });
    assert.equal(result.configured, false);
    assert.ok(result.diagnostics.some(item => item.status === "fail"));
    assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
  });
}
