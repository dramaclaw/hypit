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
    portableSkill: "/Users/tester/.agents/skills/hypit",
    portableSkillBackup: "/Users/tester/Library/Application Support/Hypit/desktop/skill-backup/portable/hypit",
    claudeSkill: "/Users/tester/.claude/skills/hypit",
    claudeSkillBackup: "/Users/tester/Library/Application Support/Hypit/desktop/skill-backup/claude/hypit",
    legacyCodexSkill: "/Users/tester/.codex/skills/hypit",
    legacyCodexSkillBackup: "/Users/tester/Library/Application Support/Hypit/desktop/skill-backup/hypit",
    skill: "/Users/tester/.codex/skills/hypit",
    skillBackup: "/Users/tester/Library/Application Support/Hypit/desktop/skill-backup/hypit",
    launcher: "/Users/tester/.local/bin/hypit",
    managedState: "/Users/tester/Library/Application Support/Hypit/desktop/managed-state.json",
    agentProbePaths: {
      codex: ["/Users/tester/.codex", "/Applications/Codex.app", "/Users/tester/Applications/Codex.app"],
      "claymore-piko": ["/Users/tester/Library/Application Support/Claymore Piko", "/Applications/Claymore Piko.app", "/Users/tester/Applications/Claymore Piko.app"],
      cursor: ["/Users/tester/.cursor", "/Applications/Cursor.app", "/Users/tester/Applications/Cursor.app"],
      "claude-code": ["/Users/tester/.claude", "/Applications/Claude.app", "/Users/tester/Applications/Claude.app"],
    },
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
    portableSkill: "C:\\Users\\tester\\.agents\\skills\\hypit",
    portableSkillBackup: "C:\\Users\\tester\\AppData\\Local\\Hypit\\desktop\\skill-backup\\portable\\hypit",
    claudeSkill: "C:\\Users\\tester\\.claude\\skills\\hypit",
    claudeSkillBackup: "C:\\Users\\tester\\AppData\\Local\\Hypit\\desktop\\skill-backup\\claude\\hypit",
    legacyCodexSkill: "C:\\Users\\tester\\.codex\\skills\\hypit",
    legacyCodexSkillBackup: "C:\\Users\\tester\\AppData\\Local\\Hypit\\desktop\\skill-backup\\hypit",
    skill: "C:\\Users\\tester\\.codex\\skills\\hypit",
    skillBackup: "C:\\Users\\tester\\AppData\\Local\\Hypit\\desktop\\skill-backup\\hypit",
    launcher: "C:\\Users\\tester\\AppData\\Local\\Hypit\\bin\\hypit.cmd",
    managedState: "C:\\Users\\tester\\AppData\\Local\\Hypit\\desktop\\managed-state.json",
    agentProbePaths: {
      codex: ["C:\\Users\\tester\\.codex", "C:\\Users\\tester\\AppData\\Local\\Programs\\Codex\\Codex.exe"],
      "claymore-piko": ["C:\\Users\\tester\\AppData\\Local\\Claymore Piko", "C:\\Users\\tester\\AppData\\Local\\Programs\\Claymore Piko\\Claymore Piko.exe"],
      cursor: ["C:\\Users\\tester\\.cursor", "C:\\Users\\tester\\AppData\\Local\\Programs\\cursor\\Cursor.exe"],
      "claude-code": ["C:\\Users\\tester\\.claude", "C:\\Users\\tester\\AppData\\Local\\Programs\\Claude\\Claude.exe"],
    },
  });
});

test("Windows probes use injected roaming Agent data for Claymore Piko", () => {
  const paths = desktopPaths({
    platform: "win32",
    home: "C:\\Users\\tester",
    appData: "C:\\Users\\tester\\AppData\\Local",
    agentData: "C:\\Users\\tester\\AppData\\Roaming",
  });
  assert.equal(paths.agentProbePaths["claymore-piko"][0], "C:\\Users\\tester\\AppData\\Roaming\\Claymore Piko");
  assert.equal(paths.portableSkill, "C:\\Users\\tester\\.agents\\skills\\hypit");
  assert.equal(paths.claudeSkill, "C:\\Users\\tester\\.claude\\skills\\hypit");
  assert.equal(paths.legacyCodexSkill, "C:\\Users\\tester\\.codex\\skills\\hypit");
  assert.equal(paths.portableSkillBackup.endsWith("skill-backup\\portable\\hypit"), true);
  assert.equal(paths.claudeSkillBackup.endsWith("skill-backup\\claude\\hypit"), true);
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
    skillTargets: [{
      id: "portable",
      label: "通用 Agent Skill",
      path: "/Users/tester/.agents/skills/hypit",
      detectedAgents: ["codex"],
    }],
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
