import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import type { CanonicalValue } from "@hypit/protocol";
import type { CredentialValue, WritableCredentialStore } from "@hypit/runtime";

import type { SetupInput } from "../src/contracts.js";
import { desktopPaths } from "../src/paths.js";
import { commitDesktopSetup } from "../src/setup-core.js";
import type { DesktopSetupDependencies } from "../src/setup-core.js";

const input: SetupInput = {
  baseUrl: "https://newapi.example/v1",
  apiKey: "submitted-api-secret",
  relay: { enabled: true, endpoint: "oss.example", bucket: "test-bucket",
    accessKeyId: "submitted-oss-ak", accessKeySecret: "submitted-oss-sk" },
};
const keys = ["newapi.personal.api-key", "newapi.personal.oss-ak", "newapi.personal.oss-sk"];
const secrets = [input.apiKey, input.relay.accessKeyId, input.relay.accessKeySecret];
const paths = desktopPaths({ platform: "darwin", home: "/Users/tester", appData: "/Users/tester/Library/Application Support" });

function fixture(existing = false) {
  const values = new Map<string, CredentialValue>(existing
    ? keys.map((key, index) => [key, { secret: `old-secret-${index}`, expiresAt: 123456 }]) : []);
  const original = new Map(values);
  const events: string[] = [];
  const documents: CanonicalValue[] = [];
  const store: WritableCredentialStore = {
    owns: (ref) => ref.store === "platform",
    async resolve(ref) { events.push(`resolve:${ref.key}`); return values.get(ref.key); },
    async put(ref, value) { events.push(`put:${ref.key}`); values.set(ref.key, value); },
    async delete(ref) { events.push(`delete:${ref.key}`); return values.delete(ref.key); },
  };
  const dependencies: DesktopSetupDependencies = {
    paths, credentialStore: store, platform: "darwin",
    connectionTest: {
      async fetch(url) {
        events.push(String(url).endsWith("/models") ? "test-newapi" : "test-oss-download");
        return String(url).endsWith("/models")
          ? Response.json({ data: [{ id: "model-1" }, { id: "model-2" }] })
          : new Response("HY");
      },
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
      createOssClient: () => ({
        async put() { events.push("test-oss-upload"); },
        signatureUrl() { return "https://oss.example/probe?signature=secret-signature"; },
        async delete() { events.push("test-oss-delete"); },
      }),
    },
    async writeProfile(path, document, options) {
      events.push("write-profile");
      assert.equal(path, paths.profile);
      assert.equal(options.mode, 0o600);
      for (const secret of secrets) assert.equal(JSON.stringify(document).includes(secret), false);
      documents.push(document);
    },
  };
  return { dependencies, values, original, events, documents, store };
}

function safeFailure(message: string) {
  return (error: unknown) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message, message);
    assert.equal(error.cause, undefined);
    for (const secret of [...secrets, "secret-signature", "old-secret"]) {
      assert.equal(`${error.stack}${JSON.stringify(error)}`.includes(secret), false);
    }
    return true;
  };
}

for (const existing of [false, true]) {
  test(existing ? "successful setup replaces all three credentials" : "fresh setup tests connections before saving all credentials and profile", async () => {
    const f = fixture(existing);
    const result = await commitDesktopSetup(input, f.dependencies);
    assert.deepEqual([...f.values.values()], secrets.map((secret) => ({ secret })));
    assert.deepEqual(f.events, ["test-newapi", "test-oss-upload", "test-oss-download", "test-oss-delete",
      ...keys.map((key) => `resolve:${key}`), ...keys.map((key) => `put:${key}`), "write-profile"]);
    assert.equal(f.documents.length, 1);
    assert.deepEqual(result, { configured: true, modelCount: 2, relayVerified: true,
      profilePath: paths.profile, skillPath: paths.skill, launcherPath: paths.launcher,
      diagnostics: [
        { code: "newapi", status: "pass", label: "NewAPI" },
        { code: "oss", status: "pass", label: "OSS" },
        { code: "credentials", status: "pass", label: "平台凭据" },
        { code: "profile", status: "pass", label: "Runtime Profile", path: paths.profile },
      ] });
    for (const secret of secrets) assert.equal(JSON.stringify(result).includes(secret), false);
  });
}

test("invalid or disabled-relay input fails before connections and writes", async () => {
  for (const invalid of [{ ...input, apiKey: "" }, { ...input, relay: { enabled: false } }]) {
    const f = fixture();
    await assert.rejects(commitDesktopSetup(invalid as SetupInput, f.dependencies), safeFailure("配置校验失败 [SETUP_VALIDATION_FAILED]"));
    assert.deepEqual(f.events, []);
  }
});

test("NewAPI connection failure happens before any credential access or profile write", async () => {
  const f = fixture(true);
  const connectionTest = { ...f.dependencies.connectionTest!, async fetch() { throw new Error(input.apiKey); } };
  await assert.rejects(commitDesktopSetup(input, { ...f.dependencies, connectionTest }), safeFailure("NewAPI 连接测试失败 [SETUP_NEWAPI_FAILED]"));
  assert.deepEqual(f.events, []);
  assert.deepEqual(f.values, f.original);
});

