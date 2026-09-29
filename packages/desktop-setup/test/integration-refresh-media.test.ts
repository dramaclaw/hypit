import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import type { TestContext } from "node:test";
import { completeNewApiSetup } from "@dramaclaw/provider-newapi";
import { desktopPaths } from "../src/paths.js";
import { createDesktopProfile } from "../src/profile.js";
import { installDesktopIntegration } from "../src/lifecycle.js";
import { readDesktopStatus, refreshDesktopStatus } from "../src/main.js";
import { SKILL_MARKER } from "../src/skill-install.js";

async function fixture(t: TestContext, platform: "darwin" | "win32") {
  const home = await mkdtemp(join(tmpdir(), "hypit-media-refresh-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const paths = desktopPaths({ platform: "darwin", home, appData: join(home, "appdata") });
  let path = "original PATH";
  const userPath = { read: async () => path, write: async (value: string) => { path = value; } };
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
    return { paths, platform, home, userPath, appDirectory, bundledBin, electronExecutable, cliEntry, sourceDirectory, installedVersion: name, media };
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
    const files = [f.paths.profile, f.paths.launcher, f.paths.managedState, join(f.paths.skill, "SKILL.md"), join(f.paths.skill, SKILL_MARKER),
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
    const rename = fs.rename;
    let profileWrites = 0;
    const mock = t.mock.method(fs, "rename", async (source: Parameters<typeof fs.rename>[0], destination: Parameters<typeof fs.rename>[1]) => {
      if (destination === f.paths.profile && ++profileWrites === 2) throw new Error("fixture-secret");
      return rename(source, destination);
    });
    syncBuiltinESMExports();
    t.after(() => { mock.mock.restore(); syncBuiltinESMExports(); });
    const result = await refreshDesktopStatus({ ...f.current, copyDirectory: async () => { throw new Error("fixture-secret"); } });
    assert.equal(profileWrites, 2);
    assert.equal(result.configured, false);
    assert.equal(result.diagnostics.find(item => item.code === "profile")?.status, "warning");
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
