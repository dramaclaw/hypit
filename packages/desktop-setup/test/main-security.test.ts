import assert from "node:assert/strict";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { execFileSync } from "node:child_process";
import { browserWindowOptions, createSetupController, isTrustedSender, localPageUrl, serializeFailure, validateIpcArguments, hardenWebContents, rescanIntegrationTargets } from "../src/main.js";
import { IPC_CHANNELS } from "../src/ipc.js";
import { desktopPaths } from "../src/paths.js";
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
  assert.deepEqual(Object.values(IPC_CHANNELS).sort(), ["setup:clear", "setup:remove-integration", "setup:refresh-agents", "setup:diagnostics", "setup:open-config", "setup:progress", "setup:status", "setup:submit", "setup:subscribe", "setup:unsubscribe"].sort());
  assert.deepEqual(validateIpcArguments("setup:submit", [input]), input);
  for (const invalid of [{ ...input, extra: true }, { ...input, apiKey: "" }, { ...input, relay: { ...input.relay, extra: true } }, { ...input, relay: { enabled: false } }, { ...input, baseUrl: "https://key:secret@api.example" }, { ...input, baseUrl: "https://api.example?apiKey=secret" }]) {
    assert.throws(() => validateIpcArguments("setup:submit", [invalid]));
  }
  for (const channel of ["setup:status", "setup:diagnostics", "setup:open-config", "setup:clear", "setup:remove-integration", "setup:refresh-agents", "setup:subscribe", "setup:unsubscribe"] as const) {
    assert.equal(validateIpcArguments(channel, []), undefined);
    assert.throws(() => validateIpcArguments(channel, ["/arbitrary/path"]));
  }
  assert.equal(validateIpcArguments(IPC_CHANNELS.refreshAgents, []), undefined);
  assert.throws(() => validateIpcArguments(IPC_CHANNELS.refreshAgents, [{ apiKey: "SECRET" }]));
  assert.throws(() => validateIpcArguments("arbitrary", []));
});

test("Agent refresh joins the controller queue and returns projected status plus diagnostics", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = createSetupController({
    getStatus: async () => { calls.push("status"); return result; },
    commit: async () => { calls.push("commit"); await gate; return result; },
    install: async () => { calls.push("install"); },
    refreshAgents: async () => { calls.push("refresh"); },
    diagnose: async () => { calls.push("diagnose"); return [{ code: "launcher", label: "命令入口", status: "pass" }]; },
    openConfig: async () => {}, clear: async () => result,
  });
  const progress: string[] = [];
  controller.subscribe(value => { if (value.kind === "stage") progress.push(value.stage); });
  const submit = controller.submit(input);
  const refresh = controller.refreshAgentIntegration();
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["commit"]);
  release();
  await submit;
  assert.deepEqual(await refresh, { ok: true, value: { ...result, diagnostics: [{ code: "launcher", label: "命令入口", status: "pass" }] } });
  assert.deepEqual(calls, ["commit", "install", "diagnose", "refresh", "status", "diagnose"]);
  assert.deepEqual(progress.slice(-2), ["installing-skill", "diagnosing"]);
});

