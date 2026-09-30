import { installLauncher, launcherFiles, prepareLauncherRemoval, restoreFiles, snapshotFile, windowsUserPath } from "./launcher-install.js";
import type { FileSnapshot, LauncherOptions } from "./launcher-install.js";
import { supportedSkillTargets } from "./agent-targets.js";
import type { AgentSkillTarget } from "./agent-targets.js";
import { prepareLegacyCodexMigration, prepareSkillInstall, prepareSkillRemoval } from "./skill-install.js";
import type { PreparedRemoval, SkillInstallOptions } from "./skill-install.js";

export type DesktopIntegrationOptions = LauncherOptions & Omit<SkillInstallOptions, "target"> & {
  readonly targets: readonly AgentSkillTarget[];
};

const rollbackFailed = (error: unknown) => error instanceof Error
  && /\[(?:LAUNCHER|SKILL)_(?:INSTALL|REMOVE)_FAILED_ROLLBACK_FAILED\]$/u.test(error.message);
const ordered = (targets: readonly AgentSkillTarget[]) => [...targets].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

async function rollbackAll(operations: readonly PreparedRemoval[]): Promise<boolean> {
  let failed = false;
  for (const operation of [...operations].reverse()) {
    try { failed = await operation.rollback() || failed; } catch { failed = true; }
  }
  return failed;
}

async function disposeAll(operations: readonly PreparedRemoval[], committed: boolean): Promise<boolean> {
  let failed = false;
  for (const operation of [...operations].reverse()) {
    try { await operation.dispose(committed); } catch { failed = true; }
  }
  return failed;
}

/** Profile and credentials belong to setup-core and are deliberately outside this lifecycle. */
export async function installDesktopIntegration(options: DesktopIntegrationOptions): Promise<{ readonly restartMessage: string }> {
  const snapshots: FileSnapshot[] = [];
  const operations: PreparedRemoval[] = [];
  let oldPath: string | undefined;
  let launcherInstalled = false;
  let committed = false;
  let failure: string | undefined;
  let result: { readonly restartMessage: string } | undefined;
  const userPath = options.userPath ?? windowsUserPath;
  try {
    if (!options.targets.some(target => target.id === "portable")
      || new Set(options.targets.map(target => target.id)).size !== options.targets.length) throw new Error("Invalid targets");
    for (const path of launcherFiles(options)) snapshots.push(await snapshotFile(path));
    if (options.platform === "win32") oldPath = await userPath.read();
    for (const target of ordered(options.targets)) operations.push(await prepareSkillInstall({ ...options, target }));
    const legacy = await prepareLegacyCodexMigration(options.paths);
    if (legacy) operations.push(legacy);
    result = await installLauncher(options);
    launcherInstalled = true;
    for (const operation of operations) await operation.commit();
    committed = true;
  } catch (error) {
    let failed = await rollbackAll(operations) || rollbackFailed(error);
    if (launcherInstalled) {
      failed = (await restoreFiles(snapshots)) || failed;
      if (oldPath !== undefined) await userPath.write(oldPath).catch(() => { failed = true; });
    }
    failure = `INTEGRATION_INSTALL_FAILED${failed ? "_ROLLBACK_FAILED" : ""}`;
  }
  if (await disposeAll(operations, committed)) failure = committed ? "INTEGRATION_INSTALL_FAILED_CLEANUP_FAILED" : "INTEGRATION_INSTALL_FAILED_ROLLBACK_FAILED";
  if (failure) throw new Error(`桌面集成安装失败 [${failure}]`);
  return result!;
}

export async function removeDesktopIntegration(options: Pick<LauncherOptions, "paths" | "platform" | "home" | "userPath">): Promise<void> {
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
  } catch {
    const failed = await rollbackAll([...(launcher ? [launcher] : []), ...skills]);
    failure = `INTEGRATION_REMOVE_FAILED${failed ? "_ROLLBACK_FAILED" : ""}`;
  }
  if (await disposeAll([...(launcher ? [launcher] : []), ...skills], committed)) failure = committed ? "INTEGRATION_REMOVE_FAILED_CLEANUP_FAILED" : "INTEGRATION_REMOVE_FAILED_ROLLBACK_FAILED";
  if (failure) throw new Error(`桌面集成卸载失败 [${failure}]`);
}
