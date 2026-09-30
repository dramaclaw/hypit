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
import type { WhisperXProgramService, WhisperXProgramStatus } from "../src/whisperx-program.js";

const whisperXChannels = ["setup:whisperx-status", "setup:whisperx-install", "setup:whisperx-start", "setup:whisperx-stop"];

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
  assert.deepEqual(Object.values(IPC_CHANNELS).sort(), ["setup:clear", "setup:remove-integration", "setup:refresh-agents", "setup:diagnostics", "setup:open-config", "setup:progress", "setup:status", "setup:submit", "setup:subscribe", "setup:unsubscribe", ...whisperXChannels].sort());
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

test("every WhisperX action accepts exactly zero IPC arguments", () => {
  for (const channel of whisperXChannels) {
    assert.equal(validateIpcArguments(channel, []), undefined);
    for (const args of [[undefined], [{ apiKey: input.apiKey }], [input], ["/profile"], ["small", "cpu"]]) {
      assert.throws(() => validateIpcArguments(channel, args), channel);
    }
  }
});

const whisperXLogs = ["/local/program/logs/install.log", "/local/program/logs/service.log"] as const;
const publicWhisperX = { state: "ready", model: "small", device: "cpu", compute: "int8", languages: ["zh", "en"] };
function whisperXController(service: WhisperXProgramService) {
  const forbidden = async () => { throw new Error("SECRET: credential/NewAPI/OSS dependent services must not run"); };
  return createSetupController({ getStatus: forbidden, commit: forbidden, diagnose: forbidden, install: forbidden,
    openConfig: forbidden, clear: forbidden, whisperX: service, whisperXLogs });
}
function whisperXService(value: unknown): WhisperXProgramService {
  const run = async () => value as WhisperXProgramStatus;
  return { status: run, installAndStart: run, start: run, stop: run };
}

test("WhisperX operations project fresh fixed settings without reading credential-bearing extras", async () => {
  const reads = new Map<PropertyKey, number>();
  const status = new Proxy({ state: "ready", stage: "ready", logPath: whisperXLogs[1], code: "WHISPERX_CLEANUP_INCOMPLETE",
    model: { secret: input.apiKey }, languages: new Array(1_000_000), toJSON() { throw new Error("SECRET"); } }, {
    get(target, key, receiver) {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      if (["credentials", "apiKey", "relay", "model", "languages", "toJSON"].includes(String(key))) throw new Error("SECRET_GETTER");
      return Reflect.get(target, key, receiver);
    },
  });
  const controller = whisperXController(whisperXService(status));
  for (const action of [controller.getWhisperXStatus, controller.installWhisperX, controller.startWhisperX, controller.stopWhisperX]) {
    reads.clear();
    const reply = await action();
    assert.deepEqual(reply, { ok: true, value: { ...publicWhisperX, stage: "ready", logPath: whisperXLogs[1], errorCode: "WHISPERX_CLEANUP_INCOMPLETE" } });
    assert.ok([...reads.values()].every(count => count === 1));
    assert.equal(JSON.stringify(structuredClone(reply)).includes("SECRET"), false);
    if (reply.ok) (reply.value.languages as string[])[0] = "SECRET";
  }
});

test("WhisperX states and stages preserve the Managed Program contract", async () => {
  for (const state of ["not-installed", "preparing", "prepared", "stopped", "stopping", "starting", "ready", "mismatch", "failed"]) {
    const reply = await whisperXController(whisperXService({ state })).getWhisperXStatus();
    assert.deepEqual(reply, { ok: true, value: { ...publicWhisperX, state } });
  }
  for (const stage of ["preparing-runtime", "preparing-en", "starting-service", "ready"]) {
    const reply = await whisperXController(whisperXService({ state: "preparing", stage })).getWhisperXStatus();
    assert.deepEqual(reply, { ok: true, value: { ...publicWhisperX, state: "preparing", stage } });
  }
});

