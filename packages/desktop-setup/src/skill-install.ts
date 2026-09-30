import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, readlink, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { AgentSkillTarget, AgentSkillTargetId } from "./agent-targets.js";
import type { DesktopPaths } from "./paths.js";

export const SKILL_MARKER = ".hypit-desktop-managed.json";
export type ManagedSkillMarker = {
  readonly format: "hypit.desktop-managed@2";
  readonly target: AgentSkillTargetId;
  readonly installedVersion: string;
  readonly sourceDigest: string;
  readonly backupDirectory?: string;
};
export type SkillInstallOptions = {
  readonly target: AgentSkillTarget;
  readonly sourceDirectory: string;
  readonly installedVersion: string;
  /** Automatic refresh must never take ownership of an existing user Skill. */
  readonly preserveExisting?: boolean;
  readonly copyDirectory?: (source: string, destination: string) => Promise<void>;
};

/** @deprecated Task 4 removes the single Codex path compatibility bridge. */
export type LegacySkillInstallOptions = Omit<SkillInstallOptions, "target"> & { readonly paths: DesktopPaths };

/** @deprecated Existing lifecycle callers still address the old Codex directory. */
function legacyTarget(paths: DesktopPaths): AgentSkillTarget {
  return { id: "portable", label: "通用 Agent Skill", skillDirectory: paths.legacyCodexSkill,
    backupDirectory: paths.legacyCodexSkillBackup, required: true, detectedAgents: [] };
}

function asTarget(value: AgentSkillTarget | DesktopPaths): AgentSkillTarget {
  return "skillDirectory" in value ? value : legacyTarget(value);
}

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function markerAt(target: AgentSkillTarget): Promise<ManagedSkillMarker | undefined> {
  const path = target.skillDirectory;
  if (!(await exists(path)) || (await lstat(path)).isSymbolicLink()) return undefined;
  const markerPath = join(path, SKILL_MARKER);
  if (!(await exists(markerPath))) return undefined;
  if (!(await lstat(markerPath)).isFile()) return undefined;
  let marker: ManagedSkillMarker;
  try { marker = JSON.parse(await readFile(markerPath, "utf8")); } catch { return undefined; }
  if (marker?.format !== "hypit.desktop-managed@2" || marker.target !== target.id
    || typeof marker.installedVersion !== "string" || !/^[a-f0-9]{64}$/u.test(marker.sourceDigest)
    || (marker.backupDirectory !== undefined && marker.backupDirectory !== target.backupDirectory)) return undefined;
  try { if (await treeDigest(path, true) !== marker.sourceDigest) return undefined; }
  catch { return undefined; }
  return marker;
}

async function treeDigest(root: string, installed = false): Promise<string> {
  if (!(await lstat(root)).isDirectory() || !(await lstat(join(root, "SKILL.md"))).isFile()
    || !(await lstat(join(root, "references"))).isDirectory()) throw new Error("Invalid Skill tree");
  const hash = createHash("sha256");
  async function visit(relative: string): Promise<void> {
    const path = join(root, relative);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("Unsupported Skill entry");
    hash.update(JSON.stringify([relative, info.isDirectory() ? "directory" : "file", info.isFile() ? info.size : 0]));
    if (info.isFile()) hash.update(await readFile(path));
    else for (const name of (await readdir(path)).sort()) {
      if (installed && relative === "" && name === SKILL_MARKER) continue;
      await visit(relative ? `${relative}/${name}` : name);
    }
  }
  await visit("");
  return hash.digest("hex");
}

type TreeSnapshot = { readonly dev: number; readonly ino: number; readonly digest: string };

