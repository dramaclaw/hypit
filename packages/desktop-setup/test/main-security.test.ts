import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";
import { browserWindowOptions, createSetupController, isTrustedSender, localPageUrl, serializeFailure, validateIpcArguments, hardenWebContents } from "../src/main.js";
import { IPC_CHANNELS } from "../src/ipc.js";
import type { SetupInput, SetupResult } from "../src/contracts.js";

const input: SetupInput = { baseUrl: "https://api.example/v1", apiKey: "SECRET_API", relay: { enabled: true, endpoint: "oss.example", bucket: "test-bucket", accessKeyId: "SECRET_ID", accessKeySecret: "SECRET_KEY" } };
const result: SetupResult = { configured: true, modelCount: 2, relayVerified: true, profilePath: "/profile", skillTargets: [{ id: "portable", label: "通用 Agent Skill", path: "/skill", detectedAgents: ["codex"] }], launcherPath: "/launcher", diagnostics: [] };

test("window uses isolated sandbox with no Node or webview and only absolute local page", () => {
  const options = browserWindowOptions("/local/preload.cjs");
  assert.deepEqual(options.webPreferences, { preload: "/local/preload.cjs", contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, webSecurity: true, devTools: false });
  assert.equal("enableRemoteModule" in options.webPreferences!, false);
  assert.equal(localPageUrl("/local/index.html"), pathToFileURL("/local/index.html").href);
  assert.throws(() => localPageUrl("https://example.com"));
  assert.throws(() => browserWindowOptions("relative.cjs"));
});

test("IPC channels are closed and arguments cannot smuggle keys or invalid values", () => {
  assert.deepEqual(Object.values(IPC_CHANNELS).sort(), ["setup:clear", "setup:remove-integration", "setup:diagnostics", "setup:open-config", "setup:progress", "setup:status", "setup:submit", "setup:subscribe", "setup:unsubscribe"].sort());
  assert.deepEqual(validateIpcArguments("setup:submit", [input]), input);
  for (const invalid of [{ ...input, extra: true }, { ...input, apiKey: "" }, { ...input, relay: { ...input.relay, extra: true } }, { ...input, relay: { enabled: false } }, { ...input, baseUrl: "https://key:secret@api.example" }, { ...input, baseUrl: "https://api.example?apiKey=secret" }]) {
    assert.throws(() => validateIpcArguments("setup:submit", [invalid]));
  }
  for (const channel of ["setup:status", "setup:diagnostics", "setup:open-config", "setup:clear", "setup:remove-integration", "setup:subscribe", "setup:unsubscribe"] as const) {
    assert.equal(validateIpcArguments(channel, []), undefined);
    assert.throws(() => validateIpcArguments(channel, ["/arbitrary/path"]));
  }
  assert.throws(() => validateIpcArguments("arbitrary", []));
});

test("sender must be the exact window main frame at the bundled URL", () => {
  const mainFrame = { url: "file:///local/index.html" };
  const contents = { mainFrame };
  assert.equal(isTrustedSender({ sender: contents, senderFrame: mainFrame }, contents, mainFrame.url), true);
  assert.equal(isTrustedSender({ sender: contents, senderFrame: { ...mainFrame } }, contents, mainFrame.url), false);
  assert.equal(isTrustedSender({ sender: contents, senderFrame: mainFrame }, {}, mainFrame.url), false);
  assert.equal(isTrustedSender({ sender: contents, senderFrame: mainFrame }, contents, "https://example.com"), false);
});

test("navigation, popups, webviews and permission requests are refused", () => {
  const events = new Map<string, (...args: any[]) => void>();
  let open: (() => { action: string }) | undefined;
  let permission: ((...args: any[]) => void) | undefined;
  let check: (() => boolean) | undefined;
  hardenWebContents({ on: (name: string, listener: (...args: any[]) => void) => { events.set(name, listener); }, setWindowOpenHandler: (fn: typeof open) => { open = fn; }, session: { setPermissionRequestHandler: (fn: typeof permission) => { permission = fn; }, setPermissionCheckHandler: (fn: typeof check) => { check = fn; } } } as any);
  for (const event of ["will-navigate", "will-frame-navigate", "will-redirect", "will-attach-webview"]) {
    let prevented = false;
    events.get(event)!({ preventDefault() { prevented = true; } });
    assert.equal(prevented, true);
  }
  assert.deepEqual(open!(), { action: "deny" });
  let permitted: boolean | undefined;
  permission!({}, "camera", (value: boolean) => { permitted = value; });
  assert.equal(permitted, false);
  assert.equal(check!(), false);
});