test("WhisperX rejects hostile enums and paths and its queue recovers after every malformed result", async () => {
  const revoked = Proxy.revocable({}, {}); revoked.revoke();
  const hostile = new Error("SECRET");
  Object.defineProperty(hostile, "message", { get() { throw revoked.proxy; } });
  for (const value of [revoked.proxy, null, [], { state: ["ready"] }, { state: "SECRET" },
    { state: "ready", stage: ["ready"] }, { state: "ready", stage: "SECRET" },
    { state: "ready", code: ["WHISPERX_COMMAND_FAILED"] }, { state: "ready", code: "SECRET" },
    { state: "ready", logPath: { secret: input.apiKey } }, { state: "ready", logPath: "SECRET" },
    { state: "ready", logPath: "/arbitrary/SECRET.log" }, { state: "ready", logPath: "x".repeat(5000) },
    { get state() { throw hostile; } }]) {
    let calls = 0;
    const controller = whisperXController({ ...whisperXService({ state: "stopped" }), status: async () => ++calls === 1 ? value as WhisperXProgramStatus : { state: "ready" } });
    const invalid = await controller.getWhisperXStatus();
    assert.equal(invalid.ok, false);
    assert.doesNotMatch(JSON.stringify(structuredClone(invalid)), /SECRET/);
    assert.equal((await controller.getWhisperXStatus()).ok, true);
    assert.equal((await controller.stopWhisperX()).ok, true);
  }
});

test("WhisperX projection takes each status getter exactly once", async () => {
  const counts = { state: 0, stage: 0, code: 0, logPath: 0 };
  const reply = await whisperXController(whisperXService({
    get state() { return ++counts.state === 1 ? "ready" : input.apiKey; },
    get stage() { return ++counts.stage === 1 ? "ready" : input.apiKey; },
    get code() { return ++counts.code === 1 ? "WHISPERX_PROFILE_REQUIRED" : input.apiKey; },
    get logPath() { return ++counts.logPath === 1 ? whisperXLogs[1] : input.apiKey; },
  })).getWhisperXStatus();
  assert.deepEqual(counts, { state: 1, stage: 1, code: 1, logPath: 1 });
  assert.equal(reply.ok, true);
  assert.doesNotMatch(JSON.stringify(structuredClone(reply)), /SECRET/);
});

test("WhisperX shares the setup queue, coalesces installs, and outlives removed or failed observers", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let report!: (stage: any) => void;
  let begin!: () => void;
  const begun = new Promise<void>(resolve => { begin = resolve; });
  const controller = createSetupController({
    getStatus: async () => { calls.push("setup-status"); return result; }, commit: async () => result,
    install: async () => {}, diagnose: async () => [], openConfig: async () => {}, clear: async () => { calls.push("clear"); return result; },
    whisperX: {
      installAndStart: async (...args) => { assert.equal(args.length, 1); report = args[0]!; calls.push("install"); begin(); await gate; report("ready"); return { state: "ready" }; },
      status: async (...args) => { assert.equal(args.length, 0); calls.push("status"); return { state: "ready" }; },
      start: async (...args) => { assert.equal(args.length, 1); calls.push("start"); return { state: "ready" }; },
      stop: async (...args) => { assert.equal(args.length, 0); calls.push("stop"); return { state: "stopped" }; },
    }, whisperXLogs,
  });
  const events: unknown[] = [];
  const detach = controller.subscribe(value => events.push(value));
  controller.subscribe(() => { throw new Error("Closed renderer SECRET"); });
  controller.subscribe(async () => { throw new Error("Detached async observer SECRET"); });
  const install = controller.installWhisperX();
  const duplicate = controller.installWhisperX();
  await begun;
  report("preparing-runtime"); report(["ready"]); report("SECRET");
  assert.deepEqual(events, [{ kind: "whisperx-stage", stage: "preparing-runtime" }]);
  detach();
  const queued = [controller.clearConfiguration(), controller.getWhisperXStatus(), controller.startWhisperX(), controller.stopWhisperX(), controller.getStatus()];
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["install"]);
  release();
  const replies = await Promise.all([install, duplicate, ...queued]);
  assert.ok(replies.every(reply => reply.ok));
  assert.deepEqual(calls, ["install", "clear", "status", "start", "stop", "setup-status"]);
  assert.equal(events.length, 1);
  assert.equal((await controller.installWhisperX()).ok, true);
  assert.equal(calls.filter(call => call === "install").length, 2);
});

