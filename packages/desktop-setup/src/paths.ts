import { posix, win32 } from "node:path";
import type { DetectedAgentId } from "./agent-targets.js";

export type DesktopPaths = {
  readonly hostState: string;
  readonly profile: string;
  readonly portableSkill: string;
  readonly portableSkillBackup: string;
  readonly claudeSkill: string;
  readonly claudeSkillBackup: string;
  readonly legacyCodexSkill: string;
  readonly legacyCodexSkillBackup: string;
  readonly launcher: string;
  readonly managedState: string;
  readonly agentProbePaths: Readonly<Record<DetectedAgentId, readonly string[]>>;
};

export type DesktopPathOptions = {
  readonly platform: "darwin" | "win32";
  readonly home: string;
  /** The user's application data root (Local AppData on Windows). */
  readonly appData: string;
  /** Agent application data root (Roaming AppData on Windows); defaults to appData. */
  readonly agentData?: string;
};

export function desktopPaths(options: DesktopPathOptions): DesktopPaths {
  const path = options.platform === "win32" ? win32 : posix;
  const hostState = path.join(options.appData, "Hypit");
  const desktopState = path.join(hostState, "desktop");
  const legacyCodexSkill = path.join(options.home, ".codex", "skills", "hypit");
  const legacyCodexSkillBackup = path.join(desktopState, "skill-backup", "hypit");
  const macApplications = (name: string) => [
    path.join("/Applications", `${name}.app`),
    path.join(options.home, "Applications", `${name}.app`),
  ];
  const windowsProgram = (folder: string, executable: string) =>
    path.join(options.appData, "Programs", folder, executable);
  const agentProbePaths: DesktopPaths["agentProbePaths"] = options.platform === "darwin" ? {
    codex: [path.join(options.home, ".codex"), ...macApplications("Codex")],
    "claymore-piko": [path.join(options.agentData ?? options.appData, "Claymore Piko"), ...macApplications("Claymore Piko")],
    cursor: [path.join(options.home, ".cursor"), ...macApplications("Cursor")],
    "claude-code": [path.join(options.home, ".claude"), ...macApplications("Claude")],
  } : {
    codex: [path.join(options.home, ".codex"), windowsProgram("Codex", "Codex.exe")],
    "claymore-piko": [path.join(options.agentData ?? options.appData, "Claymore Piko"), windowsProgram("Claymore Piko", "Claymore Piko.exe")],
    cursor: [path.join(options.home, ".cursor"), windowsProgram("cursor", "Cursor.exe")],
    "claude-code": [path.join(options.home, ".claude"), windowsProgram("Claude", "Claude.exe")],
  };
  return {
    hostState,
    profile: path.join(hostState, "profiles", "desktop-newapi.json"),
    portableSkill: path.join(options.home, ".agents", "skills", "hypit"),
    portableSkillBackup: path.join(desktopState, "skill-backup", "portable", "hypit"),
    claudeSkill: path.join(options.home, ".claude", "skills", "hypit"),
    claudeSkillBackup: path.join(desktopState, "skill-backup", "claude", "hypit"),
    legacyCodexSkill,
    legacyCodexSkillBackup,
    launcher: options.platform === "darwin"
      ? path.join(options.home, ".local", "bin", "hypit")
      : path.join(hostState, "bin", "hypit.cmd"),
    managedState: path.join(desktopState, "managed-state.json"),
    agentProbePaths,
  };
}
