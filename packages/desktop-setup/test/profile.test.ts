import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";

import { completeNewApiSetup, newApiDefaultBindings, newApiRoutes } from "@dramaclaw/provider-newapi";
import { parseLocalRuntimeProfile } from "@hypit/runtime-local";

import { createDesktopProfile, prepareDesktopNewApiBindingsRefresh } from "../src/profile.js";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

test("desktop media providers use both packaged tools explicitly", () => {
  const profile = createDesktopProfile({}, { ffmpegPath: "/Applications/Hypit Setup.app/bin/ffmpeg", ffprobePath: "/Applications/Hypit Setup.app/bin/ffprobe" }) as any;
  for (const endpoint of ["media.local", "hyperframes.local"]) assert.deepEqual(profile.endpoints[endpoint].config, { ffmpegPath: "/Applications/Hypit Setup.app/bin/ffmpeg", ffprobePath: "/Applications/Hypit Setup.app/bin/ffprobe" });
});

test("desktop profile uses host-relative runtime data and only credential references", () => {
  const secrets = ["test-api-secret", "test-oss-access-key", "test-oss-secret"];
  const { config } = completeNewApiSetup({
    baseUrl: "https://newapi.example/v1/",
    apiKey: secrets[0]!,
    relay: { enabled: true, endpoint: "oss.example", bucket: "test-bucket",
      accessKeyId: secrets[1]!, accessKeySecret: secrets[2]! },
  });
  const profile = createDesktopProfile(config) as {
    format: string; dataRoot: string; credentials: unknown; bindings: unknown;
    endpoints: Record<string, { use: string; config: { apiKey: { key: string } } }>;
  };

  assert.equal(profile.format, "hypit.runtime-local@1");
  assert.equal(profile.dataRoot, "../runtimes/desktop-newapi");
  assert.equal(posix.isAbsolute(profile.dataRoot), false);
  assert.equal(win32.isAbsolute(profile.dataRoot), false);
  assert.deepEqual(profile.credentials, { platform: { use: "@hypit/credential-store-platform" } });
  assert.deepEqual(profile.bindings, newApiDefaultBindings);
  assert.deepEqual(Object.keys(profile.endpoints).sort(), ["hyperframes.local", "media.local", "newapi.personal"]);
  assert.equal(profile.endpoints["newapi.personal"]!.use, "@dramaclaw/provider-newapi");
  assert.equal(profile.endpoints["newapi.personal"]!.config.apiKey.key, "newapi.personal.api-key");
  assert.deepEqual(profile.endpoints["newapi.personal"]!.config, config);
  assert.equal(profile.endpoints["media.local"]!.use, "@hypit/provider-media-local");
  assert.equal(profile.endpoints["hyperframes.local"]!.use, "@hypit/provider-hyperframes-local");
  assert.doesNotThrow(() => parseLocalRuntimeProfile(profile));
  for (const secret of secrets) assert.equal(JSON.stringify(profile).includes(secret), false);
});

test("existing desktop profile gains all missing NewAPI speech bindings without changing custom settings", async t => {
  const home = await mkdtemp(join(tmpdir(), "hypit-speech-refresh-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "profiles", "desktop-newapi.json");
  await mkdir(dirname(path), { recursive: true });
  const profile = createDesktopProfile({}, undefined) as any;
  const key = "@hypit/whisperx@1#whisperx-alignment";
  for (const capability of Object.keys(newApiDefaultBindings)) if (!newApiRoutes.some(route => route.key === capability)) delete profile.bindings[capability];
  profile.custom = { keep: "user-value" };
  await writeFile(path, JSON.stringify(profile));
  const prepared = await prepareDesktopNewApiBindingsRefresh({ profile: path, platform: "darwin" });
  assert.ok(prepared);
  await prepared.commit();
  await prepared.dispose(true);
  const updated = JSON.parse(await readFile(path, "utf8"));
  assert.equal(updated.bindings[key], "newapi.personal");
  assert.deepEqual(updated.bindings, newApiDefaultBindings);
  assert.deepEqual(updated.custom, { keep: "user-value" });
  updated.bindings[key] = "custom.speech";
  await writeFile(path, JSON.stringify(updated));
  assert.equal(await prepareDesktopNewApiBindingsRefresh({ profile: path, platform: "darwin" }), undefined);
  assert.equal((await readFile(path, "utf8")).includes("custom.speech"), true);
});

test("managed legacy local WhisperX binding migrates; modified local provider remains untouched", async t => {
  const home = await mkdtemp(join(tmpdir(), "hypit-managed-speech-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const path = join(home, "desktop-newapi.json");
  const profile = createDesktopProfile({}) as any;
  const key = "@hypit/whisperx@1#whisperx-alignment";
  profile.bindings[key] = "whisperx.local";
  profile.endpoints["whisperx.local"] = { use: "@hypit/provider-whisperx-local", pool: "whisperx.local", config: {
    expectedModel: "small", expectedDevice: "cpu", expectedCompute: "int8", alignmentLanguages: ["zh", "en"],
  } };
  await writeFile(path, JSON.stringify(profile));
  const prepared = await prepareDesktopNewApiBindingsRefresh({ profile: path, platform: "darwin" });
  assert.ok(prepared);
  await prepared.commit(); await prepared.dispose(true);
  const migrated = JSON.parse(await readFile(path, "utf8"));
  assert.equal(migrated.bindings[key], "newapi.personal");
  assert.equal(migrated.endpoints["whisperx.local"], undefined);
  profile.endpoints["whisperx.local"].config.expectedModel = "custom";
  await writeFile(path, JSON.stringify(profile));
  assert.equal(await prepareDesktopNewApiBindingsRefresh({ profile: path, platform: "darwin" }), undefined);
  assert.equal(JSON.parse(await readFile(path, "utf8")).bindings[key], "whisperx.local");
});
