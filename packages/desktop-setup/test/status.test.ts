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
import { installDesktopIntegration } from "../src/lifecycle.js";
import { commitDesktopSetup } from "../src/setup-core.js";
import { createSetupController, readDesktopStatus } from "../src/main.js";
import { mountWizard } from "../src/renderer.js";
import { SKILL_MARKER } from "../src/skill-install.js";
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
  return { paths, home, platform: "darwin" as const, sourceDirectory, installedVersion: "1", electronExecutable, cliEntry };
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

  for (const target of [f.paths.profile, f.paths.skill, f.paths.skillBackup, f.paths.launcher, f.paths.managedState]) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "broken");
    const partial = await readDesktopStatus(f);
    assert.equal(partial.configured, false, target);
    assert.deepEqual(partial.diagnostics.map((item) => [item.code, item.status]), [["profile", "fail"], ["skill", "fail"], ["launcher", "fail"]], target);
    await rm(target);
  }
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
  for (const target of [f.paths.managedState, f.paths.launcher, join(f.paths.skill, SKILL_MARKER), join(f.paths.skill, "SKILL.md"), join(f.paths.skill, "references", "guide.md")]) {
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
    commit: (value) => commitDesktopSetup(value, { paths: f.paths, platform: f.platform,
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
  assert.match(root.textContent!, /Codex Skill.*失败/);
  assert.doesNotMatch(root.textContent!, /Hypit 已配置|SECRET/);
  assert.equal(root.querySelectorAll("input[required]").length, 6);
  dispose();
});

test("Windows status requires its managed launcher and user PATH entry", async (t) => {
  const f = await fixture(t);
  let path = "C:\\Existing Tools";
  const options = { ...f, platform: "win32" as const, userPath: { read: async () => path, write: async (value: string) => { path = value; } } };
  await writeFile(f.paths.profile, JSON.stringify(profile()));
  await installDesktopIntegration(options);
  assert.equal((await readDesktopStatus(options)).configured, true);
  path = "C:\\Existing Tools";
  const status = await readDesktopStatus(options);
  assert.equal(status.configured, false);
  assert.equal(status.diagnostics.find((item) => item.code === "launcher")?.status, "fail");
});
