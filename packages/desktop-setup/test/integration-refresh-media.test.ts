import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { completeNewApiSetup } from "@dramaclaw/provider-newapi";
import { desktopPaths } from "../src/paths.js";
import { scanAgentTargets } from "../src/agent-targets.js";
import { createDesktopProfile, prepareDesktopMediaRefresh } from "../src/profile.js";
import { installDesktopIntegration } from "../src/lifecycle.js";
import { createDesktopStatusLifecycle, createSetupController, readDesktopStatus, reconcileStartupStatus, refreshDesktopStatus } from "../src/main.js";
import { runDiagnostics } from "../src/diagnostics.js";
import { commitDesktopSetup } from "../src/setup-core.js";
import { SKILL_MARKER } from "../src/skill-install.js";

async function fixture(t: TestContext, platform: "darwin" | "win32") {
  const home = await mkdtemp(join(tmpdir(), "hypit-media-refresh-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home, appData: join(home, "appdata") });
  let path = "original PATH";
  const userPath = { read: async () => path, compareAndSet: async (expected: string, value: string) => { if (path !== expected) return false; path = value; return true; } };
  const suffix = platform === "win32" ? ".exe" : "";
  async function app(name: string) {
    const appDirectory = join(home, name);
    const resources = platform === "darwin" ? join(appDirectory, "Contents", "Resources") : join(appDirectory, "resources");
    const bundledBin = join(resources, "bin");
    const electronExecutable = platform === "darwin" ? join(appDirectory, "Contents", "MacOS", "Hypit Setup") : join(appDirectory, "Hypit Setup.exe");
    const cliEntry = join(resources, "runtime", "node_modules", "@hypit", "hypit", "bin", "hypit.mjs");
    const media = { ffmpegPath: join(bundledBin, `ffmpeg${suffix}`), ffprobePath: join(bundledBin, `ffprobe${suffix}`) };
    const sourceDirectory = join(resources, "skill", "hypit");
    for (const file of [electronExecutable, cliEntry, ...Object.values(media), join(sourceDirectory, "SKILL.md"), join(sourceDirectory, "references", "guide.md")]) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, `fixture ${name}`);
    }
    return { paths, targets: (await scanAgentTargets({ paths })).targets, platform, home, userPath, appDirectory, bundledBin, electronExecutable, cliEntry, sourceDirectory, installedVersion: name, media };
  }
  const old = await app("old");
  const current = await app("new");
  const config = completeNewApiSetup({ baseUrl: "https://api.example/v1", apiKey: "fixture-secret", relay: {
    enabled: true, endpoint: "oss.example", bucket: "test-bucket", accessKeyId: "fixture-ak", accessKeySecret: "fixture-sk",
  } }).config;
  await mkdir(dirname(paths.profile), { recursive: true });
  await writeFile(paths.profile, JSON.stringify(createDesktopProfile(config, old.media)));
  await installDesktopIntegration(old);
  return { old, current, paths, config, readPath: () => path };
}

