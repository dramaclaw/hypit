import assert from "node:assert/strict";
import { posix, win32 } from "node:path";
import test from "node:test";

import { completeNewApiSetup, newApiDefaultBindings } from "@dramaclaw/provider-newapi";
import { parseLocalRuntimeProfile } from "@hypit/runtime-local";

import { createDesktopProfile } from "../src/profile.js";

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
