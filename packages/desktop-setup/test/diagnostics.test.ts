import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runDiagnostics, diagnosticEnvironment, verifyInstalledResources } from "../src/diagnostics.js";
import { desktopPaths } from "../src/paths.js";
import { supportedSkillTargets } from "../src/agent-targets.js";
import { installManagedSkill } from "../src/skill-install.js";
import { completeNewApiSetup } from "@dramaclaw/provider-newapi";
import { createDesktopProfile } from "../src/profile.js";

async function bundle(root: string, cli = "verified") {
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const path of ["bin/ffmpeg", "bin/ffprobe", "runtime/node_modules/@hypit/hypit/bin/hypit.mjs", "skill/hypit/SKILL.md"]) {
    const bytes = Buffer.from(path.endsWith("hypit.mjs") ? cli : "verified"); await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes);
    files[path] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
  }
  await writeFile(join(root, "resource-manifest.json"), JSON.stringify({ schemaVersion: 1, platform: "darwin", arch: "arm64", files }));
}

test("diagnostics checks every active Skill target and executes the bundled CLI by absolute path", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hypit-diagnostic-targets-")); t.after(() => rm(home, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home, appData: home });
  const resources = join(home, "resources");
  await bundle(resources, "console.log('hypit-test-version')");
  const sourceDirectory = join(resources, "skill", "hypit");
  await mkdir(join(sourceDirectory, "references"));
  await writeFile(join(sourceDirectory, "references", "guide.md"), "guide");
  await mkdir(paths.agentProbePaths["claude-code"][0]!, { recursive: true });
  const targets = supportedSkillTargets(paths);
  for (const target of targets) await installManagedSkill({ target, sourceDirectory, installedVersion: "1" });
  const calls: string[] = [];
  const results = await runDiagnostics({ paths, resources, platform: "darwin", arch: "arm64", home, electronExecutable: process.execPath,
    credentialStore: { owns: () => true, resolve: async () => undefined },
    execute: async (file, args, options) => {
      if (args.includes("--version")) {
        assert.equal(file, process.execPath);
        assert.equal(options.env.PATH?.includes(join(home, ".local", "bin")), false);
        const output = await promisify(execFile)(file, args, options);
        assert.match(output.stdout, /hypit-test-version/);
        calls.push("cli");
      }
    },
  });
  assert.deepEqual(calls, ["cli"]);
  assert.equal(results.find(item => item.code === "version")?.status, "pass");
  assert.deepEqual(results.filter(item => item.code === "skill").map(item => item.target), ["portable", "claude"]);
  assert.deepEqual(results.filter(item => item.code === "skill").map(item => item.status), ["pass", "pass"]);
});

test("resource verification detects missing and corrupt resources", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypit-diagnostic-")); t.after(() => rm(root, { recursive: true, force: true }));
  await assert.rejects(verifyInstalledResources(root, "darwin", "arm64"));
  const file = Buffer.from("runtime"); await mkdir(join(root, "bin")); await writeFile(join(root, "bin/ffmpeg"), file);
  await writeFile(join(root, "resource-manifest.json"), JSON.stringify({ schemaVersion: 1, platform: "darwin", arch: "arm64", files: { "bin/ffmpeg": { bytes: file.length, sha256: createHash("sha256").update(file).digest("hex") } } }));
  // An incomplete manifest cannot pretend the full runtime is installed.
  await assert.rejects(verifyInstalledResources(root, "darwin", "arm64"));
  const files: Record<string, { bytes: number; sha256: string }> = {};
  for (const path of ["bin/ffmpeg", "bin/ffprobe", "runtime/node_modules/@hypit/hypit/bin/hypit.mjs", "skill/hypit/SKILL.md"]) {
    await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), file);
    files[path] = { bytes: file.length, sha256: createHash("sha256").update(file).digest("hex") };
  }
  await writeFile(join(root, "resource-manifest.json"), JSON.stringify({ schemaVersion: 1, platform: "darwin", arch: "arm64", files }));
  await verifyInstalledResources(root, "darwin", "arm64");
  await writeFile(join(root, "bin/ffprobe"), "tampered"); await assert.rejects(verifyInstalledResources(root, "darwin", "arm64"), /Corrupt/);
});

