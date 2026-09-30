import assert from "node:assert/strict";
import fs, { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { parseLocalRuntimeProfile } from "@hypit/runtime-local";
import { createDesktopProfile } from "../src/profile.js";
import { LOCAL_WHISPERX_ENDPOINT, WHISPERX_ALIGNMENT_CAPABILITY, isWhisperXProfileActivated, localWhisperXConfig, prepareWhisperXProfile } from "../src/whisperx-profile.js";

const endpoint = { use: "@hypit/provider-whisperx-local", pool: "whisperx.local", config: {
  expectedModel: "small", expectedDevice: "cpu", expectedCompute: "int8", alignmentLanguages: ["zh", "en"],
} };
async function fixture(t: TestContext, document: any = createDesktopProfile({ baseUrl: "https://newapi.example/v1" })) {
  const root = await mkdtemp(join(tmpdir(), "hypit-whisperx-profile-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profilePath = join(root, "profiles", "desktop-newapi.json");
  await mkdir(dirname(profilePath));
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  await writeFile(profilePath, bytes, { mode: 0o640 });
  return { profilePath, platform: "darwin" as const, bytes, document };
}

test("absent Profile requires completed desktop setup and creates no candidate", async (t) => {
  const f = await fixture(t);
  await rm(f.profilePath);
  await assert.rejects(prepareWhisperXProfile(f), /WHISPERX_PROFILE_REQUIRED/u);
  assert.deepEqual(await readdir(dirname(f.profilePath)), []);
});

test("candidate adds fixed local endpoint and binding without publishing", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareWhisperXProfile(f);
  const candidate = JSON.parse(await readFile(prepared.candidatePath, "utf8"));
  assert.equal(LOCAL_WHISPERX_ENDPOINT, "whisperx.local");
  assert.equal(WHISPERX_ALIGNMENT_CAPABILITY, "@hypit/whisperx@1#whisperx-alignment");
  assert.deepEqual(localWhisperXConfig, endpoint.config);
  assert.deepEqual(candidate.endpoints[LOCAL_WHISPERX_ENDPOINT], endpoint);
  assert.equal(candidate.bindings[WHISPERX_ALIGNMENT_CAPABILITY], LOCAL_WHISPERX_ENDPOINT);
  assert.doesNotThrow(() => parseLocalRuntimeProfile(candidate));
  assert.equal(dirname(prepared.candidatePath), dirname(f.profilePath));
  assert.equal(resolve(dirname(prepared.candidatePath), candidate.dataRoot), resolve(dirname(f.profilePath), f.document.dataRoot));
  assert.equal((await stat(prepared.candidatePath)).mode & 0o777, 0o600);
  assert.deepEqual(await readFile(f.profilePath), f.bytes);
  assert.equal(await prepared.rollback(), false);
  assert.deepEqual(await prepared.dispose(false), []);
  assert.deepEqual(await readdir(dirname(f.profilePath)), ["desktop-newapi.json"]);
});

test("read-only activation requires both exact managed fragments and never creates a candidate", async (t) => {
  const f = await fixture(t);
  assert.equal(await isWhisperXProfileActivated(f), false);
  f.document.endpoints[LOCAL_WHISPERX_ENDPOINT] = endpoint;
  await writeFile(f.profilePath, JSON.stringify(f.document));
  assert.equal(await isWhisperXProfileActivated(f), false);
  f.document.bindings[WHISPERX_ALIGNMENT_CAPABILITY] = LOCAL_WHISPERX_ENDPOINT;
  const bytes = Buffer.from(`\n${JSON.stringify(f.document)}  \n`);
  await writeFile(f.profilePath, bytes);
  assert.equal(await isWhisperXProfileActivated(f), true);
  assert.deepEqual(await readFile(f.profilePath), bytes);
  assert.deepEqual(await readdir(dirname(f.profilePath)), ["desktop-newapi.json"]);
  delete f.document.endpoints[LOCAL_WHISPERX_ENDPOINT];
  await writeFile(f.profilePath, JSON.stringify(f.document));
  assert.equal(await isWhisperXProfileActivated(f), false);
});

test("read-only activation refuses conflicting, invalid and missing Profiles", async (t) => {
  const f = await fixture(t);
  f.document.endpoints[LOCAL_WHISPERX_ENDPOINT] = { ...endpoint, extra: true };
  await writeFile(f.profilePath, JSON.stringify(f.document));
  await assert.rejects(isWhisperXProfileActivated(f), /WHISPERX_PROFILE_CONFLICT/u);
  f.document.endpoints[LOCAL_WHISPERX_ENDPOINT] = endpoint;
  f.document.bindings[WHISPERX_ALIGNMENT_CAPABILITY] = "custom";
  await writeFile(f.profilePath, JSON.stringify(f.document));
  await assert.rejects(isWhisperXProfileActivated(f), /WHISPERX_PROFILE_CONFLICT/u);
  await writeFile(f.profilePath, "invalid");
  await assert.rejects(isWhisperXProfileActivated(f), /WHISPERX_PROFILE_INVALID/u);
  await rm(f.profilePath);
  await assert.rejects(isWhisperXProfileActivated(f), /WHISPERX_PROFILE_REQUIRED/u);
  assert.deepEqual(await readdir(dirname(f.profilePath)), []);
});

test("commit preserves unrelated document values and original permissions", async (t) => {
  const document = createDesktopProfile({ baseUrl: "https://newapi.example/v1" }) as any;
  document.dataRoot = "../my-custom-runtime";
  document.worker = { executionMemoryMb: 2048 };
  document.endpoints.custom = { use: "@hypit/provider-whisperx-local", config: { expectedModel: "large-v3" } };
  document.bindings["@hypit/whisperx@1#whisperx-transcription"] = "custom";
  const f = await fixture(t, document);
  const prepared = await prepareWhisperXProfile(f);
  await prepared.commit();
  const actual = JSON.parse(await readFile(f.profilePath, "utf8"));
  delete actual.endpoints[LOCAL_WHISPERX_ENDPOINT];
  delete actual.bindings[WHISPERX_ALIGNMENT_CAPABILITY];
  assert.deepEqual(actual, document);
  assert.equal((await stat(f.profilePath)).mode & 0o777, 0o640);
  assert.deepEqual(await prepared.dispose(true), []);
  assert.deepEqual(await readdir(dirname(f.profilePath)), ["desktop-newapi.json"]);
});

test("exact managed configuration preserves existing Profile bytes", async (t) => {
  const f = await fixture(t);
  f.document.endpoints[LOCAL_WHISPERX_ENDPOINT] = endpoint;
  f.document.bindings[WHISPERX_ALIGNMENT_CAPABILITY] = LOCAL_WHISPERX_ENDPOINT;
  const bytes = Buffer.from(`\n${JSON.stringify(f.document)}  \n`);
  await writeFile(f.profilePath, bytes);
  const prepared = await prepareWhisperXProfile(f);
  assert.deepEqual(await readFile(prepared.candidatePath), bytes);
  await prepared.commit();
  assert.deepEqual(await readFile(f.profilePath), bytes);
  assert.deepEqual(await prepared.dispose(true), []);
});

for (const value of [null, "user-owned", { ...endpoint, pool: "custom" }, { ...endpoint, config: { ...endpoint.config, expectedModel: "large-v3" } }, { ...endpoint, extra: true }]) {
  test(`rejects user-owned endpoint ${JSON.stringify(value)}`, async (t) => {
    const f = await fixture(t);
    f.document.endpoints[LOCAL_WHISPERX_ENDPOINT] = value;
    const bytes = Buffer.from(JSON.stringify(f.document));
    await writeFile(f.profilePath, bytes);
    await assert.rejects(prepareWhisperXProfile(f), /WHISPERX_PROFILE_CONFLICT/u);
    assert.deepEqual(await readFile(f.profilePath), bytes);
    assert.deepEqual(await readdir(dirname(f.profilePath)), ["desktop-newapi.json"]);
  });
}

test("rejects an existing binding to another endpoint", async (t) => {
  const f = await fixture(t);
  f.document.bindings[WHISPERX_ALIGNMENT_CAPABILITY] = "custom";
  await writeFile(f.profilePath, JSON.stringify(f.document));
  await assert.rejects(prepareWhisperXProfile(f), /WHISPERX_PROFILE_CONFLICT/u);
});

for (const bytes of ["{", "null", "[]", '{"format":"other"}', '{"format":"hypit.runtime-local@1","dataRoot":"..","endpoints":[],"bindings":{}}']) {
  test(`rejects malformed Profile ${bytes}`, async (t) => {
    const f = await fixture(t);
    await writeFile(f.profilePath, bytes);
    await assert.rejects(prepareWhisperXProfile(f), /WHISPERX_PROFILE_INVALID/u);
    assert.equal(await readFile(f.profilePath, "utf8"), bytes);
    assert.deepEqual(await readdir(dirname(f.profilePath)), ["desktop-newapi.json"]);
  });
}

test("rejects a symlink Profile without changing its target", async (t) => {
  const f = await fixture(t);
  const target = `${f.profilePath}.user`;
  await writeFile(target, f.bytes);
  await rm(f.profilePath);
  await symlink(target, f.profilePath);
  await assert.rejects(prepareWhisperXProfile(f), /regular file/u);
  assert.deepEqual(await readFile(target), f.bytes);
});

test("an edit after preparation prevents commit and retains the user's bytes", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareWhisperXProfile(f);
  await writeFile(f.profilePath, "user edit");
  await assert.rejects(prepared.commit(), /File changed/u);
  assert.equal(await prepared.rollback(), false);
  assert.deepEqual(await prepared.dispose(false), []);
  assert.equal(await readFile(f.profilePath, "utf8"), "user edit");
  assert.deepEqual(await readdir(dirname(f.profilePath)), ["desktop-newapi.json"]);
});

test("rollback restores the original bytes and mode", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareWhisperXProfile(f);
  await prepared.commit();
  assert.equal(await prepared.rollback(), false);
  assert.deepEqual(await readFile(f.profilePath), f.bytes);
  assert.equal((await stat(f.profilePath)).mode & 0o777, 0o640);
  assert.deepEqual(await prepared.dispose(false), []);
  assert.deepEqual(await readdir(dirname(f.profilePath)), ["desktop-newapi.json"]);
});