test("only allowlisted error codes and a validated cleanup key cross IPC", () => {
  const key = "relay/hypit/setup-test/12345678-1234-4123-8123-123456789abc.txt";
  const error = Object.assign(new Error("OSS 连接测试失败 [SETUP_OSS_FAILED]"), { cleanupObjectKey: key, cause: input });
  assert.deepEqual(serializeFailure(error), { code: "SETUP_OSS_FAILED", message: "OSS 连接测试失败", cleanupObjectKey: key });
  for (const unsafe of [new Error("SECRET_API"), Object.assign(new Error("SECRET [SETUP_OSS_FAILED]"), { cleanupObjectKey: "SECRET_ID" })]) {
    assert.equal(JSON.stringify(serializeFailure(unsafe)).includes("SECRET"), false);
  }
});

test("controller serializes installs and diagnostics and subscriptions remove listeners", async () => {
  const calls: string[] = [];
  const key = "relay/hypit/setup-test/12345678-1234-4123-8123-123456789abc.txt";
  const warned = { ...result, diagnostics: [{ code: "oss" as const, label: "OSS" as const, status: "warning" as const, cleanupObjectKey: key }] };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const controller = createSetupController({ getStatus: async () => warned, commit: async () => { calls.push("commit"); await gate; return warned; }, install: async () => { calls.push("install"); }, diagnose: async () => { calls.push("diagnose"); return []; }, openConfig: async () => {}, clear: async () => result });
  const progress: string[] = [];
  const off = controller.subscribe((value) => { progress.push(JSON.stringify(value)); });
  const first = controller.submit(input);
  const second = controller.rerunDiagnostics();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(calls, ["commit"]);
  release();
  assert.deepEqual(await first, { ok: true, value: warned });
  assert.equal((await second).ok, true);
  assert.deepEqual(calls, ["commit", "install", "diagnose", "diagnose"]);
  assert.equal(progress.some((value) => value.includes("complete")), true);
  assert.equal(progress.some((value) => value.includes("SECRET")), false);
  off();
  const count = progress.length;
  await controller.rerunDiagnostics();
  assert.equal(progress.length, count);
});

test("failed operations release the queue and preserve cleanup warnings", async () => {
  const key = "relay/hypit/setup-test/12345678-1234-4123-8123-123456789abc.txt";
  const controller = createSetupController({ getStatus: async () => result, commit: async () => { throw Object.assign(new Error("OSS 连接测试失败 [SETUP_OSS_FAILED]"), { cleanupObjectKey: key }); }, install: async () => {}, diagnose: async () => [], openConfig: async () => {}, clear: async () => result });
  assert.deepEqual(await controller.submit(input), { ok: false, error: { code: "SETUP_OSS_FAILED", message: "OSS 连接测试失败", cleanupObjectKey: key } });
  assert.equal((await controller.rerunDiagnostics()).ok, true);
});

test("outbound results and diagnostics project only public contract fields", async () => {
  const diagnostic = { code: "newapi", label: "NewAPI", status: "pass", secret: "SECRET_DIAGNOSTIC" } as const;
  const skillDiagnostic = { code: "skill", target: "claude", label: "Claude Code Skill", status: "pass", path: "/claude", secret: "SECRET_SKILL" } as const;
  const unsafeResult = { ...result, apiKey: "SECRET_API", skillTargets: [{ ...result.skillTargets[0]!, extra: "SECRET_TARGET", detectedAgents: ["codex" as const] },
    { id: "claude" as const, label: "Claude Code Skill" as const, path: "/claude", detectedAgents: ["claude-code" as const], secret: "SECRET_CLAUDE" }], diagnostics: [diagnostic, skillDiagnostic] };
  const controller = createSetupController({ getStatus: async () => unsafeResult, commit: async () => unsafeResult, install: async () => {}, diagnose: async () => [diagnostic, skillDiagnostic], openConfig: async () => {}, clear: async () => unsafeResult });
  const sent: unknown[] = [];
  controller.subscribe((item) => sent.push(item));
  sent.push(await controller.getStatus(), await controller.submit(input), await controller.rerunDiagnostics(), await controller.clearConfiguration());
  assert.equal(JSON.stringify(sent).includes("SECRET"), false);
  const status = await controller.getStatus();
  assert.equal(status.ok, true);
  if (status.ok) {
    assert.deepEqual(status.value.skillTargets.map(target => target.id), ["portable", "claude"]);
    assert.deepEqual(status.value.diagnostics.filter(item => item.code === "skill").map(item => item.target), ["claude"]);
    assert.equal("extra" in status.value.skillTargets[0]!, false);
  }
  const invalid = createSetupController({ getStatus: async () => ({ ...result, diagnostics: [{ code: "skill", target: "portable", label: "Claude Code Skill", status: "pass" }] }),
    commit: async () => result, install: async () => {}, diagnose: async () => [], openConfig: async () => {}, clear: async () => result });
  assert.equal((await invalid.getStatus()).ok, false);
});

