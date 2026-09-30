import { installLauncher, launcherFiles, prepareLauncherRemoval, restoreFiles, snapshotFile, windowsUserPath } from "./launcher-install.js";
import type { FileSnapshot, LauncherOptions } from "./launcher-install.js";
import { installManagedSkill, prepareSkillRemoval } from "./skill-install.js";
import type { LegacySkillInstallOptions, PreparedRemoval, SkillInstallOptions } from "./skill-install.js";

/** @deprecated Task 4 removes LegacySkillInstallOptions after lifecycle targets are explicit. */
export type DesktopIntegrationOptions = LauncherOptions & (SkillInstallOptions | LegacySkillInstallOptions);

const rollbackFailed = (error: unknown) => error instanceof Error
  && /\[(?:LAUNCHER|SKILL)_(?:INSTALL|REMOVE)_FAILED_ROLLBACK_FAILED\]$/u.test(error.message);

/** Profile and credentials belong to setup-core and are deliberately outside this lifecycle. */
export async function installDesktopIntegration(options: DesktopIntegrationOptions): Promise<{ readonly restartMessage: string }> {
  const snapshots: FileSnapshot[] = [];
  let oldPath: string | undefined;
  let launcherInstalled = false;
  const userPath = options.userPath ?? windowsUserPath;
  try {
    for (const path of launcherFiles(options)) snapshots.push(await snapshotFile(path));
    if (options.platform === "win32") oldPath = await userPath.read();
    const result = await installLauncher(options);
    launcherInstalled = true;
    await installManagedSkill(options);
    return result;
  } catch (error) {
    let failed = rollbackFailed(error);
    if (launcherInstalled) {
      failed = (await restoreFiles(snapshots)) || failed;
      if (oldPath !== undefined) await userPath.write(oldPath).catch(() => { failed = true; });
    }
    throw new Error(`桌面集成安装失败 [INTEGRATION_INSTALL_FAILED${failed ? "_ROLLBACK_FAILED" : ""}]`);
  }
}

export async function removeDesktopIntegration(options: Pick<LauncherOptions, "paths" | "platform" | "home" | "userPath">): Promise<void> {
  let skill: PreparedRemoval | undefined;
  let launcher: PreparedRemoval | undefined;
  let committed = false;
  try {
    skill = await prepareSkillRemoval(options);
    launcher = await prepareLauncherRemoval(options);
    await launcher?.commit();
    await skill?.commit();
    committed = true;
  } catch {
    const skillFailed = await skill?.rollback();
    const launcherFailed = await launcher?.rollback();
    throw new Error(`桌面集成卸载失败 [INTEGRATION_REMOVE_FAILED${skillFailed || launcherFailed ? "_ROLLBACK_FAILED" : ""}]`);
  } finally {
    await skill?.dispose(committed);
    await launcher?.dispose(committed);
  }
}
