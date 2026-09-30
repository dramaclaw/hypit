import assert from "node:assert/strict";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { createDesktopProfile } from "../src/profile.js";
import { desktopPaths, whisperXProgramPaths } from "../src/paths.js";
import { createWhisperXProgramService } from "../src/whisperx-program.js";
import type { WhisperXProgramOptions, WhisperXProgressStage } from "../src/whisperx-program.js";

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
if (action === 'prepare') await writeFile(join(root, 'cache'), JSON.stringify(profile.endpoints['whisperx.local'].config.alignmentLanguages));
if (action === 'up') { state = control.upState || 'ready'; await writeFile(join(root, 'fake-state'), state); }
if (action === 'down') { state = 'down'; await writeFile(join(root, 'fake-state'), state); }
const ready = action === 'prepare' || state === 'ready';
const ok = action === 'status' || action === 'down' || ready;
const record = { id: 'whisperx.local', endpoint: 'whisperx.local', state, detail: 'SECRET', stateDetail: 'SECRET', logPath: '/SECRET/log', ...(control.pid ? { pid: control.pid } : {}) };
const programs = (action === 'status' || !ok) ? [record] : [];
console.log(control.invalid ? 'SECRET invalid JSON' : JSON.stringify({ format: 'hypit.cli-programs@1', action, ok, ready, programCount: 1, readyCount: ready ? 1 : 0, programs, ...(programs.length ? {} : { omittedPrograms: 1 }), ...control.reportPatch }));
if (control.nonzero === action) process.exitCode = 1;
`;

async function fixture(t: TestContext, control: Record<string, unknown> = {}) {
  const root = await mkdtemp(join(tmpdir(), "hypit-whisperx-program-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home: root, appData: root });
  const bundledBin = join(root, "resources", "bin");
  const bundledUv = join(bundledBin, "uv");
  const cliEntry = join(root, "resources", "hypit.mjs");
  await mkdir(dirname(paths.profile), { recursive: true });
  await mkdir(bundledBin, { recursive: true });
  await writeFile(bundledUv, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  await writeFile(cliEntry, fakeCli);
  const bytes = Buffer.from(JSON.stringify(createDesktopProfile({ baseUrl: "https://example.test/v1" })));
  await writeFile(paths.profile, bytes);
  const configure = (value: Record<string, unknown>) => writeFile(join(paths.hostState, "fixture.json"), JSON.stringify(value));
  await configure(control);
  const calls = async (): Promise<any[]> => (await readFile(join(paths.hostState, "calls.jsonl"), "utf8").catch(() => "")).trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const options: WhisperXProgramOptions = { paths, platform: "darwin", electronExecutable: process.execPath, cliEntry, bundledBin, bundledUv,
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
