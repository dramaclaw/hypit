import { createHash, randomUUID } from "node:crypto";
import { cp, link, lstat, mkdir, readFile, readdir, readlink, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
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

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function markerAt(target: AgentSkillTarget): Promise<ManagedSkillMarker | undefined> {
  const path = target.skillDirectory;
  if (!(await exists(path)) || !(await lstat(path)).isDirectory()) return undefined;
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

async function cleanupFailedPreparation(entries: readonly { readonly path: string; readonly snapshot: TreeSnapshot | undefined }[]): Promise<string[]> {
  const retained: string[] = [];
  for (const entry of entries) {
    try {
      if (!(await exists(entry.path))) continue;
      if (!(await matchesSnapshot(entry.snapshot, entry.path))) { retained.push(entry.path); continue; }
      await rm(entry.path, { recursive: true, force: true });
    } catch { retained.push(entry.path); }
  }
  return retained;
}

function preparationFailure(label: string, code: string, retained: readonly string[]): Error {
  return new Error(`${label}${retained.length ? `; recovery: ${retained.join(", ")}` : ""} [${code}]`);
}

/** Files and links are published with atomic no-replace creation; directories use a boundary check. */
async function publishNoReplace(source: string, destination: string): Promise<boolean> {
  const info = await lstat(source);
  if (info.isSymbolicLink()) {
    await symlink(await readlink(source), destination, "dir");
    await unlink(source).catch(() => {});
    return false;
  }
  if (info.isFile()) {
    await link(source, destination);
    await unlink(source).catch(() => {});
    return true;
  }
  if (info.isDirectory()) {
    if (await exists(destination)) throw new Error("Publication destination exists");
    await rename(source, destination);
    return true;
  }
  throw new Error("Unsupported Skill entry");
}

function publishedMatches(prepared: TreeSnapshot | undefined, published: TreeSnapshot | undefined, sameIdentity: boolean): boolean {
  return prepared !== undefined && published !== undefined
    && (sameIdentity ? sameSnapshot(prepared, published) : prepared.digest === published.digest);
}

/** Check ownership and installed content without exposing marker data to the renderer. */
export async function isManagedSkillInstalled(target: AgentSkillTarget, current?: Pick<SkillInstallOptions, "sourceDirectory" | "installedVersion">): Promise<boolean> {
  try {
    const marker = await markerAt(target);
    return !!marker?.installedVersion.trim()
      && await treeDigest(target.skillDirectory, true) === marker.sourceDigest
      && (!current || (marker.installedVersion === current.installedVersion
        && marker.sourceDigest === await treeDigest(current.sourceDirectory)));
  } catch { return false; }
}

export async function canRefreshManagedSkill(target: AgentSkillTarget): Promise<boolean> {
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
  let previousSnapshot: TreeSnapshot | undefined;
  let backupStageRequired = false;
  let recoveryFailed = false;
  try {
    if (!options.installedVersion || await exists(join(options.sourceDirectory, SKILL_MARKER))) throw new Error("Invalid source");
    const sourceDigest = await treeDigest(options.sourceDirectory);
    await mkdir(dirname(target.skillDirectory), { recursive: true });
    await (options.copyDirectory ?? ((source, destination) => cp(source, destination, { recursive: true, errorOnExist: true, force: false })))(options.sourceDirectory, stage);
    stageSnapshot = await snapshotTree(stage);
    if (await treeDigest(stage) !== sourceDigest) throw new Error("Incomplete Skill copy");
    if (options.preserveExisting && !(await canRefreshManagedSkill(target))) throw new Error("User Skill must be preserved");
    const liveSnapshot = await snapshotTree(target.skillDirectory);
    const old = await markerAt(target);
    let backupDirectory = old?.backupDirectory;
    if (await exists(target.skillDirectory) && !old) {
      if (await exists(target.backupDirectory)) throw new Error("Backup already exists");
      await mkdir(dirname(target.backupDirectory), { recursive: true });
      backupStageRequired = true;
      await cp(target.skillDirectory, backupStage, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
      backupStageSnapshot = await snapshotTree(backupStage);
      backupDirectory = target.backupDirectory;
    }
    if (!sameSnapshot(liveSnapshot, await snapshotTree(target.skillDirectory))) throw new Error("Skill changed during preparation");
    if (await exists(backupStage)) {
      if (backupStageSnapshot?.digest !== liveSnapshot?.digest) throw new Error("Incomplete Skill backup");
    }
    const marker: ManagedSkillMarker = { format: "hypit.desktop-managed@2", target: target.id, installedVersion: options.installedVersion,
      sourceDigest, ...(backupDirectory === undefined ? {} : { backupDirectory }) };
    await writeFile(join(stage, SKILL_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    stageSnapshot = await snapshotTree(stage);
    return {
      marker,
      async commit() {
        if (!sameSnapshot(liveSnapshot, await snapshotTree(target.skillDirectory))) throw new Error("Skill changed before commit");
        if (backupStageRequired) {
          if (!(await matchesSnapshot(backupStageSnapshot, backupStage))) throw new Error("Backup stage changed before commit");
          if (await exists(target.backupDirectory)) throw new Error("Backup already exists");
          const sameIdentity = await publishNoReplace(backupStage, target.backupDirectory);
          backupCreated = true;
          const observed = await snapshotTree(target.backupDirectory);
          if (!publishedMatches(backupStageSnapshot, observed, sameIdentity)) throw new Error("Backup changed during commit");
          publishedBackupSnapshot = observed;
        } else if (await exists(backupStage)) {
          throw new Error("Unexpected backup stage");
        }
        if (!sameSnapshot(liveSnapshot, await snapshotTree(target.skillDirectory))) throw new Error("Skill changed before commit");
        if (liveSnapshot) {
          if (await exists(previous)) throw new Error("Previous Skill path already exists");
          const sameIdentity = await publishNoReplace(target.skillDirectory, previous);
          moved = true;
          const observed = await snapshotTree(previous);
          if (!publishedMatches(liveSnapshot, observed, sameIdentity)) throw new Error("Skill changed during commit");
          previousSnapshot = observed;
        }
        if (await exists(target.skillDirectory)) throw new Error("Skill appeared during commit");
        if (!(await matchesSnapshot(stageSnapshot, stage))) throw new Error("Skill stage changed before commit");
        const sameIdentity = await publishNoReplace(stage, target.skillDirectory);
        committed = true;
        const observed = await snapshotTree(target.skillDirectory);
        if (!publishedMatches(stageSnapshot, observed, sameIdentity)) throw new Error("Committed Skill changed");
        committedSnapshot = observed;
      },
      async rollback() {
        const fail = () => { recoveryFailed = true; return true; };
        try {
          if (backupCreated && !(await matchesSnapshot(publishedBackupSnapshot, target.backupDirectory))) return fail();
          if (moved && !(await matchesSnapshot(previousSnapshot, previous))) return fail();
          if (!committed && !moved && backupCreated
            && !sameSnapshot(liveSnapshot, await snapshotTree(target.skillDirectory))) return fail();
          if (committed) {
            if (!committedSnapshot || !sameSnapshot(committedSnapshot, await snapshotTree(target.skillDirectory))
              || await exists(stage)) return fail();
            const sameIdentity = await publishNoReplace(target.skillDirectory, stage);
            if (!publishedMatches(committedSnapshot, await snapshotTree(stage), sameIdentity)) {
              if (!(await exists(target.skillDirectory))) await publishNoReplace(stage, target.skillDirectory).catch(() => {});
              return fail();
            }
            committed = false;
            stageSnapshot = committedSnapshot;
          }
          if (moved) {
            if (await exists(target.skillDirectory) || !(await matchesSnapshot(previousSnapshot, previous))) return fail();
            const sameIdentity = await publishNoReplace(previous, target.skillDirectory);
            moved = false;
            if (!publishedMatches(previousSnapshot, await snapshotTree(target.skillDirectory), sameIdentity)) return fail();
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
          ...(succeeded && moved ? [{ path: previous, snapshot: previousSnapshot }] : []),
          { path: stage, snapshot: stageSnapshot },
          { path: backupStage, snapshot: backupStageSnapshot },
        ], "Skill 安装失败 [SKILL_INSTALL_FAILED_CLEANUP_FAILED]");
      },
    };
  } catch {
    const retained = await cleanupFailedPreparation([
      { path: stage, snapshot: stageSnapshot },
      { path: backupStage, snapshot: backupStageSnapshot },
    ]);
    throw preparationFailure("Skill 安装失败", "SKILL_INSTALL_FAILED", retained);
  }
}

/** Copy, commit, and finalize a single target when no outer transaction is needed. */
export async function installManagedSkill(options: SkillInstallOptions): Promise<ManagedSkillMarker> {
  const prepared = await prepareSkillInstall(options);
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

type LegacyCodexPaths = Pick<AgentSkillTarget, "skillDirectory" | "backupDirectory">;
const legacyCodexPaths = (paths: DesktopPaths): LegacyCodexPaths => ({
  skillDirectory: paths.legacyCodexSkill, backupDirectory: paths.legacyCodexSkillBackup,
});

/** Probe only the exact legacy marker before considering traversal of a user's tree. */
async function legacyCodexMarker(paths: DesktopPaths): Promise<{ readonly sourceDigest: string; readonly backupDirectory?: string } | undefined> {
  const legacy = legacyCodexPaths(paths);
  try {
    if (!(await lstat(legacy.skillDirectory)).isDirectory()) return undefined;
    const markerPath = join(legacy.skillDirectory, SKILL_MARKER);
    if (!(await lstat(markerPath)).isFile()) return undefined;
    const marker = JSON.parse(await readFile(markerPath, "utf8"));
    if (marker?.format !== "hypit.desktop-managed@1"
      || typeof marker.installedVersion !== "string" || !marker.installedVersion.trim()
      || typeof marker.sourceDigest !== "string" || !/^[a-f0-9]{64}$/u.test(marker.sourceDigest)
      || (marker.backupDirectory !== undefined && marker.backupDirectory !== legacy.backupDirectory)) return undefined;
    return marker;
  } catch { return undefined; }
}

export async function prepareLegacyCodexMigration(paths: DesktopPaths): Promise<PreparedRemoval | undefined> {
  if (!(await legacyCodexMarker(paths))) return undefined;
  return prepareOwnedRemoval(legacyCodexPaths(paths), async () => {
    // Re-read after the snapshot: the preflight alone never proves tree ownership.
    const marker = await legacyCodexMarker(paths);
    try {
      return marker && await treeDigest(paths.legacyCodexSkill, true) === marker.sourceDigest ? marker : undefined;
    } catch { return undefined; }
  });
}

/** Validate ownership and stage restoration before changing any installed component. */
export async function prepareSkillRemoval(options: { readonly target: AgentSkillTarget }): Promise<PreparedRemoval | undefined> {
  return prepareOwnedRemoval(options.target, () => markerAt(options.target));
}

async function prepareOwnedRemoval(target: LegacyCodexPaths,
  readMarker: () => Promise<{ readonly backupDirectory?: string } | undefined>): Promise<PreparedRemoval | undefined> {
  const previous = `${target.skillDirectory}.removed-${randomUUID()}`;
  const restoreStage = `${target.skillDirectory}.restore-${randomUUID()}`;
  let moved = false;
  let restored = false;
  let restoredLiveSnapshot: TreeSnapshot | undefined;
  let restoreStageSnapshot: TreeSnapshot | undefined;
  let recoveryFailed = false;
  try {
    const liveSnapshot = await snapshotTree(target.skillDirectory);
    const marker = await readMarker();
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
        const movedWithIdentity = await publishNoReplace(target.skillDirectory, previous);
        moved = true;
        if (!publishedMatches(liveSnapshot, await snapshotTree(previous), movedWithIdentity)) throw new Error("Skill changed during removal commit");
        if (marker.backupDirectory !== undefined) {
          if (await exists(target.skillDirectory) || !(await matchesSnapshot(restoreStageSnapshot, restoreStage)))
            throw new Error("Restore stage changed during removal commit");
          const sameIdentity = await publishNoReplace(restoreStage, target.skillDirectory);
          restored = true;
          const observed = await snapshotTree(target.skillDirectory);
          if (!publishedMatches(restoreStageSnapshot, observed, sameIdentity)) throw new Error("Restored Skill changed during commit");
          restoredLiveSnapshot = observed;
        }
      },
      async rollback() {
        const fail = () => { recoveryFailed = true; return true; };
        if (!moved) return false;
        try {
          if (!(await matchesSnapshot(liveSnapshot, previous))) return fail();
          if (restored) {
            if (!(await matchesSnapshot(restoredLiveSnapshot, target.skillDirectory)) || await exists(restoreStage)) return fail();
            const sameIdentity = await publishNoReplace(target.skillDirectory, restoreStage);
            const observed = await snapshotTree(restoreStage);
            if (!publishedMatches(restoredLiveSnapshot, observed, sameIdentity)) {
              if (!(await exists(target.skillDirectory))) await publishNoReplace(restoreStage, target.skillDirectory).catch(() => {});
              return fail();
            }
            restored = false;
            restoreStageSnapshot = observed;
          }
          if (await exists(target.skillDirectory) || !(await matchesSnapshot(liveSnapshot, previous))) return fail();
          const sameIdentity = await publishNoReplace(previous, target.skillDirectory);
          moved = false;
          if (!publishedMatches(liveSnapshot, await snapshotTree(target.skillDirectory), sameIdentity)) return fail();
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
    const retained = await cleanupFailedPreparation([{ path: restoreStage, snapshot: restoreStageSnapshot }]);
    throw preparationFailure("Skill 卸载失败", "SKILL_REMOVE_FAILED", retained);
  }
}

export async function removeManagedSkill(options: { readonly target: AgentSkillTarget }): Promise<boolean> {
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
