import { lstat } from "node:fs/promises";
import type { DesktopPaths } from "./paths.js";

export type DetectedAgentId = "codex" | "claymore-piko" | "cursor" | "claude-code";
export type AgentSkillTargetId = "portable" | "claude";
export type AgentScanResult = {
  readonly detectedAgents: readonly DetectedAgentId[];
  readonly targets: readonly AgentSkillTarget[];
};
export type AgentSkillTarget = {
  readonly id: AgentSkillTargetId;
  readonly label: "通用 Agent Skill" | "Claude Code Skill";
  readonly skillDirectory: string;
  readonly backupDirectory: string;
  readonly required: boolean;
  readonly detectedAgents: readonly DetectedAgentId[];
};

const pathExists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};

export const targetSummary = (target: AgentSkillTarget) => ({
  id: target.id,
  label: target.label,
  path: target.skillDirectory,
  detectedAgents: [...target.detectedAgents],
});

/** All supported destinations, including Agents absent from the current scan. */
export function supportedSkillTargets(paths: DesktopPaths): readonly AgentSkillTarget[] {
  return [
    { id: "portable", label: "通用 Agent Skill", skillDirectory: paths.portableSkill,
      backupDirectory: paths.portableSkillBackup, required: true, detectedAgents: [] },
    { id: "claude", label: "Claude Code Skill", skillDirectory: paths.claudeSkill,
      backupDirectory: paths.claudeSkillBackup, required: false, detectedAgents: [] },
  ];
}

export async function scanAgentTargets(options: {
  readonly paths: DesktopPaths;
  readonly exists?: (path: string) => Promise<boolean>;
}): Promise<AgentScanResult> {
  const has = options.exists ?? pathExists;
  const detectedAgents = (await Promise.all((Object.keys(options.paths.agentProbePaths) as DetectedAgentId[])
    .map(async (id) => [id, (await Promise.all(options.paths.agentProbePaths[id].map(has))).some(Boolean)] as const)))
    .filter(([, present]) => present).map(([id]) => id);
  const targets = supportedSkillTargets(options.paths)
    .filter(target => target.required || detectedAgents.includes("claude-code"))
    .map(target => ({ ...target, detectedAgents: detectedAgents.filter(id => target.id === "claude" ? id === "claude-code" : id !== "claude-code") }));
  return { detectedAgents, targets };
}
