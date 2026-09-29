import { createHash, randomUUID } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { DesktopPaths } from "./paths.js";

export const SKILL_MARKER = ".hypit-desktop-managed.json";
export type ManagedSkillMarker = {
  readonly format: "hypit.desktop-managed@1";
  readonly installedVersion: string;
  readonly sourceDigest: string;
  readonly backupDirectory?: string;
};
export type SkillInstallOptions = {
  readonly paths: DesktopPaths;
  readonly sourceDirectory: string;
  readonly installedVersion: string;
  readonly copyDirectory?: (source: string, destination: string) => Promise<void>;
};

export async function exists(path: string): Promise<boolean> {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

async function markerAt(path: string): Promise<ManagedSkillMarker | undefined> {
  if (!(await exists(path)) || (await lstat(path)).isSymbolicLink()) return undefined;
  const markerPath = join(path, SKILL_MARKER);
  if (!(await exists(markerPath))) return undefined;
  if (!(await lstat(markerPath)).isFile()) return undefined;
  let marker: ManagedSkillMarker;
  try { marker = JSON.parse(await readFile(markerPath, "utf8")); } catch { return undefined; }
  if (marker?.format !== "hypit.desktop-managed@1" || typeof marker.installedVersion !== "string"
    || !/^[a-f0-9]{64}$/u.test(marker.sourceDigest) || (marker.backupDirectory !== undefined && typeof marker.backupDirectory !== "string")) return undefined;
  return marker;
}

async function treeDigest(root: string): Promise<string> {
  if (!(await lstat(root)).isDirectory() || !(await lstat(join(root, "SKILL.md"))).isFile()
    || !(await lstat(join(root, "references"))).isDirectory()) throw new Error("Invalid Skill tree");
  const hash = createHash("sha256");
  async function visit(relative: string): Promise<void> {
    const path = join(root, relative);
    const info = await lstat(path);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error("Unsupported Skill entry");
    hash.update(JSON.stringify([relative, info.isDirectory() ? "directory" : "file", info.isFile() ? info.size : 0]));
    if (info.isFile()) hash.update(await readFile(path));
    else for (const name of (await readdir(path)).sort()) await visit(relative ? `${relative}/${name}` : name);
  }
  await visit("");
  return hash.digest("hex");
}

/** Copy is staged beside the target, checked byte-for-byte, then committed with directory renames. */
export async function installManagedSkill(options: SkillInstallOptions): Promise<ManagedSkillMarker> {
  const { paths } = options;
  const stage = `${paths.skill}.stage-${randomUUID()}`;
  const previous = `${paths.skill}.previous-${randomUUID()}`;
  const backupStage = `${paths.skillBackup}.stage-${randomUUID()}`;
  let moved = false;
  let backupCreated = false;
  let committed = false;
  try {
    if (!options.installedVersion || await exists(join(options.sourceDirectory, SKILL_MARKER))) throw new Error("Invalid source");
    const sourceDigest = await treeDigest(options.sourceDirectory);
    await mkdir(dirname(paths.skill), { recursive: true });
    await (options.copyDirectory ?? ((source, destination) => cp(source, destination, { recursive: true, errorOnExist: true, force: false })))(options.sourceDirectory, stage);
    if (await treeDigest(stage) !== sourceDigest) throw new Error("Incomplete Skill copy");
    const old = await markerAt(paths.skill);
    if (old?.backupDirectory !== undefined && old.backupDirectory !== paths.skillBackup) throw new Error("Invalid backup location");
    let backupDirectory = old?.backupDirectory;
    if (await exists(paths.skill) && !old) {
      if (await exists(paths.skillBackup)) throw new Error("Backup already exists");
      await mkdir(dirname(paths.skillBackup), { recursive: true });
      await cp(paths.skill, backupStage, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
      await rename(backupStage, paths.skillBackup);
      backupCreated = true;
      backupDirectory = paths.skillBackup;
    }
    const marker: ManagedSkillMarker = { format: "hypit.desktop-managed@1", installedVersion: options.installedVersion,
      sourceDigest, ...(backupDirectory === undefined ? {} : { backupDirectory }) };
    await writeFile(join(stage, SKILL_MARKER), `${JSON.stringify(marker, null, 2)}\n`, { flag: "wx", mode: 0o600 });
    if (await exists(paths.skill)) { await rename(paths.skill, previous); moved = true; }
    await rename(stage, paths.skill);
    committed = true;
    // A cleanup failure must not turn a committed install into a failed transaction.
    if (moved) await rm(previous, { recursive: true, force: true }).catch(() => {});
    return marker;
  } catch {
    let rollbackFailed = false;
    if (moved && !committed) await rename(previous, paths.skill).catch(() => { rollbackFailed = true; });
    if (backupCreated && !committed && !rollbackFailed) await rm(paths.skillBackup, { recursive: true, force: true }).catch(() => { rollbackFailed = true; });
    throw new Error(`Skill 安装失败 [SKILL_INSTALL_FAILED${rollbackFailed ? "_ROLLBACK_FAILED" : ""}]`);
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    await rm(backupStage, { recursive: true, force: true }).catch(() => {});
  }
}

export async function removeManagedSkill(options: { readonly paths: DesktopPaths }): Promise<boolean> {
  const { paths } = options;
  const previous = `${paths.skill}.removed-${randomUUID()}`;
  const restoreStage = `${paths.skill}.restore-${randomUUID()}`;
  let moved = false;
  let committed = false;
  try {
    const marker = await markerAt(paths.skill);
    if (!marker) return false;
    if (marker.backupDirectory !== undefined) {
      if (marker.backupDirectory !== paths.skillBackup || !(await exists(paths.skillBackup))) throw new Error("Invalid backup");
      await cp(paths.skillBackup, restoreStage, { recursive: true, dereference: false, verbatimSymlinks: true, errorOnExist: true, force: false });
    }
    await rename(paths.skill, previous);
    moved = true;
    if (marker.backupDirectory !== undefined) await rename(restoreStage, paths.skill);
    committed = true;
    await rm(previous, { recursive: true, force: true }).catch(() => {});
    if (marker.backupDirectory !== undefined) await rm(paths.skillBackup, { recursive: true, force: true }).catch(() => {});
    return true;
  } catch {
    let rollbackFailed = false;
    if (moved && !committed) await rename(previous, paths.skill).catch(() => { rollbackFailed = true; });
    throw new Error(`Skill 卸载失败 [SKILL_REMOVE_FAILED${rollbackFailed ? "_ROLLBACK_FAILED" : ""}]`);
  } finally { await rm(restoreStage, { recursive: true, force: true }).catch(() => {}); }
}