test("OSS connection errors are replaced with a stable Chinese stage", async () => {
  const f = fixture();
  const connectionTest = { ...f.dependencies.connectionTest!, createOssClient() { throw new Error(input.relay.accessKeySecret); } };
  await assert.rejects(commitDesktopSetup(input, { ...f.dependencies, connectionTest }), safeFailure("OSS 连接测试失败 [SETUP_OSS_FAILED]"));
  assert.deepEqual(f.events, ["test-newapi"]);
});

test("credential snapshot failure leaves credentials and profile untouched", async () => {
  const f = fixture(true);
  f.store.resolve = async () => { throw new Error(input.apiKey); };
  await assert.rejects(commitDesktopSetup(input, f.dependencies), safeFailure("读取平台凭据失败 [SETUP_CREDENTIAL_SNAPSHOT_FAILED]"));
  assert.deepEqual(f.values, f.original);
  assert.equal(f.documents.length, 0);
});

for (const existing of [false, true]) {
  test(`second credential write failure reverses attempted writes (${existing ? "restore" : "delete"})`, async () => {
    const f = fixture(existing);
    const put = f.store.put;
    let writes = 0;
    f.store.put = async (ref, value) => {
      await put(ref, value);
      if (++writes === 2) throw new Error(input.relay.accessKeyId);
    };
    await assert.rejects(commitDesktopSetup(input, f.dependencies), safeFailure("保存平台凭据失败 [SETUP_CREDENTIAL_WRITE_FAILED]"));
    assert.deepEqual(f.values, f.original);
    assert.equal(f.documents.length, 0);
    assert.deepEqual(f.events.slice(-2), [keys[1], keys[0]].map((key) => `${existing ? "put" : "delete"}:${key}`));
  });
}

test("profile failure restores complete credential values in reverse order", async () => {
  const f = fixture(true);
  await assert.rejects(commitDesktopSetup(input, { ...f.dependencies,
    async writeProfile() { throw new Error(input.apiKey); },
  }), safeFailure("写入 Runtime Profile 失败 [SETUP_PROFILE_WRITE_FAILED]"));
  assert.deepEqual(f.values, f.original);
  assert.deepEqual(f.events.slice(-3), [...keys].reverse().map((key) => `put:${key}`));
});

test("rollback attempts every modified slot even if restoring one fails", async () => {
  const f = fixture(true);
  const put = f.store.put;
  f.store.put = async (ref, value) => {
    if (ref.key === keys[2] && value.secret.startsWith("old-secret")) throw new Error(value.secret);
    await put(ref, value);
  };
  await assert.rejects(commitDesktopSetup(input, { ...f.dependencies,
    async writeProfile() { throw new Error(input.apiKey); },
  }), safeFailure("写入 Runtime Profile 失败；平台凭据回滚未完成 [SETUP_PROFILE_WRITE_FAILED_ROLLBACK_FAILED]"));
  assert.deepEqual(f.values.get(keys[0]!), f.original.get(keys[0]!));
  assert.deepEqual(f.values.get(keys[1]!), f.original.get(keys[1]!));
});

test("default writer atomically replaces an existing profile with private POSIX permissions", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypit-desktop-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const f = fixture();
  const profile = join(root, "profiles", "desktop-newapi.json");
  await mkdir(dirname(profile));
  await writeFile(profile, "old profile", { mode: 0o644 });
  const { writeProfile: _writer, ...dependencies } = f.dependencies;
  await commitDesktopSetup(input, { ...dependencies, paths: { ...paths, profile } });
  const document = await readFile(profile, "utf8");
  assert.equal(JSON.parse(document).format, "hypit.runtime-local@1");
  for (const secret of secrets) assert.equal(document.includes(secret), false);
  if (process.platform !== "win32") assert.equal((await stat(profile)).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(dirname(profile)), ["desktop-newapi.json"]);
});

test("default writer cleans its temporary file on atomic rename failure and restores credentials", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypit-desktop-setup-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, "profile-is-directory");
  await mkdir(profile);
  const f = fixture(true);
  const { writeProfile: _writer, ...dependencies } = f.dependencies;
  await assert.rejects(commitDesktopSetup(input, { ...dependencies, paths: { ...paths, profile } }),
    safeFailure("写入 Runtime Profile 失败 [SETUP_PROFILE_WRITE_FAILED]"));
  assert.deepEqual(f.values, f.original);
  assert.deepEqual(await readdir(root), ["profile-is-directory"]);
});

test("Windows writer does not request unsupported POSIX permissions", async () => {
  const f = fixture();
  await commitDesktopSetup(input, { ...f.dependencies, platform: "win32",
    async writeProfile(_path, _document, options) { assert.deepEqual(options, {}); },
  });
});