test("diagnostics run only bounded version/tool probes and setup network tests, redact captured output", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hypit-diagnostics-")); t.after(() => rm(home, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home, appData: home }); const resources = join(home, "resources");
  await bundle(resources);
  const input = { baseUrl: "https://api.example", apiKey: "secret-api", relay: { enabled: true as const, endpoint: "oss.example", bucket: "test-bucket", accessKeyId: "secret-ak", accessKeySecret: "secret-sk" } };
  const setup = completeNewApiSetup(input); const values = [input.apiKey, input.relay.accessKeyId, input.relay.accessKeySecret];
  await mkdir(dirname(paths.profile), { recursive: true }); await writeFile(paths.profile, JSON.stringify(createDesktopProfile(setup.config)));
  const calls: any[] = []; let network = 0; let testedInput: unknown;
  const result = await runDiagnostics({ paths, resources, platform: "darwin", arch: "arm64", home, electronExecutable: process.execPath,
    credentialStore: { owns: () => true, resolve: async (ref: any) => ({ secret: values[["newapi.personal.api-key", "newapi.personal.oss-ak", "newapi.personal.oss-sk"].indexOf(ref.key)]! }) },
    execute: async (file, args, options) => { calls.push({ file, args, options }); return { stdout: "secret-api", stderr: "secret-sk" }; },
    testConnection: async (submitted) => { network++; testedInput = submitted; return { modelCount: 3, relayVerified: true }; },
  });
  assert.deepEqual(testedInput, { ...input, baseUrl: "https://api.example/v1" });
  assert.equal(network, 1); assert.equal(calls.length, 3);
  assert.deepEqual(calls.map(call => call.args), [[join(resources, "runtime/node_modules/@hypit/hypit/bin/hypit.mjs"), "--version"], ["-version"], ["-version"]]);
  assert.ok(calls.every(call => call.options.timeout === 30000 && call.options.shell === false));
  assert.ok(result.some(item => item.code === "bundle" && item.status === "pass"));
  assert.ok(result.some(item => item.code === "newapi" && item.status === "pass"));
  assert.ok(result.some(item => item.code === "oss" && item.status === "pass"));
  assert.ok(!JSON.stringify(result).includes("secret-"));
  const key = "relay/hypit/setup-test/12345678-1234-4123-8123-123456789abc.txt";
  const cleanup = await runDiagnostics({ paths, resources, platform: "darwin", arch: "arm64", home, electronExecutable: process.execPath,
    credentialStore: { owns: () => true, resolve: async () => ({ secret: "private" }) }, execute: async () => undefined,
    testConnection: async () => ({ modelCount: 1, relayVerified: true, cleanupObjectKey: key }) });
  assert.deepEqual(cleanup.find(item => item.code === "oss"), { code: "oss", label: "OSS", status: "warning", cleanupObjectKey: key });
  assert.equal(cleanup.find(item => item.code === "newapi")?.status, "pass");
  const malformed = createDesktopProfile(setup.config) as any; delete malformed.bindings;
  await writeFile(paths.profile, JSON.stringify(malformed));
  const invalid = await runDiagnostics({ paths, resources, platform: "darwin", arch: "arm64", home, electronExecutable: process.execPath,
    credentialStore: { owns: () => true, resolve: async () => ({ secret: "private" }) }, execute: async () => undefined,
    testConnection: async () => { network++; return { modelCount: 1, relayVerified: true }; } });
  assert.equal(invalid.find(item => item.code === "profile")?.status, "fail"); assert.equal(network, 1);
});

test("missing/corrupt resources are reported without executing them; invalid profile skips network tests", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "hypit-diagnostic-failure-")); t.after(() => rm(home, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home, appData: home }); const resources = join(home, "resources");
  let processes = 0, network = 0;
  const results = await runDiagnostics({ paths, resources, platform: "darwin", arch: "arm64", home, electronExecutable: process.execPath,
    credentialStore: { owns: () => true, resolve: async () => undefined }, execute: async () => { processes++; },
    testConnection: async () => { network++; return { modelCount: 1, relayVerified: true }; } });
  assert.equal(processes, 0); assert.equal(network, 0);
  for (const code of ["bundle", "version", "ffmpeg", "profile", "credentials"]) assert.equal(results.find(item => item.code === code)?.status, "fail");
});

test("diagnostic environment keeps only OS essentials and bundled media PATH", () => {
  const env = diagnosticEnvironment("/bundle/bin", "darwin", { PATH: "/opt/homebrew/bin", API_KEY: "private", NODE_OPTIONS: "--require evil", HOME: "/home" });
  assert.equal(env.PATH, "/bundle/bin:/usr/bin:/bin"); assert.equal(env.HOME, "/home"); assert.equal(env.API_KEY, undefined); assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(diagnosticEnvironment("C:\\app\\bin", "win32", { SystemRoot: "C:\\Windows" }).PATH, "C:\\app\\bin;C:\\Windows\\System32;C:\\Windows");
});
