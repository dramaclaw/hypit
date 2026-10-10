import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import fs, { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createDesktopProfile } from "../src/profile.js";
import { desktopPaths, whisperXProgramPaths } from "../src/paths.js";
import { createWhisperXProgramService } from "../src/whisperx-program.js";
import type { WhisperXProgramOptions, WhisperXProgressStage } from "../src/whisperx-program.js";
import uvLock from "../uv-lock.json" with { type: "json" };
import { executable } from "./resource-fixtures.js";

// Actual child processes exercise argv, environment, output limits and lifetime.
const fakeCli = `
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const root = process.env.HYPIT_STATE_HOME;
const control = JSON.parse(await readFile(join(root, 'fixture.json'), 'utf8'));
const action = process.argv[3];
const profilePath = process.argv[5];
const profile = JSON.parse(await readFile(profilePath, 'utf8'));
const published = JSON.parse(await readFile(join(root, 'profiles', 'desktop-newapi.json'), 'utf8')).bindings['@hypit/whisperx@1#whisperx-alignment'];
await appendFile(join(root, 'calls.jsonl'), JSON.stringify({ args: process.argv.slice(1), env: process.env, profile, profilePath, pid: process.pid, published }) + '\\n');
let state = await readFile(join(root, 'fake-state'), 'utf8').catch(() => 'down');
if (control.delay && action === (control.delayAction || 'prepare')) await new Promise(resolve => setTimeout(resolve, control.delay));
if (control.noise === action) process[control.stream || 'stdout'].write('SECRET'.repeat(30000));
if (control.hang === action) {
  if (control.descendant) {
    const { spawn } = await import('node:child_process');
    const descendant = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    await writeFile(join(root, 'descendant.pid'), String(descendant.pid));
  }
  await new Promise(() => setInterval(() => {}, 1000));
}
if (control.fail === action) { console.error('SECRET download failed'); process.exit(3); }
if (control.cliError === action) { console.log(JSON.stringify({ error: 'SECRET host preparation failed' })); process.exit(1); }
if (action === 'prepare') await writeFile(join(root, 'cache'), JSON.stringify(profile.endpoints['whisperx.local'].config.alignmentLanguages));
if (action === 'up') { state = control.upState || 'ready'; await writeFile(join(root, 'fake-state'), state); }
if (action === 'down') { state = 'down'; await writeFile(join(root, 'fake-state'), state); }
const ready = action === 'prepare' || state === 'ready';
const ok = action === 'status' || action === 'down' || ready;
const record = { id: 'whisperx.local', endpoint: 'whisperx.local', state, detail: 'SECRET', stateDetail: 'SECRET', logPath: '/SECRET/log', ...(control.pid ? { pid: control.pid } : {}) };
const programs = (action === 'status' || !ok) ? [record] : [];
console.log(control.invalid ? 'SECRET invalid JSON' : JSON.stringify({ format: 'hypit.cli-programs@1', action, ok, ready, programCount: 1, readyCount: ready ? 1 : 0, programs, ...(programs.length ? {} : { omittedPrograms: 1 }), ...control.reportPatch, ...control.actionPatches?.[action] }));
if (control.nonzero === action) process.exitCode = 1;
`;