for (const platform of ["darwin", "win32"] as const) {
  test(`${platform} Profile recovery cleanup warning keeps a committed refresh configured`, async (t) => {
    const f = await fixture(t, platform);
    const unlink = fs.unlink;
    const mock = t.mock.method(fs, "unlink", async (path: Parameters<typeof fs.unlink>[0]) => {
      if (String(path).startsWith(`${f.paths.profile}.recovery-`) && String(path).endsWith("/displaced")) throw new Error("fixture-secret");
      return unlink(path);
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    const result = await refreshDesktopStatus(f.current);
    assert.equal(result.configured, true);
    const warning = result.diagnostics.find(item => item.code === "profile" && item.reason === "CLEANUP_INCOMPLETE");
    assert.ok(warning);
    assert.ok(warning.path?.includes(".recovery-"));
    assert.equal(result.diagnostics.filter(item => item.reason === "CLEANUP_INCOMPLETE" && item.path === warning.path).length, 1);
    const reconciled = reconcileStartupStatus(await readDesktopStatus(f.current), result);
    assert.equal(reconciled.configured, true);
    assert.ok(reconciled.diagnostics.some(item => item.path === warning.path));
    assert.doesNotMatch(JSON.stringify(reconciled), /fixture-secret/);
    const fresh = await readDesktopStatus(f.current);
    assert.equal(fresh.configured, true);
    assert.ok(fresh.diagnostics.some(item => item.reason === "CLEANUP_INCOMPLETE" && item.path === warning.path));
    const controller = createSetupController({ getStatus: () => readDesktopStatus(f.current), commit: async () => fresh,
      install: async () => {}, diagnose: () => runDiagnostics({ ...f.current, resources: join(f.current.appDirectory, "resources"), arch: "arm64",
        credentialStore: { owns: () => true, resolve: async () => undefined } as any, execute: async () => undefined }),
      openConfig: async () => {}, clear: () => readDesktopStatus(f.current), refreshAgents: async () => {} });
    for (const reply of [await controller.getStatus(), await controller.rerunDiagnostics(), await controller.refreshAgentIntegration()]) {
      assert.equal(reply.ok, true);
      if (reply.ok) assert.equal(reply.value.diagnostics.filter(item => item.reason === "CLEANUP_INCOMPLETE" && item.path === warning.path).length, 1);
    }
    mock.mock.restore(); syncBuiltinESMExports();
    await rm(warning.path!, { recursive: true });
    const cleared = await readDesktopStatus(f.current);
    assert.equal(cleared.configured, true);
    assert.ok(!cleared.diagnostics.some(item => item.reason === "CLEANUP_INCOMPLETE" && item.path === warning.path));
    assert.ok(!reconcileStartupStatus(cleared, result).diagnostics.some(item => item.reason === "CLEANUP_INCOMPLETE" && item.path === warning.path));
  });

  test(`${platform} prepared media refresh refuses an edit before its commit`, async (t) => {
    const f = await fixture(t, platform);
    const refresh = await prepareDesktopMediaRefresh(f.current);
    assert.ok(refresh);
    const edited = `${await readFile(f.paths.profile, "utf8")}\n `;
    await writeFile(f.paths.profile, edited);
    await assert.rejects(refresh.commit());
    assert.equal(await refresh.rollback(), false);
    assert.deepEqual(await refresh.dispose(false), []);
    assert.equal(await readFile(f.paths.profile, "utf8"), edited);
  });

  test(`${platform} Profile publication retains a new destination and the displaced Profile`, async (t) => {
    const f = await fixture(t, platform);
    const original = await readFile(f.paths.profile);
    const edited = JSON.stringify({ ...JSON.parse(original.toString()), userSetting: "concurrent edit" });
    const link = fs.link;
    let injected = false;
    const mock = t.mock.method(fs, "link", async (source: Parameters<typeof fs.link>[0], destination: Parameters<typeof fs.link>[1]) => {
      if (!injected && destination === f.paths.profile) { injected = true; await writeFile(f.paths.profile, edited); }
      return link(source, destination);
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    const result = await refreshDesktopStatus(f.current);
    assert.equal(result.configured, false);
    assert.equal(await readFile(f.paths.profile, "utf8"), edited);
    const recovery = result.diagnostics.find(item => item.code === "profile" && item.path?.includes(".recovery-"));
    assert.equal(recovery?.reason, "CLEANUP_INCOMPLETE");
    assert.deepEqual(await readFile(join(recovery!.path!, "displaced")), original);
  });

  test(`${platform} media refresh preserves an edit at forward publication`, async (t) => {
    const f = await fixture(t, platform);
    const saved = JSON.parse(await readFile(f.paths.profile, "utf8"));
    const edited = JSON.stringify({ ...saved, userSetting: "concurrent edit" });
    const rename = fs.rename;
    let injected = false;
    const mock = t.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
      if (!injected && (source === f.paths.profile || destination === f.paths.profile)) {
        injected = true;
        await writeFile(f.paths.profile, edited);
      }
      return rename(source, destination);
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    const result = await refreshDesktopStatus(f.current);
    assert.equal(injected, true);
    assert.equal(await readFile(f.paths.profile, "utf8"), edited);
    assert.equal(result.configured, false);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
  });

  test(`${platform} media rollback retains a user edit made after publication`, async (t) => {
    const f = await fixture(t, platform);
    let edited = "";
    const result = await refreshDesktopStatus({ ...f.current, copyDirectory: async () => {
      const profile = JSON.parse(await readFile(f.paths.profile, "utf8"));
      edited = JSON.stringify({ ...profile, userSetting: "concurrent edit" });
      await writeFile(f.paths.profile, edited);
      throw new Error("fixture-secret");
    } });
    assert.equal(await readFile(f.paths.profile, "utf8"), edited);
    assert.equal(result.configured, false);
    assert.equal(result.diagnostics.find(item => item.code === "profile")?.status, "warning");
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
  });

  test(`${platform} Agent rescan preserves the startup Profile rollback guard until Profile setup succeeds`, async (t) => {
    const f = await fixture(t, platform);
    let edited = "";
    const startup = await refreshDesktopStatus({ ...f.current, copyDirectory: async () => {
      const published = JSON.parse(await readFile(f.paths.profile, "utf8"));
      edited = JSON.stringify({ ...published, userSetting: "concurrent edit" });
      await writeFile(f.paths.profile, edited);
      throw new Error("fixture-secret");
    } });
    assert.equal(startup.configured, false);
    assert.equal(startup.diagnostics.find(item => item.code === "profile" && item.path === f.paths.profile)?.status, "warning");
    assert.equal(await readFile(f.paths.profile, "utf8"), edited);

    const lifecycle = createDesktopStatusLifecycle(f.current, startup);
    let diagnosticsCalls = 0;
    const controller = createSetupController({ getStatus: lifecycle.getStatus,
      commit: async value => {
        const result = await commitDesktopSetup(value, { paths: f.paths, targets: lifecycle.integration.targets, platform,
          credentialStore: { owns: () => true, resolve: async () => undefined, put: async () => {}, delete: async () => false },
          media: f.current.media,
          connectionTest: { fetch: async url => String(url).endsWith("/models") ? Response.json({ data: [{ id: "model" }] }) : new Response("HY"),
            randomUUID: () => "00000000-0000-4000-8000-000000000001",
            createOssClient: () => ({ put: async () => {}, signatureUrl: () => "https://oss.example/probe", delete: async () => {} }) } });
        lifecycle.profileCommitted();
        return result;
      },
      install: () => installDesktopIntegration(lifecycle.integration),
      refreshAgents: lifecycle.refreshAgents,
      diagnose: async () => { diagnosticsCalls++; return []; },
      openConfig: async () => {}, clear: lifecycle.getStatus });
    const before = await controller.getStatus();
    assert.equal(before.ok, true);
    if (!before.ok) return;
    assert.equal(before.value.configured, false);
    assert.equal(before.value.diagnostics.find(item => item.code === "profile" && item.path === f.paths.profile)?.status, "warning");
    const refreshed = await controller.refreshAgentIntegration();
    assert.equal(refreshed.ok, true);
    if (!refreshed.ok) return;
    assert.equal(refreshed.value.configured, false);
    assert.equal(refreshed.value.diagnostics.find(item => item.code === "profile" && item.path === f.paths.profile)?.status, "warning");
    assert.equal(diagnosticsCalls, 0);
    const stillGuarded = await controller.getStatus();
    assert.equal(stillGuarded.ok, true);
    if (stillGuarded.ok) assert.equal(stillGuarded.value.configured, false);
    assert.equal(await readFile(f.paths.profile, "utf8"), edited);
    for (const item of refreshed.value.diagnostics.filter(item => item.reason === "CLEANUP_INCOMPLETE" && item.path?.includes(".recovery-"))) {
      assert.equal(refreshed.value.diagnostics.filter(other => other.code === item.code && other.path === item.path && other.reason === item.reason).length, 1);
    }
    const repaired = await controller.submit({ baseUrl: "https://api.example/v1", apiKey: "replacement-key", relay: {
      enabled: true, endpoint: "oss.example", bucket: "test-bucket", accessKeyId: "replacement-id", accessKeySecret: "replacement-secret",
    } });
    assert.equal(repaired.ok, true, JSON.stringify(repaired));
    assert.equal(diagnosticsCalls, 1);
    const afterRepair = await controller.getStatus();
    assert.equal(afterRepair.ok, true);
    if (afterRepair.ok) {
      assert.equal(afterRepair.value.configured, true);
      assert.equal(afterRepair.value.diagnostics.find(item => item.code === "profile" && item.path === f.paths.profile)?.status, "pass");
    }
  });

  test(`${platform} moved app refresh replaces proven managed media paths after the old app is gone`, async (t) => {
    const f = await fixture(t, platform);
    const before = JSON.parse(await readFile(f.paths.profile, "utf8"));
    await rm(f.old.appDirectory, { recursive: true });
    const result = await refreshDesktopStatus(f.current);
    const after = JSON.parse(await readFile(f.paths.profile, "utf8"));
    for (const endpoint of ["media.local", "hyperframes.local"]) {
      assert.deepEqual(after.endpoints[endpoint].config, f.current.media);
      before.endpoints[endpoint].config = f.current.media;
    }
    assert.deepEqual(after, before);
    assert.equal(result.configured, true);
    assert.equal(result.relayVerified, false);
    assert.equal(result.diagnostics.find(item => item.code === "ffmpeg")?.status, "pass");
  });

  test(`${platform} moved app preserves custom media paths while updating only proven managed fields`, async (t) => {
    const f = await fixture(t, platform);
    const custom = join(f.current.home, "custom-ffmpeg");
    await writeFile(custom, "custom user binary");
    const saved = JSON.parse(await readFile(f.paths.profile, "utf8"));
    saved.endpoints["media.local"].config.ffmpegPath = custom;
    saved.endpoints["hyperframes.local"].config = { ...saved.endpoints["hyperframes.local"].config, userSetting: "keep" };
    await writeFile(f.paths.profile, JSON.stringify(saved));
    await rm(f.old.appDirectory, { recursive: true });
    const result = await refreshDesktopStatus(f.current);
    const after = JSON.parse(await readFile(f.paths.profile, "utf8"));
    assert.equal(after.endpoints["media.local"].config.ffmpegPath, custom);
    assert.equal(after.endpoints["media.local"].config.ffprobePath, f.current.media.ffprobePath);
    assert.equal(after.endpoints["hyperframes.local"].config.userSetting, "keep");
    assert.equal(result.configured, true);
  });

  test(`${platform} media migration rolls back profile and integration together when Skill copy fails`, async (t) => {
    const f = await fixture(t, platform);
    const files = [f.paths.profile, f.paths.launcher, f.paths.managedState, join(f.paths.portableSkill, "SKILL.md"), join(f.paths.portableSkill, SKILL_MARKER),
      ...(platform === "darwin" ? [join(f.current.home, ".zprofile")] : [])];
    const before = await Promise.all(files.map(file => readFile(file)));
    const beforePath = f.readPath();
    let profileWasMigrated = false;
    const result = await refreshDesktopStatus({ ...f.current, copyDirectory: async () => {
      profileWasMigrated = JSON.parse(await readFile(f.paths.profile, "utf8")).endpoints["media.local"].config.ffmpegPath === f.current.media.ffmpegPath;
      throw new Error("fixture-secret");
    } });
    assert.equal(profileWasMigrated, true);
    assert.equal(result.configured, false);
    assert.deepEqual(await Promise.all(files.map(file => readFile(file))), before);
    assert.equal(f.readPath(), beforePath);
  });

  test(`${platform} a failed profile rollback is explicitly reported without exposing the OS error`, async (t) => {
    const f = await fixture(t, platform);
    const link = fs.link;
    let profileWrites = 0;
    const mock = t.mock.method(fs, "link", async (source: Parameters<typeof fs.link>[0], destination: Parameters<typeof fs.link>[1]) => {
      if (destination === f.paths.profile && ++profileWrites === 2) throw new Error("fixture-secret");
      return link(source, destination);
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    const result = await refreshDesktopStatus({ ...f.current, copyDirectory: async () => { throw new Error("fixture-secret"); } });
    assert.equal(profileWrites, 2);
    assert.equal(result.configured, false);
    assert.equal(result.diagnostics.find(item => item.code === "profile")?.status, "warning");
    const apparentlyReady = { ...await readDesktopStatus(f.current), configured: true, diagnostics: [] };
    assert.equal(reconcileStartupStatus(apparentlyReady, result).configured, false);
    assert.doesNotMatch(JSON.stringify(result), /fixture-secret/);
  });

  test(`${platform} missing media without matching managed launcher remains incomplete and preserves profile`, async (t) => {
    const f = await fixture(t, platform);
    // A user replaced the launcher's ownership record. The old app paths cannot be claimed.
    await rm(f.paths.managedState);
    await rm(f.old.appDirectory, { recursive: true });
    const saved = await readFile(f.paths.profile);
    const result = await refreshDesktopStatus(f.current);
    assert.equal(result.configured, false);
    assert.equal(result.diagnostics.find(item => item.code === "ffmpeg")?.status, "fail");
    assert.deepEqual(await readFile(f.paths.profile), saved);
  });

  test(`${platform} status cannot report ready while an explicitly configured custom media binary is missing`, async (t) => {
    const f = await fixture(t, platform);
    await installDesktopIntegration(f.current);
    const saved = createDesktopProfile(f.config, { ...f.current.media, ffmpegPath: join(f.current.home, "missing-custom-ffmpeg") });
    await writeFile(f.paths.profile, JSON.stringify(saved));
    const result = await readDesktopStatus(f.current);
    assert.equal(result.configured, false);
    assert.equal(result.diagnostics.find(item => item.code === "ffmpeg")?.status, "fail");
  });
}