/** Include every entry, including a marker or symlink, when guarding a live tree. */
async function snapshotTree(root: string): Promise<TreeSnapshot | undefined> {
  let top: Awaited<ReturnType<typeof lstat>>;
  try { top = await lstat(root); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  const hash = createHash("sha256");
  async function visit(path: string, relative: string): Promise<void> {
    const info = await lstat(path);
    if (info.isFile()) hash.update(JSON.stringify([relative, "file", createHash("sha256").update(await readFile(path)).digest("hex")]));
    else if (info.isSymbolicLink()) hash.update(JSON.stringify([relative, "symlink", await readlink(path)]));
    else if (info.isDirectory()) {
      hash.update(JSON.stringify([relative, "directory"]));
      for (const name of (await readdir(path)).sort()) await visit(join(path, name), relative ? `${relative}/${name}` : name);
    } else throw new Error("Unsupported Skill entry");
  }
  await visit(root, "");
  return { dev: top.dev, ino: top.ino, digest: hash.digest("hex") };
}

function sameSnapshot(left: TreeSnapshot | undefined, right: TreeSnapshot | undefined): boolean {
  return left === undefined ? right === undefined : right !== undefined
    && left.dev === right.dev && left.ino === right.ino && left.digest === right.digest;
}

async function matchesSnapshot(expected: TreeSnapshot | undefined, path: string): Promise<boolean> {
  try { return expected !== undefined && sameSnapshot(expected, await snapshotTree(path)); }
  catch { return false; }
}

async function cleanupOwned(entries: readonly { readonly path: string; readonly snapshot: TreeSnapshot | undefined }[], code: string): Promise<void> {
  for (const entry of entries) {
    if (await exists(entry.path) && !(await matchesSnapshot(entry.snapshot, entry.path))) throw new Error(code);
  }
  for (const entry of entries) {
    if (!(await exists(entry.path))) continue;
    if (!(await matchesSnapshot(entry.snapshot, entry.path))) throw new Error(code);
    await rm(entry.path, { recursive: true, force: true }).catch(() => {});
  }
}

/** Check ownership and installed content without exposing marker data to the renderer. */
export async function isManagedSkillInstalled(target: AgentSkillTarget, current?: Pick<SkillInstallOptions, "sourceDirectory" | "installedVersion">): Promise<boolean>;
/** @deprecated Task 4 removes the DesktopPaths overload. */
export async function isManagedSkillInstalled(paths: DesktopPaths, current?: Pick<SkillInstallOptions, "sourceDirectory" | "installedVersion">): Promise<boolean>;
export async function isManagedSkillInstalled(value: AgentSkillTarget | DesktopPaths, current?: Pick<SkillInstallOptions, "sourceDirectory" | "installedVersion">): Promise<boolean> {
  const target = asTarget(value);
  try {
    const marker = await markerAt(target);
    return !!marker?.installedVersion.trim()
      && await treeDigest(target.skillDirectory, true) === marker.sourceDigest
      && (!current || (marker.installedVersion === current.installedVersion
        && marker.sourceDigest === await treeDigest(current.sourceDirectory)));
  } catch { return false; }
}

export async function canRefreshManagedSkill(target: AgentSkillTarget): Promise<boolean>;
/** @deprecated Task 4 removes the DesktopPaths overload. */
export async function canRefreshManagedSkill(paths: DesktopPaths): Promise<boolean>;
export async function canRefreshManagedSkill(value: AgentSkillTarget | DesktopPaths): Promise<boolean> {
  const target = asTarget(value);
  try {
    if (!(await exists(target.skillDirectory))) return !(await exists(target.backupDirectory));
    if (!(await isManagedSkillInstalled(target))) return false;
    const marker = await markerAt(target);
    return marker?.backupDirectory === undefined || await exists(target.backupDirectory);
  } catch { return false; }
}

export type PreparedSkillInstall = PreparedRemoval & { readonly marker: ManagedSkillMarker };

/** Stage a verified Skill and any user backup without changing the live tree. */
export async function prepareSkillInstall(options: SkillInstallOptions): Promise<PreparedSkillInstall> {
  const { target } = options;
  const stage = `${target.skillDirectory}.stage-${randomUUID()}`;
  const previous = `${target.skillDirectory}.previous-${randomUUID()}`;
  const backupStage = `${target.backupDirectory}.stage-${randomUUID()}`;
  let moved = false;
  let backupCreated = false;
  let committed = false;
  let committedSnapshot: TreeSnapshot | undefined;
  let stageSnapshot: TreeSnapshot | undefined;
  let backupStageSnapshot: TreeSnapshot | undefined;
  let publishedBackupSnapshot: TreeSnapshot | undefined;
  let recoveryFailed = false;
  let prepared = false;
  try {
    if (!options.installedVersion || await exists(join(options.sourceDirectory, SKILL_MARKER))) throw new Error("Invalid source");
    const sourceDigest = await treeDigest(options.sourceDirectory);
    await mkdir(dirname(target.skillDirectory), { recursive: true });
    await (options.copyDirectory ?? ((source, destination) => cp(source, destination, { recursive: true, errorOnExist: true, force: false })))(options.sourceDirectory, stage);
    if (await treeDigest(stage) !== sourceDigest) throw new Error("Incomplete Skill copy");
    if (options.preserveExisting && !(await canRefreshManagedSkill(target))) throw new Error("User Skill must be preserved");
    const liveSnapshot = await snapshotTree(target.skillDirectory);
    const old = await markerAt(target);
    let backupDirectory = old?.backupDirectory;
    if (await exists(target.skillDirectory) && !old) {
      if (await exists(target.backupDirectory)) throw new Error("Backup already exists");
      await mkdir(dirname(target.backupDirectory), { recursive: true });
      await cp(target.skillDirectory, backupStage, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
      backupDirectory = target.backupDirectory;
    }
    if (!sameSnapshot(liveSnapshot, await snapshotTree(target.skillDirectory))) throw new Error("Skill changed during preparation");
    if (await exists(backupStage)) {
      const backupSnapshot = await snapshotTree(backupStage);
      if (backupSnapshot?.digest !== liveSnapshot?.digest) throw new Error("Incomplete Skill backup");
      backupStageSnapshot = backupSnapshot;
    }
    const marker: ManagedSkillMarker = { format: "hypit.desktop-managed@2", target: target.id, installedVersion: options.installedVersion,
      sourceDigest, ...(backupDirectory === undefined ? {} : { backupDirectory }) };
    await writeFile(join(stage, SKILL_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    stageSnapshot = await snapshotTree(stage);
    prepared = true;
    return {
      marker,
      async commit() {
        if (!sameSnapshot(liveSnapshot, await snapshotTree(target.skillDirectory))) throw new Error("Skill changed before commit");
        if (await exists(backupStage)) {
          if (!(await matchesSnapshot(backupStageSnapshot, backupStage))) throw new Error("Backup stage changed before commit");
          if (await exists(target.backupDirectory)) throw new Error("Backup already exists");
          await rename(backupStage, target.backupDirectory);
          backupCreated = true;
          publishedBackupSnapshot = await snapshotTree(target.backupDirectory);
          if (!sameSnapshot(backupStageSnapshot, publishedBackupSnapshot)) throw new Error("Backup changed during commit");
        }
        if (!sameSnapshot(liveSnapshot, await snapshotTree(target.skillDirectory))) throw new Error("Skill changed before commit");
        if (liveSnapshot) {
          if (await exists(previous)) throw new Error("Previous Skill path already exists");
          await rename(target.skillDirectory, previous);
          moved = true;
          if (!sameSnapshot(liveSnapshot, await snapshotTree(previous))) throw new Error("Skill changed during commit");
        }
        if (await exists(target.skillDirectory)) throw new Error("Skill appeared during commit");
        if (!(await matchesSnapshot(stageSnapshot, stage))) throw new Error("Skill stage changed before commit");
        await rename(stage, target.skillDirectory);
        committed = true;
        committedSnapshot = await snapshotTree(target.skillDirectory);
        if (!sameSnapshot(stageSnapshot, committedSnapshot)) throw new Error("Committed Skill changed");
      },
      async rollback() {
        const fail = () => { recoveryFailed = true; return true; };
        try {
          if (backupCreated && !(await matchesSnapshot(publishedBackupSnapshot, target.backupDirectory))) return fail();
          if (moved && !(await matchesSnapshot(liveSnapshot, previous))) return fail();
          if (!committed && !moved && backupCreated
            && !sameSnapshot(liveSnapshot, await snapshotTree(target.skillDirectory))) return fail();
          if (committed) {
            if (!committedSnapshot || !sameSnapshot(committedSnapshot, await snapshotTree(target.skillDirectory))
              || await exists(stage)) return fail();
            await rename(target.skillDirectory, stage);
            if (!sameSnapshot(committedSnapshot, await snapshotTree(stage))) {
              if (!(await exists(target.skillDirectory))) await rename(stage, target.skillDirectory).catch(() => {});
              return fail();
            }
            committed = false;
            stageSnapshot = committedSnapshot;
          }
          if (moved) {
            if (await exists(target.skillDirectory) || !(await matchesSnapshot(liveSnapshot, previous))) return fail();
            await rename(previous, target.skillDirectory);
            moved = false;
            if (!(await matchesSnapshot(liveSnapshot, target.skillDirectory))) return fail();
          }
          if (backupCreated) {
            if (!(await matchesSnapshot(publishedBackupSnapshot, target.backupDirectory))) return fail();
            await rm(target.backupDirectory, { recursive: true, force: true });
            backupCreated = false;
          }
          return false;
        } catch { return fail(); }
      },
      async dispose(succeeded) {
        if (recoveryFailed) {
          if (succeeded) throw new Error("Skill 安装失败 [SKILL_INSTALL_FAILED_CLEANUP_FAILED]");
          return;
        }
        if (!succeeded && (moved || committed)) return;
        if (succeeded && committed && !(await matchesSnapshot(committedSnapshot, target.skillDirectory)))
          throw new Error("Skill 安装失败 [SKILL_INSTALL_FAILED_CLEANUP_FAILED]");
        if (succeeded && backupCreated && !(await matchesSnapshot(publishedBackupSnapshot, target.backupDirectory)))
          throw new Error("Skill 安装失败 [SKILL_INSTALL_FAILED_CLEANUP_FAILED]");
        await cleanupOwned([
          ...(succeeded && moved ? [{ path: previous, snapshot: liveSnapshot }] : []),
          { path: stage, snapshot: stageSnapshot },
          { path: backupStage, snapshot: backupStageSnapshot },
        ], "Skill 安装失败 [SKILL_INSTALL_FAILED_CLEANUP_FAILED]");
      },
    };
  } catch {
    throw new Error("Skill 安装失败 [SKILL_INSTALL_FAILED]");
  } finally {
    // A successful prepare transfers ownership of these stages to dispose().
    if (!prepared) {
      await rm(stage, { recursive: true, force: true }).catch(() => {});
      await rm(backupStage, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Copy, commit, and finalize a single target when no outer transaction is needed. */
export async function installManagedSkill(options: SkillInstallOptions | LegacySkillInstallOptions): Promise<ManagedSkillMarker> {
  const prepared = await prepareSkillInstall("target" in options ? options : { ...options, target: legacyTarget(options.paths) });
  let committed = false;
  try {
    await prepared.commit();
    committed = true;
    return prepared.marker;
  } catch {
    const failed = await prepared.rollback();
    throw new Error(`Skill 安装失败 [SKILL_INSTALL_FAILED${failed ? "_ROLLBACK_FAILED" : ""}]`);
  } finally { await prepared.dispose(committed); }
}

export type PreparedRemoval = {
  readonly commit: () => Promise<void>;
  /** Return true when restoration is incomplete; retain recovery artifacts in that case. */
  readonly rollback: () => Promise<boolean>;
  /** Only discard the old installed tree and its backup after the whole operation commits. */
  readonly dispose: (committed: boolean) => Promise<void>;
};

/** Validate ownership and stage restoration before changing any installed component. */
export async function prepareSkillRemoval(options: { readonly target: AgentSkillTarget } | { readonly paths: DesktopPaths }): Promise<PreparedRemoval | undefined> {
  const target = "target" in options ? options.target : legacyTarget(options.paths);
  const previous = `${target.skillDirectory}.removed-${randomUUID()}`;
  const restoreStage = `${target.skillDirectory}.restore-${randomUUID()}`;
  let moved = false;
  let restored = false;
  let restoredLiveSnapshot: TreeSnapshot | undefined;
  let restoreStageSnapshot: TreeSnapshot | undefined;
  let recoveryFailed = false;
  try {
    const liveSnapshot = await snapshotTree(target.skillDirectory);
    const marker = await markerAt(target);
    if (!marker) return undefined;
    let backupSnapshot: TreeSnapshot | undefined;
    if (marker.backupDirectory !== undefined) {
      backupSnapshot = await snapshotTree(target.backupDirectory);
      if (!backupSnapshot) throw new Error("Invalid backup");
      await cp(target.backupDirectory, restoreStage, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
      restoreStageSnapshot = await snapshotTree(restoreStage);
      if (restoreStageSnapshot?.digest !== backupSnapshot.digest
        || !sameSnapshot(backupSnapshot, await snapshotTree(target.backupDirectory))) throw new Error("Backup changed during removal preparation");
    }
    if (!sameSnapshot(liveSnapshot, await snapshotTree(target.skillDirectory))) throw new Error("Skill changed during removal preparation");
    return {
      async commit() {
        if (!sameSnapshot(liveSnapshot, await snapshotTree(target.skillDirectory))) throw new Error("Skill changed before removal commit");
        if (backupSnapshot && !sameSnapshot(backupSnapshot, await snapshotTree(target.backupDirectory)))
          throw new Error("Backup changed before removal commit");
        if (backupSnapshot && !(await matchesSnapshot(restoreStageSnapshot, restoreStage)))
          throw new Error("Restore stage changed before removal commit");
        if (await exists(previous)) throw new Error("Removed Skill path already exists");
        await rename(target.skillDirectory, previous);
        moved = true;
        if (!sameSnapshot(liveSnapshot, await snapshotTree(previous))) throw new Error("Skill changed during removal commit");
        if (marker.backupDirectory !== undefined) {
          if (await exists(target.skillDirectory) || !(await matchesSnapshot(restoreStageSnapshot, restoreStage)))
            throw new Error("Restore stage changed during removal commit");
          await rename(restoreStage, target.skillDirectory);
          restored = true;
          restoredLiveSnapshot = await snapshotTree(target.skillDirectory);
          if (!sameSnapshot(restoreStageSnapshot, restoredLiveSnapshot)) throw new Error("Restored Skill changed during commit");
        }
      },
      async rollback() {
        const fail = () => { recoveryFailed = true; return true; };
        if (!moved) return false;
        try {
          if (!(await matchesSnapshot(liveSnapshot, previous))) return fail();
          if (restored) {
            if (!(await matchesSnapshot(restoredLiveSnapshot, target.skillDirectory)) || await exists(restoreStage)) return fail();
            await rename(target.skillDirectory, restoreStage);
            if (!(await matchesSnapshot(restoredLiveSnapshot, restoreStage))) {
              if (!(await exists(target.skillDirectory))) await rename(restoreStage, target.skillDirectory).catch(() => {});
              return fail();
            }
            restored = false;
            restoreStageSnapshot = restoredLiveSnapshot;
          }
          if (await exists(target.skillDirectory) || !(await matchesSnapshot(liveSnapshot, previous))) return fail();
          await rename(previous, target.skillDirectory);
          moved = false;
          if (!(await matchesSnapshot(liveSnapshot, target.skillDirectory))) return fail();
          return false;
        } catch { return fail(); }
      },
      async dispose(committed) {
        if (recoveryFailed) {
          if (committed) throw new Error("Skill 卸载失败 [SKILL_REMOVE_FAILED_CLEANUP_FAILED]");
          return;
        }
        if (committed) {
          if (restored && !(await matchesSnapshot(restoredLiveSnapshot, target.skillDirectory)))
            throw new Error("Skill 卸载失败 [SKILL_REMOVE_FAILED_CLEANUP_FAILED]");
          if (marker.backupDirectory !== undefined && !(await matchesSnapshot(backupSnapshot, target.backupDirectory)))
            throw new Error("Skill 卸载失败 [SKILL_REMOVE_FAILED_CLEANUP_FAILED]");
          if (!(await matchesSnapshot(liveSnapshot, previous)))
            throw new Error("Skill 卸载失败 [SKILL_REMOVE_FAILED_CLEANUP_FAILED]");
        }
        if (!committed && moved) return;
        await cleanupOwned([
          ...(committed ? [{ path: previous, snapshot: liveSnapshot }] : []),
          ...(committed && marker.backupDirectory !== undefined ? [{ path: target.backupDirectory, snapshot: backupSnapshot }] : []),
          { path: restoreStage, snapshot: restoreStageSnapshot },
        ], "Skill 卸载失败 [SKILL_REMOVE_FAILED_CLEANUP_FAILED]");
      },
    };
  } catch {
    await rm(restoreStage, { recursive: true, force: true }).catch(() => {});
    throw new Error("Skill 卸载失败 [SKILL_REMOVE_FAILED]");
  }
}

export async function removeManagedSkill(options: { readonly target: AgentSkillTarget } | { readonly paths: DesktopPaths }): Promise<boolean> {
  let removal: PreparedRemoval | undefined;
  let committed = false;
  try {
    removal = await prepareSkillRemoval(options);
    if (!removal) return false;
    await removal.commit();
    committed = true;
    return true;
  } catch {
    const failed = await removal?.rollback();
    throw new Error(`Skill 卸载失败 [SKILL_REMOVE_FAILED${failed ? "_ROLLBACK_FAILED" : ""}]`);
  } finally { await removal?.dispose(committed); }
}