test("CJS shell boots without import.meta and stages the Windows credential helper", async () => {
  const directory = new URL("../", import.meta.url);
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: directory, stdio: "pipe" });
  const entry = new URL("../dist/main.cjs", import.meta.url);
  const source = await readFile(entry, "utf8");
  const actualRequire = createRequire(entry);
  let quit = false;
  const isolatedProcess = { ...process, exitCode: 0 };
  runInNewContext(source, { require: (name: string) => name === "electron" ? { app: { requestSingleInstanceLock: () => false, quit: () => { quit = true; } } } : actualRequire(name),
    module: { exports: {} }, __dirname: new URL("../dist", import.meta.url).pathname, process: isolatedProcess, URL, Buffer, console });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quit, true);
  assert.equal(isolatedProcess.exitCode, 0);
  const packagedHelper = runInNewContext(`${source}\nwindowsScript;`, { require: (name: string) => name === "electron" ? { app: { requestSingleInstanceLock: () => false, quit() {} } } : actualRequire(name),
    module: { exports: {} }, __dirname: "/Applications/Hypit Setup.app/Contents/Resources/app.asar/dist", process: isolatedProcess, URL, Buffer, console });
  assert.equal(packagedHelper, "/Applications/Hypit Setup.app/Contents/Resources/app.asar.unpacked/dist/credential-store/runtime/windows-credential.ps1");
  assert.ok((await readFile(new URL("../dist/credential-store/runtime/windows-credential.ps1", import.meta.url), "utf8")).includes("param("));
  for (const name of ["main.cjs", "preload.cjs", "renderer.js", "index.html", "styles.css"]) assert.ok((await readFile(new URL(`../dist/${name}`, import.meta.url))).length > 0);

  let exposed: any;
  const callbacks = new Set<(...args: unknown[]) => void>();
  const calls: unknown[][] = [];
  const renderer = { invoke: (...args: unknown[]) => { calls.push(args); return Promise.resolve({ ok: true }); },
    send: (...args: unknown[]) => { calls.push(args); }, on: (_channel: string, callback: (...args: unknown[]) => void) => callbacks.add(callback),
    removeListener: (_channel: string, callback: (...args: unknown[]) => void) => callbacks.delete(callback) };
  runInNewContext(await readFile(new URL("../dist/preload.cjs", import.meta.url), "utf8"), { require: (name: string) => {
    assert.equal(name, "electron"); return { ipcRenderer: renderer, contextBridge: { exposeInMainWorld: (name: string, bridge: unknown) => { assert.equal(name, "hypitSetup"); exposed = bridge; } } };
  } });
  assert.deepEqual(Object.keys(exposed).sort(), ["clearConfiguration", "getStatus", "onProgress", "openConfigDirectory", "removeIntegration", "rerunDiagnostics", "submit"]);
  let received = 0;
  const first = exposed.onProgress(() => { received++; });
  const second = exposed.onProgress(() => { received++; });
  assert.equal(callbacks.size, 1);
  callbacks.values().next().value!({ privileged: true }, { kind: "stage", stage: "validating" });
  assert.equal(received, 2);
  first(); first();
  assert.equal(callbacks.size, 1);
  second();
  assert.equal(callbacks.size, 0);
  assert.deepEqual(calls, [["setup:subscribe"], ["setup:unsubscribe"]]);
});