test("rollback retains post-publication changes and reports recovery paths", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareWhisperXProfile(f);
  await prepared.commit();
  await writeFile(f.profilePath, "user changed published Profile");
  assert.equal(await prepared.rollback(), true);
  const warnings = await prepared.dispose(false);
  assert.ok(warnings.some(warning => warning.reason === "CLEANUP_INCOMPLETE" && warning.code === "profile"));
  const recovery = warnings.find(warning => warning.path?.startsWith(`${f.profilePath}.recovery-`))!.path!;
  assert.deepEqual(await readFile(join(recovery, "displaced")), f.bytes);
  assert.equal(await readFile(f.profilePath, "utf8"), "user changed published Profile");
});

test("changed candidate cannot be published or discarded silently", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareWhisperXProfile(f);
  await writeFile(prepared.candidatePath, "user changed candidate");
  await assert.rejects(prepared.commit(), /candidate changed/iu);
  assert.equal(await prepared.rollback(), false);
  const warnings = await prepared.dispose(false);
  assert.ok(warnings.some(warning => warning.reason === "CLEANUP_INCOMPLETE"));
  assert.equal(await readFile(prepared.candidatePath, "utf8"), "user changed candidate");
  assert.deepEqual(await readFile(f.profilePath), f.bytes);
});