test("whenIdle snapshots already queued work without being extended by later requests", async () => {
  let releaseFirst!: () => void, releaseSecond!: () => void;
  const firstGate = new Promise<void>(resolve => { releaseFirst = resolve; });
  const secondGate = new Promise<void>(resolve => { releaseSecond = resolve; });
  const controller = whisperXController({ ...whisperXService({ state: "ready" }),
    installAndStart: async () => { await firstGate; return { state: "ready" }; },
    stop: async () => { await secondGate; return { state: "stopped" }; },
  });
  const first = controller.installWhisperX();
  let idle = false, secondDone = false;
  const wait = controller.whenIdle().then(() => { idle = true; });
  const second = controller.stopWhisperX().then(() => { secondDone = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(idle, false);
  releaseFirst();
  await first; await wait;
  assert.equal(idle, true);
  assert.equal(secondDone, false);
  releaseSecond(); await second;
});

test("Agent refresh joins the controller queue and returns projected status plus diagnostics", async () => {
  const calls: string[] = [];
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const controller = createSetupController({
    getStatus: async () => { calls.push("status"); return { ...result, diagnostics: [{ code: "launcher", label: "命令入口", status: "pass" }] }; },
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
  assert.deepEqual(calls, ["commit", "install", "diagnose", "refresh", "status"]);
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

for (const [code, label] of [["profile", "Runtime Profile"], ["launcher", "命令入口"]] as const) {
  test(`${code} recovery warnings retain only the allowlisted reason across IPC`, async () => {
    const warning = { code, label, status: "warning" as const, reason: "CLEANUP_INCOMPLETE" as const, path: "/fixed/recovery" };
    const controller = createSetupController({ getStatus: async () => ({ ...result, diagnostics: [{ ...warning, secret: "SECRET", toJSON: () => ({ secret: "SECRET" }) }] }),
      commit: async () => result, install: async () => {}, diagnose: async () => [], openConfig: async () => {}, clear: async () => result });
    const reply = await controller.getStatus();
    assert.equal(reply.ok, true);
    if (reply.ok) assert.deepEqual(reply.value.diagnostics, [warning]);
    assert.doesNotMatch(JSON.stringify(reply), /SECRET/);
  });
}

test("Agent rescan uses local status diagnostics and never calls credential or network-dependent services", async () => {
  const calls: string[] = [];
  const local = { code: "skill" as const, label: "Claude Code Skill" as const, target: "claude" as const,
    status: "pass" as const, path: "/claude/skill" };
  const cleanup = { code: "skill" as const, label: "通用 Agent Skill" as const, target: "portable" as const,
    status: "warning" as const, reason: "CLEANUP_INCOMPLETE" as const, path: "/fixed/recovery" };
  const forbidden = async () => { calls.push("credential-dependent"); throw new Error("Credential/network services must not run"); };
  const controller = createSetupController({ getStatus: async () => { calls.push("local-status"); return { ...result, diagnostics: [local, cleanup] }; },
    refreshAgents: async () => { calls.push("refresh"); return { diagnostics: [cleanup] }; },
    commit: forbidden, install: forbidden, diagnose: forbidden, clear: forbidden, openConfig: forbidden });
  const reply = await controller.refreshAgentIntegration();
  assert.equal(reply.ok, true);
  assert.deepEqual(calls, ["refresh", "local-status"]);
  if (reply.ok) assert.deepEqual(reply.value.diagnostics, [local, cleanup]);
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
  assert.deepEqual(Object.keys(exposed).sort(), ["clearConfiguration", "getStatus", "getWhisperXStatus", "installWhisperX", "onProgress", "openConfigDirectory", "refreshAgentIntegration", "removeIntegration", "rerunDiagnostics", "startWhisperX", "stopWhisperX", "submit"]);
  for (const name of ["getWhisperXStatus", "installWhisperX", "startWhisperX", "stopWhisperX"]) await exposed[name](input);
  assert.deepEqual(calls, whisperXChannels.map(channel => [channel]));
  calls.length = 0;
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

for (const platform of ["darwin", "win32"] as const) test(`packaged ${platform} WhisperX IPC verifies sender, uses no credentials, and survives window closure`, async () => {
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: new URL("../", import.meta.url), stdio: "pipe" });
  const entry = new URL("../dist/main.cjs", import.meta.url);
  const actualRequire = createRequire(entry);
  const handlers = new Map<string, (...args: any[]) => Promise<any>>();
  const subscriptions = new Map<string, (...args: any[]) => void>();
  const calls: string[] = [];
  const options: unknown[] = [];
  const appEvents = new Map<string, () => void>();
  let quits = 0, windows = 0;
  let gate: Promise<void> | undefined;
  let startGate: Promise<void> | undefined;
  let currentWindow: FakeWindow;
  class FakeWindow {
    webContents = { mainFrame: { url: "" }, on() {}, setWindowOpenHandler() {}, isDestroyed: () => false, send() {},
      session: { setPermissionRequestHandler() {}, setPermissionCheckHandler() {} } };
    events = new Map<string, () => void>();
    constructor() { currentWindow = this; windows++; }
    on(name: string, listener: () => void) { this.events.set(name, listener); }
    isDestroyed() { return false; }
    show() {} focus() {}
    async loadURL(url: string) { this.webContents.mainFrame.url = url; }
  }
  const service = Object.fromEntries(["status", "installAndStart", "start", "stop"].map(name => [name, async (...args: unknown[]) => {
    calls.push(name); assert.equal(args.length, name === "status" || name === "stop" ? 0 : 1);
    if (name === "installAndStart") await gate;
    if (name === "start") await startGate;
    return { state: "ready" };
  }]));
  const sandbox: any = { require: (name: string) => name === "electron" ? {
    app: { requestSingleInstanceLock: () => true, whenReady: async () => {}, getPath: () => "/local/home", getVersion: () => "1.0", on: (name: string, fn: () => void) => appEvents.set(name, fn), quit() { quits++; } },
    BrowserWindow: FakeWindow, ipcMain: { handle: (channel: string, handler: any) => handlers.set(channel, handler), on: (channel: string, handler: any) => subscriptions.set(channel, handler) },
  } : actualRequire(name), module: { exports: {}, paths: [] }, __dirname: "/bundle", URL, Buffer, console,
    process: { ...process, platform, resourcesPath: "/resources" }, fixture: result, service,
    recordOptions: (value: unknown) => options.push(value) };
  const source = (await readFile(entry, "utf8")).replace("startElectronShell(__dirname).catch", `
    scanAgentTargets = async () => ({ targets: [], detectedAgents: [] });
    refreshDesktopStatus = async () => fixture;
    createDesktopStatusLifecycle = () => ({ integration: {}, getStatus: async () => fixture, profileCommitted() {}, refreshAgents: async () => {} });
    createWhisperXProgramService = (options) => { recordOptions(options); return service; };
    globalThis.boot = startElectronShell(__dirname).catch`);
  runInNewContext(source, sandbox);
  await sandbox.boot;
  const contents = currentWindow!.webContents;
  const trusted = { sender: contents, senderFrame: contents.mainFrame };
  for (const channel of whisperXChannels) {
    const handler = handlers.get(channel);
    assert.equal(typeof handler, "function", channel);
    for (const event of [{ ...trusted, sender: {} }, { ...trusted, senderFrame: { ...contents.mainFrame } }]) assert.equal((await handler!(event)).ok, false);
    assert.equal((await handler!(trusted, input)).ok, false);
  }
  assert.deepEqual(calls, []);
  for (const channel of whisperXChannels) assert.equal((await handlers.get(channel)!(trusted)).ok, true);
  assert.deepEqual(calls, ["status", "installAndStart", "start", "stop"]);
  assert.equal(options.length, 1);
  const captured = options[0] as Record<string, unknown>;
  assert.deepEqual(Object.keys(captured).sort(), ["bundledBin", "bundledUv", "cliEntry", "electronExecutable", "paths", "platform"]);
  assert.equal(captured.bundledUv, platform === "win32" ? "/resources/bin/uv.exe" : "/resources/bin/uv");
  assert.deepEqual(Object.keys(captured.paths as object).sort(), ["hostState", "profile"]);
  assert.doesNotMatch(JSON.stringify(options), /SECRET/);
  for (const reopen of [true, false]) {
    let release!: () => void;
    let releaseStart!: () => void;
    let queuedStart: Promise<any> | undefined;
    gate = new Promise<void>(resolve => { release = resolve; });
    const contents = currentWindow!.webContents;
    const install = handlers.get("setup:whisperx-install")!({ sender: contents, senderFrame: contents.mainFrame });
    await new Promise(resolve => setImmediate(resolve));
    currentWindow!.events.get("closed")!();
    appEvents.get("window-all-closed")!();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(quits, 0, "closing an observer must not quit during preparation");
    if (reopen) {
      appEvents.get("second-instance")!();
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(windows, 2, "second launch reattaches to the retained main-process service");
      assert.equal(options.length, 1);
      startGate = new Promise<void>(resolve => { releaseStart = resolve; });
      const reopenedContents = currentWindow!.webContents;
      queuedStart = handlers.get("setup:whisperx-start")!({ sender: reopenedContents, senderFrame: reopenedContents.mainFrame });
      currentWindow!.events.get("closed")!();
      appEvents.get("window-all-closed")!();
    }
    release();
    assert.equal((await install).ok, true);
    await new Promise(resolve => setImmediate(resolve));
    if (reopen) {
      assert.equal(quits, 0, "a stale close wait must not quit work queued by a reopened window");
      releaseStart();
      assert.equal((await queuedStart!).ok, true);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(quits, platform === "win32" ? 1 : 0);
      // Simulate macOS activation / another Windows launch for the independent final-close case.
      appEvents.get("activate")!();
      await new Promise(resolve => setImmediate(resolve));
      quits = 0;
    } else assert.equal(quits, platform === "win32" ? 1 : 0);
  }
});
