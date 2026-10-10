import assert from "node:assert/strict";
import test from "node:test";

import { scanAgentTargets, targetSummary } from "../src/agent-targets.js";
import { desktopPaths } from "../src/paths.js";

const darwinPaths = () => desktopPaths({
  platform: "darwin",
  home: "/Users/tester",
  appData: "/Users/tester/Library/Application Support",
});

test("no detected Agent still selects the portable target", async () => {
  const paths = darwinPaths();
  const scan = await scanAgentTargets({ paths, exists: async () => false });
  assert.deepEqual(scan.detectedAgents, []);
  assert.deepEqual(scan.targets.map((target) => target.id), ["portable"]);
  assert.deepEqual(scan.targets[0], {
    id: "portable",
    label: "通用 Agent Skill",
    skillDirectory: paths.portableSkill,
    backupDirectory: paths.portableSkillBackup,
    required: true,
    detectedAgents: [],
  });
});

test("Codex, Piko and Cursor share portable while Claude adds one compatibility target", async () => {
  const paths = darwinPaths();
  const present = new Set(Object.values(paths.agentProbePaths).map((probePaths) => probePaths[0]!));
  const scan = await scanAgentTargets({ paths, exists: async (path) => present.has(path) });
  assert.deepEqual(scan.detectedAgents, ["codex", "claymore-piko", "cursor", "claude-code"]);
  assert.deepEqual(scan.targets.map((target) => target.id), ["portable", "claude"]);
  assert.deepEqual(scan.targets[0]?.detectedAgents, ["codex", "claymore-piko", "cursor"]);
  assert.deepEqual(scan.targets[1], {
    id: "claude",
    label: "Claude Code Skill",
    skillDirectory: paths.claudeSkill,
    backupDirectory: paths.claudeSkillBackup,
    required: false,
    detectedAgents: ["claude-code"],
  });
});

test("Claude alone adds its compatibility target and summaries expose public fields", async () => {
  const paths = darwinPaths();
  const scan = await scanAgentTargets({
    paths,
    exists: async (path) => path === paths.agentProbePaths["claude-code"][0],
  });
  assert.deepEqual(scan.detectedAgents, ["claude-code"]);
  assert.deepEqual(scan.targets.map((target) => target.id), ["portable", "claude"]);
  assert.deepEqual(scan.targets[0]?.detectedAgents, []);
  assert.deepEqual(targetSummary(scan.targets[1]!), {
    id: "claude",
    label: "Claude Code Skill",
    path: paths.claudeSkill,
    detectedAgents: ["claude-code"],
  });
});

test("a probe error is surfaced rather than treated as absence", async () => {
  const paths = darwinPaths();
  await assert.rejects(scanAgentTargets({
    paths,
    exists: async () => { throw new Error("probe failed"); },
  }), /probe failed/);
});