test("rollback cleanup preserves unexpected recovery content and reports its path", async (t) => {
  const f = await fixture(t);
  const prepared = await prepareWhisperXProfile(f);
  await prepared.commit();
  const recoveryName = (await readdir(dirname(f.profilePath))).find(name => name.startsWith("desktop-newapi.json.recovery-"))!;
  const recovery = join(dirname(f.profilePath), recoveryName);
  await writeFile(join(recovery, "user-note"), "retain this recovery note");
  assert.equal(await prepared.rollback(), false);
  const warnings = await prepared.dispose(false);
  assert.ok(warnings.some(warning => warning.reason === "CLEANUP_INCOMPLETE" && warning.path === recovery));
  assert.equal(await readFile(join(recovery, "user-note"), "utf8"), "retain this recovery note");
  assert.deepEqual(await readFile(f.profilePath), f.bytes);
});

test("preparation refuses a candidate changed while its ownership snapshot is captured", async (t) => {
  const f = await fixture(t);
  const originalRead = fs.readFile;
  let candidatePath: string | undefined;
  const mock = t.mock.method(fs, "readFile", async (...args: Parameters<typeof fs.readFile>) => {
    const bytes = await originalRead(...args);
    const path = String(args[0]);
    if (!candidatePath && path.startsWith(`${f.profilePath}.whisperx-`) && path.endsWith(".json")) {
      candidatePath = path;
      await writeFile(path, "edit during candidate snapshot");
    }
    return bytes;
  });
  syncBuiltinESMExports();
  t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
  await assert.rejects(prepareWhisperXProfile(f), (error: unknown) => {
    assert.match((error as Error).message, /CLEANUP_INCOMPLETE/u);
    assert.ok((error as { diagnostics: unknown[] }).diagnostics.length);
    return true;
  });
  assert.ok(candidatePath);
  assert.equal(await readFile(candidatePath, "utf8"), "edit during candidate snapshot");
  assert.deepEqual(await readFile(f.profilePath), f.bytes);
});