test("rescan retains a still-managed Claude target after Claude is no longer detected", async () => {
  const paths = desktopPaths({ platform: "darwin", home: "/tmp/agent-home", appData: "/tmp/agent-data" });
  const targets = await rescanIntegrationTargets(paths,
    async () => ({ detectedAgents: ["codex"], targets: [{ id: "portable", label: "通用 Agent Skill", skillDirectory: paths.portableSkill,
      backupDirectory: paths.portableSkillBackup, required: true, detectedAgents: ["codex"] }] }),
    async target => target.id === "claude");
  assert.deepEqual(targets.map(target => target.id), ["portable", "claude"]);
  assert.deepEqual(targets[1]?.detectedAgents, []);
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

test("committed integration warnings survive submit and refresh through the safe diagnostic projection", async () => {
  const warning = { code: "skill" as const, target: "portable" as const, label: "通用 Agent Skill" as const,
    status: "warning" as const, reason: "CLEANUP_INCOMPLETE" as const, path: "/fixed/recovery" };
  const unsafe = { ...warning, secret: "SECRET", toJSON: () => ({ secret: "SECRET" }) };
  const controller = createSetupController({ getStatus: async () => result, commit: async () => result,
    install: async () => ({ diagnostics: [unsafe] }), refreshAgents: async () => ({ diagnostics: [unsafe] }),
    diagnose: async () => [], openConfig: async () => {}, clear: async () => result });
  for (const reply of [await controller.submit(input), await controller.refreshAgentIntegration()]) {
    assert.equal(reply.ok, true);
    if (reply.ok) {
      assert.equal(reply.value.configured, true);
      assert.deepEqual(reply.value.diagnostics, [warning]);
      assert.doesNotMatch(JSON.stringify(reply), /SECRET/);
    }
  }
});

test("failure serialization is total for hostile getters, revoked proxies, and primitive throws", () => {
  const fallback = { code: "SETUP_REQUEST_FAILED", message: "操作失败，请检查配置后重试" };
  const oss = new Error("SECRET_API [SETUP_OSS_FAILED]");
  Object.defineProperties(oss, {
    code: { get() { throw new Error("SECRET_CODE"); } },
    cleanupObjectKey: { get() { throw new Error("SECRET_CLEANUP"); } },
  });
  assert.deepEqual(serializeFailure(oss), { code: "SETUP_OSS_FAILED", message: "OSS 连接测试失败" });
  const hostileMessage = new Error("initial");
  Object.defineProperties(hostileMessage, {
    message: { get() { throw new Error("SECRET_MESSAGE"); } },
    cleanupObjectKey: { get() { throw new Error("SECRET_CLEANUP"); } },
  });
  const nonstringMessage = new Error("initial");
  Object.defineProperty(nonstringMessage, "message", { get() { return { toString() { throw new Error("SECRET_COERCION"); } }; } });
  const revokedError = Proxy.revocable(new Error("SECRET_REVOKED [SETUP_OSS_FAILED]"), {});
  revokedError.revoke();
  const revokedObject = Proxy.revocable({ cleanupObjectKey: "SECRET_REVOKED" }, {});
  revokedObject.revoke();
  for (const thrown of [hostileMessage, nonstringMessage, revokedError.proxy, revokedObject.proxy, Symbol("SECRET_SYMBOL"), 42n]) {
    const publicError = serializeFailure(thrown);
    assert.deepEqual(publicError, fallback);
    assert.deepEqual(structuredClone(publicError), fallback);
    assert.equal(JSON.stringify(publicError).includes("SECRET"), false);
  }
});

test("a hostile getter failure does not poison later controller requests", async () => {
  let statusCalls = 0, commits = 0, diagnoses = 0, clears = 0, removals = 0;
  const hostile = new Error("SECRET_API [SETUP_OSS_FAILED]");
  Object.defineProperty(hostile, "cleanupObjectKey", { get() { throw new Error("SECRET_CLEANUP"); } });
  const controller = createSetupController({
    getStatus: async () => {
      statusCalls++;
      return statusCalls === 1 ? { ...result, get profilePath(): string { throw hostile; } } : result;
    },
    commit: async () => { commits++; return result; }, install: async () => {},
    diagnose: async () => { diagnoses++; return []; }, openConfig: async () => {},
    clear: async () => { clears++; return result; }, removeIntegration: async () => { removals++; return result; },
  });
  const first = await controller.getStatus();
  assert.deepEqual(first, { ok: false, error: { code: "SETUP_OSS_FAILED", message: "OSS 连接测试失败" } });
  const replies = [first, await controller.getStatus(), await controller.submit(input), await controller.rerunDiagnostics(),
    await controller.clearConfiguration(), await controller.removeIntegration()];
  assert.deepEqual(replies.slice(1).map(reply => reply.ok), [true, true, true, true, true]);
  assert.deepEqual([statusCalls, commits, diagnoses, clears, removals], [3, 1, 2, 1, 1]);
  for (const reply of replies) {
    const cloned = structuredClone(reply);
    assert.equal(JSON.stringify(cloned).includes("SECRET"), false);
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

test("controller rejects array-shaped enum values and object paths before IPC cloning", async () => {
  const disguised = (value: string, secret: string) => Object.assign([value], { secret });
  const cases: readonly [string, SetupResult][] = [
    ["target id", { ...result, skillTargets: [{ ...result.skillTargets[0]!, id: disguised("portable", input.baseUrl) }] } as unknown as SetupResult],
    ["skill diagnostic target", { ...result, diagnostics: [{ code: "skill", target: disguised("portable", input.apiKey), label: "通用 Agent Skill", status: "pass" }] } as unknown as SetupResult],
    ["diagnostic code", { ...result, diagnostics: [{ code: disguised("newapi", input.relay.endpoint), label: "NewAPI", status: "pass" }] } as unknown as SetupResult],
    ["profile path", { ...result, profilePath: { secret: input.relay.bucket } } as unknown as SetupResult],
    ["launcher path", { ...result, launcherPath: { secret: input.relay.accessKeyId } } as unknown as SetupResult],
    ["target label", { ...result, skillTargets: [{ ...result.skillTargets[0]!, label: disguised("通用 Agent Skill", input.relay.accessKeySecret) }] } as unknown as SetupResult],
    ["detected Agent", { ...result, skillTargets: [{ ...result.skillTargets[0]!, detectedAgents: [disguised("codex", input.apiKey)] }] } as unknown as SetupResult],
    ["target path", { ...result, skillTargets: [{ ...result.skillTargets[0]!, path: { secret: input.apiKey } }] } as unknown as SetupResult],
    ["diagnostic path", { ...result, diagnostics: [{ code: "newapi", label: "NewAPI", status: "pass", path: { secret: input.apiKey } }] } as unknown as SetupResult],
    ["diagnostic status", { ...result, diagnostics: [{ code: "newapi", label: "NewAPI", status: disguised("pass", input.apiKey) }] } as unknown as SetupResult],
  ];
  for (const [name, unsafe] of cases) {
    const controller = createSetupController({ getStatus: async () => unsafe, commit: async () => unsafe, install: async () => {},
      diagnose: async () => unsafe.diagnostics, openConfig: async () => {}, clear: async () => unsafe });
    const reply = await controller.getStatus();
    assert.equal(reply.ok, false, name);
    const cloned = structuredClone(reply);
    for (const secret of [input.baseUrl, input.apiKey, input.relay.endpoint, input.relay.bucket, input.relay.accessKeyId, input.relay.accessKeySecret]) {
      assert.equal(JSON.stringify(cloned).includes(secret), false, name);
    }
  }
});

test("IPC projection snapshots changing getters once and never returns later secret values", async () => {
  let idReads = 0, pathReads = 0, statusReads = 0, profileReads = 0;
  const target = { ...result.skillTargets[0]!,
    get id() { idReads++; return idReads <= 3 ? "portable" : { secret: input.apiKey }; },
    get path() { pathReads++; return pathReads === 1 ? "/skill" : { secret: input.relay.accessKeyId }; },
  };
  const diagnostic = { code: "newapi", label: "NewAPI",
    get status() { statusReads++; return statusReads === 1 ? "pass" : { secret: input.relay.accessKeySecret }; },
    get message() { throw new Error("SECRET_UNREAD_MESSAGE"); },
    hint: { secret: input.relay.bucket },
  };
  const unsafe = { ...result, skillTargets: [target], diagnostics: [diagnostic],
    get profilePath() { profileReads++; return profileReads === 1 ? "/profile" : { secret: input.baseUrl }; } } as unknown as SetupResult;
  const controller = createSetupController({ getStatus: async () => unsafe, commit: async () => result, install: async () => {},
    diagnose: async () => [], openConfig: async () => {}, clear: async () => result });
  const reply = await controller.getStatus();
  assert.equal(reply.ok, true);
  assert.deepEqual([idReads, pathReads, statusReads, profileReads], [1, 1, 1, 1]);
  const cloned = structuredClone(reply);
  assert.equal(JSON.stringify(cloned).includes("secret"), false);
  for (const secret of [input.baseUrl, input.apiKey, input.relay.bucket, input.relay.accessKeyId, input.relay.accessKeySecret]) {
    assert.equal(JSON.stringify(cloned).includes(secret), false);
  }
});

test("IPC projection ignores input-owned array methods and iterators on every successful response", async () => {
  const poison = <T>(array: T[]): T[] => {
    Object.defineProperties(array, {
      map: { value() { throw new Error("SECRET_MAP"); } },
      some: { value() { throw new Error("SECRET_SOME"); } },
      [Symbol.iterator]: { value() { throw new Error("SECRET_ITERATOR"); } },
      secret: { value: input.apiKey, enumerable: true },
    });
    return array;
  };
  const agents = poison(["codex" as const]);
  const target = { ...result.skillTargets[0]!, detectedAgents: agents };
  const diagnostic = { code: "skill" as const, target: "portable" as const, label: "通用 Agent Skill" as const, status: "pass" as const,
    message: { secret: input.relay.endpoint }, hint: { secret: input.relay.bucket } };
  const unsafe = { ...result, skillTargets: poison([target]), diagnostics: poison([diagnostic]) };
  const diagnoses = poison([diagnostic]);
  const controller = createSetupController({ getStatus: async () => unsafe, commit: async () => unsafe, install: async () => {},
    diagnose: async () => diagnoses, openConfig: async () => {}, clear: async () => unsafe });
  const progress: unknown[] = [];
  controller.subscribe(item => progress.push(item));
  const responses = [await controller.getStatus(), await controller.submit(input), await controller.rerunDiagnostics(), await controller.clearConfiguration()];
  for (const reply of responses) {
    assert.equal(reply.ok, true);
    const cloned = structuredClone(reply);
    assert.equal(JSON.stringify(cloned).includes("SECRET"), false);
    for (const secret of [input.baseUrl, input.apiKey, input.relay.endpoint, input.relay.bucket, input.relay.accessKeyId, input.relay.accessKeySecret]) {
      assert.equal(JSON.stringify(cloned).includes(secret), false);
    }
  }
  assert.equal(JSON.stringify(structuredClone(progress)).includes("SECRET"), false);
});

test("IPC projection rejects sparse and excessive result arrays", async () => {
  const cases = [
    { ...result, skillTargets: new Array(1) },
    { ...result, diagnostics: new Array(1) },
    { ...result, skillTargets: new Array(3) },
    { ...result, diagnostics: new Array(65) },
  ] as SetupResult[];
  for (const unsafe of cases) {
    const controller = createSetupController({ getStatus: async () => unsafe, commit: async () => unsafe, install: async () => {},
      diagnose: async () => [], openConfig: async () => {}, clear: async () => unsafe });
    const reply = await controller.getStatus();
    assert.equal(reply.ok, false);
    assert.equal(JSON.stringify(structuredClone(reply)).includes("SECRET"), false);
  }
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
  assert.deepEqual(Object.keys(exposed).sort(), ["clearConfiguration", "getStatus", "onProgress", "openConfigDirectory", "refreshAgentIntegration", "removeIntegration", "rerunDiagnostics", "submit"]);
  await exposed.refreshAgentIntegration();
  assert.deepEqual(calls, [["setup:refresh-agents"]]);
  calls.length = 0;
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
