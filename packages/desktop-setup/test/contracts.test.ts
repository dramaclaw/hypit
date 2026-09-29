import assert from "node:assert/strict";
import test from "node:test";

import type { DiagnosticItem, SetupInput, SetupProgress, SetupResult } from "../src/contracts.js";
import { desktopPaths } from "../src/paths.js";

type ExpectFalse<Value extends false> = Value;
type DisabledRelayIsAccepted = { baseUrl: string; apiKey: string; relay: { enabled: false } } extends SetupInput
  ? true : false;
type RejectDisabledRelay = ExpectFalse<DisabledRelayIsAccepted>;

test("Darwin desktop paths stay under the injected user locations", () => {
  const paths = desktopPaths({
    platform: "darwin",
    home: "/Users/tester",
    appData: "/Users/tester/Library/Application Support",
  });

  assert.deepEqual(paths, {
    hostState: "/Users/tester/Library/Application Support/Hypit",
    profile: "/Users/tester/Library/Application Support/Hypit/profiles/desktop-newapi.json",
    skill: "/Users/tester/.codex/skills/hypit",
    skillBackup: "/Users/tester/Library/Application Support/Hypit/desktop/skill-backup/hypit",
    launcher: "/Users/tester/.local/bin/hypit",
    managedState: "/Users/tester/Library/Application Support/Hypit/desktop/managed-state.json",
  });
});

test("Windows desktop paths use Windows separators and a current-user launcher", () => {
  const paths = desktopPaths({
    platform: "win32",
    home: "C:\\Users\\tester",
    appData: "C:\\Users\\tester\\AppData\\Local",
  });

  assert.deepEqual(paths, {
    hostState: "C:\\Users\\tester\\AppData\\Local\\Hypit",
    profile: "C:\\Users\\tester\\AppData\\Local\\Hypit\\profiles\\desktop-newapi.json",
    skill: "C:\\Users\\tester\\.codex\\skills\\hypit",
    skillBackup: "C:\\Users\\tester\\AppData\\Local\\Hypit\\desktop\\skill-backup\\hypit",
    launcher: "C:\\Users\\tester\\AppData\\Local\\Hypit\\bin\\hypit.cmd",
    managedState: "C:\\Users\\tester\\AppData\\Local\\Hypit\\desktop\\managed-state.json",
  });
});

test("public results and progress do not echo any submitted setup value", () => {
  const input = {
    baseUrl: "https://newapi.secret-input.example/v1",
    apiKey: "newapi-secret-key-123",
    relay: {
      enabled: true,
      endpoint: "oss-secret-endpoint.example",
      bucket: "secret-bucket-123",
      accessKeyId: "secret-access-key-id-123",
      accessKeySecret: "secret-access-key-secret-123",
    },
  } satisfies SetupInput;
  const diagnostic: DiagnosticItem = {
    code: "profile",
    status: "pass",
    label: "Runtime Profile",
    path: "/Users/tester/Library/Application Support/Hypit/profiles/desktop-newapi.json",
  };
  const progress: readonly SetupProgress[] = [
    { kind: "stage", stage: "testing-newapi" },
    { kind: "model-count", count: 3 },
    { kind: "diagnostic", item: diagnostic },
  ];
  const result: SetupResult = {
    configured: true,
    modelCount: 3,
    relayVerified: true,
    profilePath: diagnostic.path!,
    skillPath: "/Users/tester/.codex/skills/hypit",
    launcherPath: "/Users/tester/.local/bin/hypit",
    diagnostics: [diagnostic],
  };

  for (const fixture of [diagnostic, ...progress, result]) {
    const serialized = JSON.stringify(fixture);
    for (const submitted of [
      input.baseUrl,
      input.apiKey,
      input.relay.endpoint,
      input.relay.bucket,
      input.relay.accessKeyId,
      input.relay.accessKeySecret,
    ]) {
      assert.equal(serialized.includes(submitted), false);
    }
  }
});