async function fixture(t: TestContext, control: Record<string, unknown> = {}, platform: "darwin" | "win32" = "darwin") {
  const root = await mkdtemp(join(tmpdir(), "hypit-whisperx-program-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home: root, appData: root });
  const bundledBin = join(root, "resources", "bin");
  const bundledUv = join(bundledBin, platform === "darwin" ? "uv" : "uv.exe");
  const cliEntry = join(root, "resources", "hypit.mjs");
  await mkdir(dirname(paths.profile), { recursive: true });
  await mkdir(bundledBin, { recursive: true });
  const uvBytes = executable(platform);
  const expected = uvLock.targets[platform === "darwin" ? "darwin-arm64" : "win32-x64"];
  const original = { ...expected };
  Object.assign(expected, { sha256: createHash("sha256").update(uvBytes).digest("hex"), bytes: uvBytes.length });
  t.after(() => Object.assign(expected, original));
  await writeFile(bundledUv, uvBytes, { mode: 0o755 });
  await writeFile(join(root, "resources", "resource-manifest.json"), JSON.stringify({ schemaVersion: 1, platform, arch: platform === "darwin" ? "arm64" : "x64",
    uv: { name: uvLock.name, version: uvLock.version, sha256: expected.sha256, bytes: expected.bytes }, files: { [platform === "darwin" ? "bin/uv" : "bin/uv.exe"]: { sha256: expected.sha256, bytes: expected.bytes } } }));
  const originalExec = childProcess.execFile;
  const uvVersion = t.mock.method(childProcess, "execFile", ((...args: any[]) => {
    if (args[0] === bundledUv) { args.at(-1)(null, "uv 0.12.20 (fixture)", ""); return; }
    return (originalExec as any)(...args);
  }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  t.after(() => { uvVersion.mock.restore(); syncBuiltinESMExports(); });
  await writeFile(cliEntry, fakeCli);
  // This legacy service is exercised against a pre-NewAPI-alignment Profile.
  const legacyProfile = createDesktopProfile({ baseUrl: "https://example.test/v1" }) as any;
  delete legacyProfile.bindings["@hypit/whisperx@1#whisperx-alignment"];
  const bytes = Buffer.from(JSON.stringify(legacyProfile));
  await writeFile(paths.profile, bytes);
  const configure = (value: Record<string, unknown>) => writeFile(join(paths.hostState, "fixture.json"), JSON.stringify(value));
  await configure(control);
  const calls = async (): Promise<any[]> => (await readFile(join(paths.hostState, "calls.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const options: WhisperXProgramOptions = { paths, platform, electronExecutable: process.execPath, cliEntry, bundledBin, bundledUv,
    env: { PATH: "/inherited/bin", HOME: root, UV: "SECRET", NODE_OPTIONS: "SECRET", API_KEY: "SECRET" }, timeoutMs: 5000 };
  return { ...options, root, bytes, configure, calls, options, service: createWhisperXProgramService(options) };
}

test("two candidate passes use the bundled CLI and publish only after a ready status", async (t) => {
  const f = await fixture(t);
  const stages: WhisperXProgressStage[] = [];
  const result = await f.service.installAndStart(stage => { stages.push(stage); });
  assert.equal(result.state, "ready");
  assert.deepEqual(stages, ["preparing-runtime", "preparing-en", "starting-service", "ready"]);
  const calls = await f.calls();
  assert.deepEqual(calls.map(call => call.args[2]), ["prepare", "prepare", "up", "status"]);
  for (const call of calls) {
    assert.equal(call.published, undefined);
    assert.deepEqual(call.args, [f.cliEntry, "programs", call.args[2], "--runtime", call.profilePath, "--endpoint", "whisperx.local", "--json"]);
    assert.equal(call.env.PATH?.split(delimiter)[0], dirname(f.bundledUv));
    assert.equal(call.env.PATH, `${f.bundledBin}${delimiter}/inherited/bin`);
    assert.equal(call.env.UV, undefined);
    assert.equal(call.env.NODE_OPTIONS, undefined);
    assert.equal(call.env.API_KEY, undefined);
    assert.equal(call.env.HYPIT_STATE_HOME, f.paths.hostState);
    assert.equal(call.env.ELECTRON_RUN_AS_NODE, "1");
    assert.equal(dirname(call.profilePath), dirname(f.paths.profile));
  }
  assert.notEqual(calls[0].profilePath, calls[1].profilePath);
  assert.deepEqual(calls[0].profile.endpoints["whisperx.local"].config.alignmentLanguages, ["zh"]);
  assert.deepEqual(calls.slice(1).map(call => call.profile.endpoints["whisperx.local"].config.alignmentLanguages), [["zh", "en"], ["zh", "en"], ["zh", "en"]]);
  assert.equal(JSON.parse(await readFile(f.paths.profile, "utf8")).bindings["@hypit/whisperx@1#whisperx-alignment"], "whisperx.local");
  assert.deepEqual(await readdir(dirname(f.paths.profile)), ["desktop-newapi.json"]);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
});

test("duplicate installs share a promise, and aborting or losing observers does not kill preparation", async (t) => {
  const f = await fixture(t, { delay: 100 });
  const controller = new AbortController();
  const events: string[] = [];
  const first = f.service.installAndStart(stage => { events.push(stage); controller.abort(); }, controller.signal);
  const second = f.service.installAndStart(() => { throw new Error("Renderer has closed"); });
  assert.equal(first, second);
  assert.equal((await f.service.status()).state, "preparing");
  assert.equal((await first).state, "ready");
  assert.deepEqual(events, ["preparing-runtime"]);
  assert.equal((await f.calls()).filter(call => call.args[2] === "prepare").length, 2);
});

test("status distinguishes fresh, prepared, stopped, starting, ready and mismatch after recreation", async (t) => {
  const f = await fixture(t, { fail: "up" });
  assert.equal((await f.service.status()).state, "not-installed");
  assert.equal((await f.service.installAndStart()).code, "WHISPERX_COMMAND_FAILED");
  assert.deepEqual(await readFile(f.paths.profile), f.bytes);
  assert.equal((await createWhisperXProgramService(f.options).status()).state, "prepared");
  await f.configure({});
  const restarted = createWhisperXProgramService(f.options);
  assert.equal((await restarted.start()).state, "ready");
  assert.equal((await restarted.stop()).state, "stopped");
  assert.equal((await createWhisperXProgramService(f.options).status()).state, "stopped");
  await f.configure({ pid: process.pid });
  assert.equal((await restarted.status()).state, "starting");
  await writeFile(join(f.paths.hostState, "fake-state"), "mismatch");
  assert.equal((await restarted.status()).state, "mismatch");
  await writeFile(join(f.paths.hostState, "fake-state"), "ready");
  assert.equal((await restarted.status()).state, "ready");
  assert.equal((await f.calls()).filter(call => call.args[2] === "prepare").length, 2);
});

test("failed preparation retains caches and original Profile, and returns fixed errors only", async (t) => {
  const f = await fixture(t);
  const result = await f.service.installAndStart(stage => {
    if (stage === "preparing-en") writeFileSync(join(f.paths.hostState, "fixture.json"), JSON.stringify({ fail: "prepare" }));
  });
  assert.equal(result.state, "failed");
  assert.equal(result.code, "WHISPERX_COMMAND_FAILED");
  assert.equal(result.stage, "preparing-en");
  assert.equal(await readFile(join(f.paths.hostState, "cache"), "utf8"), '["zh"]');
  assert.deepEqual(await readFile(f.paths.profile), f.bytes);
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  assert.deepEqual(await readdir(dirname(f.paths.profile)), ["desktop-newapi.json"]);
  await f.configure({});
  assert.equal((await f.service.installAndStart()).state, "ready");
});

test("Profile publication failure retains ready resources and preserves a concurrent edit", async (t) => {
  const f = await fixture(t);
  const userBytes = `${f.bytes.toString()}\n `;
  const result = await f.service.installAndStart(stage => {
    if (stage === "starting-service") writeFileSync(f.paths.profile, userBytes);
  });
  assert.equal(result.state, "failed");
  assert.equal(result.code, "WHISPERX_PROFILE_COMMIT_FAILED");
  assert.equal(result.stage, "starting-service");
  assert.equal(await readFile(f.paths.profile, "utf8"), userBytes);
  assert.equal(await readFile(join(f.paths.hostState, "fake-state"), "utf8"), "ready");
  assert.equal(await readFile(join(f.paths.hostState, "cache"), "utf8"), '["zh","en"]');
  assert.equal((await f.service.installAndStart()).state, "ready");
});

for (const retry of ["start", "installAndStart"] as const) {
  test(`fresh status after Profile commit failure remains unactivated until ${retry} publishes`, async (t) => {
    const f = await fixture(t);
    const userBytes = `${f.bytes.toString()}\n `;
    const failed = await f.service.installAndStart(stage => {
      if (stage === "starting-service") writeFileSync(f.paths.profile, userBytes);
    });
    assert.equal(failed.code, "WHISPERX_PROFILE_COMMIT_FAILED");
    const reopened = createWhisperXProgramService(f.options);
    const unactivated = await reopened.status();
    assert.equal(unactivated.state, "prepared");
    assert.equal(unactivated.code, "WHISPERX_PROFILE_REQUIRED");
    assert.equal(await readFile(f.paths.profile, "utf8"), userBytes);
    assert.equal(await readFile(join(f.paths.hostState, "fake-state"), "utf8"), "ready");
    assert.equal((await reopened[retry]()).state, "ready");
    assert.equal((await createWhisperXProgramService(f.options).status()).state, "ready");
  });
}

for (const change of ["missing-endpoint", "missing-binding", "conflicting-endpoint", "conflicting-binding", "missing-profile"] as const) {
  test(`a healthy service cannot report ready with ${change}`, async (t) => {
    const f = await fixture(t);
    await f.service.installAndStart();
    const document = JSON.parse(await readFile(f.paths.profile, "utf8"));
    if (change === "missing-endpoint") delete document.endpoints["whisperx.local"];
    if (change === "missing-binding") delete document.bindings["@hypit/whisperx@1#whisperx-alignment"];
    if (change === "conflicting-endpoint") document.endpoints["whisperx.local"].config.expectedModel = "large-v3";
    if (change === "conflicting-binding") document.bindings["@hypit/whisperx@1#whisperx-alignment"] = "custom";
    const bytes = JSON.stringify(document);
    if (change === "missing-profile") await rm(f.paths.profile);
    else await writeFile(f.paths.profile, bytes);
    const status = await createWhisperXProgramService(f.options).status();
    const conflict = change.startsWith("conflicting");
    assert.equal(status.state, conflict || change === "missing-profile" ? "mismatch" : "prepared");
    assert.equal(status.code, conflict ? "WHISPERX_PROFILE_CONFLICT" : "WHISPERX_PROFILE_REQUIRED");
    assert.equal(await readFile(join(f.paths.hostState, "fake-state"), "utf8"), "ready");
    if (change !== "missing-profile") assert.equal(await readFile(f.paths.profile, "utf8"), bytes);
  });
}

for (const upState of ["down", "mismatch"]) {
  test(`a ${upState} service never publishes the candidate`, async (t) => {
    const f = await fixture(t, { upState, ...(upState === "down" ? { pid: process.pid } : {}) });
    const result = await f.service.installAndStart();
    assert.equal(result.state, upState === "down" ? "starting" : "mismatch");
    assert.deepEqual(await readFile(f.paths.profile), f.bytes);
  });
}

for (const stream of ["stdout", "stderr"]) {
  test(`bounded ${stream} rejects oversized CLI output without exposing it`, async (t) => {
    const f = await fixture(t, { noise: "prepare", stream });
    const result = await createWhisperXProgramService({ ...f.options, maxOutputBytes: 1024 }).installAndStart();
    assert.equal(result.code, "WHISPERX_OUTPUT_LIMIT");
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
    assert.deepEqual(await readFile(f.paths.profile), f.bytes);
  });
}

test("a timed out CLI is stopped and failure remains retryable", async (t) => {
  const f = await fixture(t, { hang: "prepare", descendant: true });
  const result = await createWhisperXProgramService({ ...f.options, timeoutMs: 200 }).installAndStart();
  assert.equal(result.code, "WHISPERX_TIMEOUT");
  const pid = (await f.calls())[0].pid;
  assert.throws(() => process.kill(pid, 0));
  const descendant = Number(await readFile(join(f.paths.hostState, "descendant.pid"), "utf8"));
  assert.throws(() => process.kill(descendant, 0));
  assert.deepEqual(await readFile(f.paths.profile), f.bytes);
  await f.configure({});
  assert.equal((await f.service.installAndStart()).state, "ready");
});

test("malformed output and Profile conflicts are sanitized", async (t) => {
  const f = await fixture(t, { invalid: true });
  assert.equal((await f.service.status()).code, "WHISPERX_INVALID_REPORT");
  const profile = JSON.parse(f.bytes.toString());
  profile.bindings["@hypit/whisperx@1#whisperx-alignment"] = "custom";
  await writeFile(f.paths.profile, JSON.stringify(profile));
  const before = (await f.calls()).length;
  assert.equal((await f.service.installAndStart()).code, "WHISPERX_PROFILE_CONFLICT");
  assert.equal((await f.calls()).length, before);
});

test("early CLI failure is a command failure and never advertises a nonexistent Program log", async t => {
  const f = await fixture(t, { cliError: "prepare" });
  const result = await f.service.installAndStart();
  assert.equal(result.code, "WHISPERX_COMMAND_FAILED");
  assert.equal(result.logPath, undefined);
  assert.doesNotMatch(JSON.stringify(result), /SECRET/);
});

test("a standalone failed status probe does not inherit a completed installation's ready stage", async (t) => {
  const f = await fixture(t);
  const installed = await f.service.installAndStart();
  assert.equal(installed.state, "ready");
  assert.equal(installed.stage, "ready");
  await f.configure({ fail: "status" });
  const failed = await f.service.status();
  assert.equal(failed.state, "failed");
  assert.equal(failed.code, "WHISPERX_COMMAND_FAILED");
  assert.equal(failed.stage, undefined);
  assert.equal(await readFile(join(f.paths.hostState, "fake-state"), "utf8"), "ready");
  await f.configure({});
  assert.equal((await f.service.status()).stage, "ready");
  await f.configure({ fail: "status" });
  assert.equal((await f.service.status()).stage, undefined);
});

for (const invalid of ["relative", "outside", "symlink", "directory", "non-executable"]) {
  test(`rejects ${invalid} uv without falling back to PATH`, async (t) => {
    const f = await fixture(t);
    let bundledUv = f.bundledUv;
    if (invalid === "relative") bundledUv = "bin/uv";
    if (invalid === "outside") { bundledUv = join(f.root, "uv"); await copyFile(f.bundledUv, bundledUv); }
    if (invalid === "symlink") { await rm(bundledUv); await symlink(process.execPath, bundledUv); }
    if (invalid === "directory") { await rm(bundledUv); await mkdir(bundledUv); }
    if (invalid === "non-executable") await chmod(bundledUv, 0o644);
    const result = await createWhisperXProgramService({ ...f.options, bundledUv }).installAndStart();
    assert.equal(result.code, "WHISPERX_BUNDLED_UV_INVALID");
    assert.equal((await f.calls()).length, 0);
    assert.deepEqual(await readFile(f.paths.profile), f.bytes);
  });
}

for (const invalid of ["shell", "hash", "size", "version", "arch", "manifest-hash", "manifest-symlink"]) test(`rejects substituted bundled uv ${invalid} before CLI execution`, async t => {
  const f = await fixture(t);
  const path = join(dirname(f.bundledBin), "resource-manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8"));
  if (invalid === "shell") await writeFile(f.bundledUv, "#!/bin/sh\nexit 0\n");
  if (invalid === "hash") { const bytes = await readFile(f.bundledUv); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; await writeFile(f.bundledUv, bytes); }
  if (invalid === "size") await writeFile(f.bundledUv, Buffer.concat([await readFile(f.bundledUv), Buffer.from("x")]));
  if (invalid === "version") manifest.uv.version = "0.0.0";
  if (invalid === "arch") manifest.arch = "x64";
  if (invalid === "manifest-hash") manifest.uv.sha256 = "0".repeat(64);
  await writeFile(path, JSON.stringify(manifest));
  if (invalid === "manifest-symlink") { const target = `${path}.outside`; await copyFile(path, target); await rm(path); await symlink(target, path); }
  const result = await f.service.installAndStart();
  assert.equal(result.code, "WHISPERX_BUNDLED_UV_INVALID");
  assert.equal((await f.calls()).length, 0);
});

test("a wrong uv executable version fails before the CLI", async t => {
  const f = await fixture(t);
  t.mock.method(childProcess, "execFile", ((...args: any[]) => { args.at(-1)(null, "uv 0.0.0", ""); }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  assert.equal((await f.service.installAndStart()).code, "WHISPERX_BUNDLED_UV_INVALID");
  assert.equal((await f.calls()).length, 0);
});

test("native architecture is validated even if the fixture digest matches", async t => {
  const f = await fixture(t);
  const bytes = await readFile(f.bundledUv); bytes.writeUInt32LE(0x01000007, 4);
  await writeFile(f.bundledUv, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  uvLock.targets["darwin-arm64"].sha256 = sha256;
  const path = join(dirname(f.bundledBin), "resource-manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8")); manifest.uv.sha256 = sha256; manifest.files["bin/uv"].sha256 = sha256;
  await writeFile(path, JSON.stringify(manifest));
  let probes = 0;
  t.mock.method(childProcess, "execFile", ((...args: any[]) => { probes++; args.at(-1)(null, "uv 0.12.20", ""); }) as typeof childProcess.execFile);
  syncBuiltinESMExports();
  assert.equal((await f.service.installAndStart()).code, "WHISPERX_BUNDLED_UV_INVALID");
  assert.equal(probes, 0); assert.equal((await f.calls()).length, 0);
});

test("Windows uv enforces the PE x64 lock and rejects rehashed non-PE bytes before execution", async t => {
  const f = await fixture(t, {}, "win32");
  assert.equal((await f.service.installAndStart()).state, "ready");
  const before = (await f.calls()).length;
  const bytes = await readFile(f.bundledUv); bytes.writeUInt16LE(0xaa64, bytes.readUInt32LE(0x3c) + 4);
  await writeFile(f.bundledUv, bytes);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  uvLock.targets["win32-x64"].sha256 = sha256;
  const path = join(dirname(f.bundledBin), "resource-manifest.json");
  const manifest = JSON.parse(await readFile(path, "utf8")); manifest.uv.sha256 = sha256; manifest.files["bin/uv.exe"].sha256 = sha256;
  await writeFile(path, JSON.stringify(manifest));
  assert.equal((await f.service.start()).code, "WHISPERX_BUNDLED_UV_INVALID");
  assert.equal((await f.calls()).length, before);
});

test("bundled uv is checked again before each mutating subprocess", async (t) => {
  const f = await fixture(t);
  const result = await f.service.installAndStart(stage => { if (stage === "preparing-en") chmodSync(f.bundledUv, 0o644); });
  assert.equal(result.code, "WHISPERX_BUNDLED_UV_INVALID");
  assert.equal((await f.calls()).length, 1);
});

test("stop waits for installation and uses the existing programs down lifecycle", async (t) => {
  const f = await fixture(t, { delay: 60 });
  const installation = f.service.installAndStart();
  const stopping = f.service.stop();
  assert.equal((await installation).state, "ready");
  assert.equal((await stopping).state, "stopped");
  assert.deepEqual((await f.calls()).map(call => call.args[2]), ["prepare", "prepare", "up", "status", "down", "status"]);
});

test("stop immediately reports stopping and stays non-ready during a delayed post-down status", async (t) => {
  const f = await fixture(t);
  await f.service.installAndStart();
  await f.configure({ delay: 400, delayAction: "status" });
  const stopping = f.service.stop();
  const immediate = await f.service.status();
  let calls = await f.calls();
  for (let attempt = 0; attempt < 100 && calls.length < 6; attempt++) {
    await sleep(5);
    calls = await f.calls();
  }
  const actualState = await readFile(join(f.paths.hostState, "fake-state"), "utf8");
  const duringStatusProbe = await f.service.status();
  const stopped = await stopping;
  assert.equal(immediate.state, "stopping");
  assert.equal(calls.at(-1).args[2], "status");
  assert.equal(actualState, "down");
  assert.equal(duringStatusProbe.state, "stopping");
  assert.equal(duringStatusProbe.stage, undefined);
  assert.equal(stopped.state, "stopped");
});

for (const fail of ["down", "status"]) {
  test(`stop reports a fixed failure when ${fail} fails without restoring cached ready`, async (t) => {
    const f = await fixture(t);
    await f.service.installAndStart();
    await f.configure({ fail });
    const stopping = f.service.stop();
    const during = await f.service.status();
    const stopped = await stopping;
    assert.equal(during.state, "stopping");
    assert.equal(stopped.state, "failed");
    assert.equal(stopped.code, "WHISPERX_COMMAND_FAILED");
    assert.equal(stopped.stage, undefined);
    assert.equal(await readFile(join(f.paths.hostState, "fake-state"), "utf8"), fail === "down" ? "ready" : "down");
    assert.equal(JSON.stringify(stopped).includes("SECRET"), false);
  });
}

test("machine paths match the existing WhisperX Program Home on both platforms", () => {
  const mac = whisperXProgramPaths({ hostState: "/home/Hypit" });
  assert.equal(mac.home, "/home/Hypit/programs/whisperx-whisperx.local-127.0.0.1%3A8765");
  assert.equal(mac.state, "/home/Hypit/desktop/whisperx-state.json");
  assert.equal(whisperXProgramPaths({ hostState: "C:\\Hypit" }).home, "C:\\Hypit\\programs\\whisperx-whisperx.local-127.0.0.1%3A8765");
});

test("a nonzero CLI exit cannot claim successful preparation", async (t) => {
  const f = await fixture(t, { nonzero: "prepare" });
  assert.equal((await f.service.installAndStart()).code, "WHISPERX_COMMAND_FAILED");
  assert.deepEqual(await readFile(f.paths.profile), f.bytes);
});

test("relative packaged executable paths fail before spawning", async (t) => {
  const f = await fixture(t);
  const result = await createWhisperXProgramService({ ...f.options, electronExecutable: "node", env: { PATH: dirname(process.execPath) } }).installAndStart();
  assert.equal(result.code, "WHISPERX_COMMAND_FAILED");
  assert.equal((await f.calls()).length, 0);
});

test("unexpected machine state is preserved and prevents Profile publication", async (t) => {
  const f = await fixture(t);
  const path = whisperXProgramPaths(f.paths).state;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, "user-owned state");
  assert.equal((await f.service.installAndStart()).code, "WHISPERX_STATE_FAILED");
  assert.equal(await readFile(path, "utf8"), "user-owned state");
  assert.deepEqual(await readFile(f.paths.profile), f.bytes);
});

test("unknown fields in the machine marker are not silently overwritten", async (t) => {
  const f = await fixture(t);
  const path = whisperXProgramPaths(f.paths).state;
  await mkdir(dirname(path), { recursive: true });
  const bytes = JSON.stringify({ format: "hypit.desktop-whisperx@1", prepared: true, stopped: false, custom: "keep" });
  await writeFile(path, bytes);
  assert.equal((await f.service.installAndStart()).code, "WHISPERX_STATE_FAILED");
  assert.equal(await readFile(path, "utf8"), bytes);
});

test("changed candidate cleanup preserves user bytes and returns a recovery warning", async (t) => {
  const f = await fixture(t, { fail: "up" });
  let candidatePath = "";
  const result = await f.service.installAndStart(stage => {
    if (stage === "starting-service") {
      // The known first-pass candidate path is present in the completed CLI invocation log.
      const lines = requireCalls();
      candidatePath = lines[1].profilePath;
      writeFileSync(candidatePath, `${JSON.stringify(lines[1].profile)}\n `);
    }
  });
  function requireCalls() {
    return readFileSync(join(f.paths.hostState, "calls.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
  }
  assert.equal(result.cleanupIncomplete, true);
  assert.equal(result.code, "WHISPERX_COMMAND_FAILED");
  await f.configure({ fail: "status" });
  const reopened = await createWhisperXProgramService(f.options).status();
  assert.equal(reopened.cleanupIncomplete, true, "a new service discovers the retained candidate and its recovery");
  assert.equal(reopened.code, "WHISPERX_COMMAND_FAILED");
  assert.match(await readFile(candidatePath, "utf8"), /\n $/u);
  assert.deepEqual(await readFile(f.paths.profile), f.bytes);
});

test("an earlier status probe cannot replace the current in-flight operation state", async (t) => {
  const f = await fixture(t, { delay: 400, delayAction: "status" });
  const probing = f.service.status();
  for (let attempt = 0; attempt < 100 && (await f.calls()).length === 0; attempt++) await sleep(5);
  const installing = f.service.installAndStart();
  const observed = await probing;
  const duringInstall = await f.service.status();
  const installed = await installing;
  assert.equal(observed.state, "starting");
  assert.equal(duringInstall.state, "starting");
  assert.equal(installed.state, "ready");
});

test("inconsistent CLI status summaries cannot claim readiness", async (t) => {
  const f = await fixture(t, { reportPatch: { ready: true, readyCount: 1 } });
  assert.equal((await f.service.status()).code, "WHISPERX_INVALID_REPORT");
});

test("a symlink machine marker is refused with a fixed state error", async (t) => {
  const f = await fixture(t);
  const path = whisperXProgramPaths(f.paths).state;
  await mkdir(dirname(path), { recursive: true });
  await symlink(f.paths.profile, path);
  assert.equal((await f.service.installAndStart()).code, "WHISPERX_STATE_FAILED");
  assert.deepEqual(await readFile(f.paths.profile), f.bytes);
});

for (const { name, ok, nonzero } of [
  { name: "failed exit and ok:false", ok: false, nonzero: "status" },
  { name: "zero exit and ok:false", ok: false, nonzero: undefined },
  { name: "failed exit and ok:true", ok: true, nonzero: "status" },
]) {
  test(`ready from a status report with ${name} cannot publish or report ready`, async (t) => {
    const f = await fixture(t, { nonzero, actionPatches: { status: { ok } } });
    const stages: WhisperXProgressStage[] = [];
    const result = await f.service.installAndStart(stage => { stages.push(stage); });
    assert.equal(result.state, "failed");
    assert.equal(result.code, "WHISPERX_COMMAND_FAILED");
    assert.equal(stages.includes("ready"), false);
    assert.deepEqual(await readFile(f.paths.profile), f.bytes);
    assert.equal((await f.service.status()).state, "failed");
    assert.equal(await readFile(join(f.paths.hostState, "fake-state"), "utf8"), "ready");
  });
}

test("unsuccessful status reports still project stopped and mismatch states", async (t) => {
  const f = await fixture(t);
  await f.service.installAndStart();
  await f.service.stop();
  await f.configure({ nonzero: "status", actionPatches: { status: { ok: false } } });
  assert.equal((await f.service.status()).state, "stopped");
  await writeFile(join(f.paths.hostState, "fake-state"), "mismatch");
  assert.equal((await f.service.status()).state, "mismatch");
});

for (const { target, fail } of [
  { target: "marker", fail: false },
  { target: "Profile", fail: false },
  { target: "Profile", fail: true },
]) {
  test(`status remains starting during paused ${target} publication${fail ? " that fails" : ""}`, async (t) => {
    const f = await fixture(t);
    const statePath = whisperXProgramPaths(f.paths).state;
    let release!: () => void;
    let reached!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const paused = new Promise<void>(resolve => { reached = resolve; });
    const originalLink = fs.link;
    let markerLinks = 0;
    let pausedOnce = false;
    const mock = t.mock.method(fs, "link", async (...args: Parameters<typeof fs.link>) => {
      if (String(args[1]) === statePath) markerLinks++;
      if (!pausedOnce && ((target === "Profile" && String(args[1]) === f.paths.profile)
        || (target === "marker" && String(args[1]) === statePath && markerLinks === 2))) {
        pausedOnce = true;
        reached();
        await gate;
        if (fail) throw new Error("Injected Profile publication failure");
      }
      return originalLink(...args);
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    const stages: WhisperXProgressStage[] = [];
    const installation = f.service.installAndStart(stage => { stages.push(stage); });
    let observed;
    let observedStages;
    try {
      await Promise.race([paused, installation.then(() => { throw new Error("Publication was not paused"); })]);
      observed = await f.service.status();
      observedStages = [...stages];
    } finally { release(); }
    const completed = await installation;
    assert.equal(observed.state, "starting");
    assert.equal(observed.stage, "starting-service");
    assert.equal(observedStages.includes("ready"), false);
    if (fail) {
      assert.equal(completed.state, "failed");
      assert.equal(completed.code, "WHISPERX_PROFILE_COMMIT_FAILED");
      assert.equal(stages.includes("ready"), false);
      assert.deepEqual(await readFile(f.paths.profile), f.bytes);
    } else {
      assert.equal(completed.state, "ready");
      assert.equal(stages.at(-1), "ready");
      assert.equal(JSON.parse(await readFile(f.paths.profile, "utf8")).bindings["@hypit/whisperx@1#whisperx-alignment"], "whisperx.local");
    }
  });
}
