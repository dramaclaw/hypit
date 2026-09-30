import { prepareLauncherInstall, prepareLauncherRemoval } from "./launcher-install.js";
import type { LauncherOptions } from "./launcher-install.js";
import { supportedSkillTargets } from "./agent-targets.js";
import type { AgentSkillTarget } from "./agent-targets.js";
import { isBackupUnavailable, prepareLegacyCodexMigration, prepareSkillInstall, prepareSkillRemoval } from "./skill-install.js";
import type { PreparedRemoval, SkillInstallOptions } from "./skill-install.js";
import type { DiagnosticItem } from "./contracts.js";

export type DesktopIntegrationOptions = LauncherOptions & Omit<SkillInstallOptions, "target"> & {
  readonly targets: readonly AgentSkillTarget[];
};

const rollbackFailed = (error: unknown) => error instanceof Error
  && /\[(?:(?:LAUNCHER|SKILL)_(?:INSTALL|REMOVE)_FAILED|SKILL_BACKUP_UNAVAILABLE)_ROLLBACK_FAILED\]$/u.test(error.message);
const ordered = (targets: readonly AgentSkillTarget[]) => [...targets].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

async function rollbackAll(operations: readonly PreparedRemoval[]): Promise<boolean> {
  let failed = false;
  for (const operation of [...operations].reverse()) {
    try { failed = await operation.rollback() || failed; } catch { failed = true; }
  }
  return failed;
}

async function disposeAll(operations: readonly PreparedRemoval[], committed: boolean): Promise<readonly DiagnosticItem[]> {
  const warnings: DiagnosticItem[] = [];
  for (const operation of [...operations].reverse()) {
    try { warnings.push(...await operation.dispose(committed)); }
    catch { warnings.push({ code: "skill", label: "通用 Agent Skill", target: "portable", status: "warning", reason: "CLEANUP_INCOMPLETE" }); }
  }
  return warnings;
}

/** Profile and credentials belong to setup-core and are deliberately outside this lifecycle. */
export async function installDesktopIntegration(options: DesktopIntegrationOptions): Promise<{ readonly restartMessage: string; readonly diagnostics: readonly DiagnosticItem[] }> {
  const operations: PreparedRemoval[] = [];
  let launcher: PreparedRemoval | undefined;
  let committed = false;
  let failure: string | undefined;
  let result: { readonly restartMessage: string } | undefined;
  try {
    if (!options.targets.some(target => target.id === "portable")
      || new Set(options.targets.map(target => target.id)).size !== options.targets.length) throw new Error("Invalid targets");
    for (const target of ordered(options.targets)) operations.push(await prepareSkillInstall({ ...options, target }));
    const legacy = await prepareLegacyCodexMigration(options.paths);
    if (legacy) operations.push(legacy);
    const preparedLauncher = await prepareLauncherInstall(options);
    launcher = preparedLauncher;
    await launcher.commit();
    result = { restartMessage: preparedLauncher.restartMessage };
    for (const operation of operations) await operation.commit();
    committed = true;
  } catch (error) {
    let failed = await rollbackAll(operations) || rollbackFailed(error);
    if (launcher) failed = await rollbackAll([launcher]) || failed;
    failure = !failed && isBackupUnavailable(error) ? "SKILL_BACKUP_UNAVAILABLE" : `INTEGRATION_INSTALL_FAILED${failed ? "_ROLLBACK_FAILED" : ""}`;
  }
  const diagnostics = await disposeAll([...(launcher ? [launcher] : []), ...operations], committed);
  if (!committed && diagnostics.length) failure = "INTEGRATION_INSTALL_FAILED_ROLLBACK_FAILED";
  if (failure) throw new Error(`桌面集成安装失败 [${failure}]`);
  return { ...result!, diagnostics };
}

export async function removeDesktopIntegration(options: Pick<LauncherOptions, "paths" | "platform" | "home" | "userPath">): Promise<{ readonly diagnostics: readonly DiagnosticItem[] }> {
  const skills: PreparedRemoval[] = [];
  let launcher: PreparedRemoval | undefined;
  let committed = false;
  let failure: string | undefined;
  try {
    // Enumerate supported targets independently of whether their Agent still exists.
    for (const target of ordered(supportedSkillTargets(options.paths))) {
      const removal = await prepareSkillRemoval({ target });
      if (removal) skills.push(removal);
    }
    const legacy = await prepareLegacyCodexMigration(options.paths);
    if (legacy) skills.push(legacy);
    launcher = await prepareLauncherRemoval(options);
    await launcher?.commit();
    for (const skill of skills) await skill.commit();
    committed = true;
  } catch (error) {
    const failed = await rollbackAll([...(launcher ? [launcher] : []), ...skills]) || rollbackFailed(error);
    failure = !failed && isBackupUnavailable(error) ? "SKILL_BACKUP_UNAVAILABLE" : `INTEGRATION_REMOVE_FAILED${failed ? "_ROLLBACK_FAILED" : ""}`;
  }
  const diagnostics = await disposeAll([...(launcher ? [launcher] : []), ...skills], committed);
  if (!committed && diagnostics.length) failure = "INTEGRATION_REMOVE_FAILED_ROLLBACK_FAILED";
  if (failure) throw new Error(`桌面集成卸载失败 [${failure}]`);
  return { diagnostics };
}
