import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, win32 } from "node:path";
import { promisify } from "node:util";
import type { DesktopPaths } from "./paths.js";
import { exists } from "./skill-install.js";
import type { PreparedRemoval } from "./skill-install.js";

export type UserPath = { readonly read: () => Promise<string>; readonly write: (value: string) => Promise<void> };
export type LauncherOptions = {
  readonly paths: DesktopPaths;
  readonly platform: "darwin" | "win32";
  readonly home: string;
  readonly electronExecutable: string;
  readonly cliEntry: string;
  readonly userPath?: UserPath;
};
type LauncherState = {
  readonly format: "hypit.desktop-launcher@1";
  readonly launcherDigest: string;
  readonly pathAdded: boolean;
  readonly pathEntry: string;
  readonly zprofileBlock?: string;
};
export const RESTART_MESSAGE = "请重启 Codex 和 Terminal，再测试 hypit 命令是否可用。";
const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const quote = (path: string) => `"${path.replace(/[\\"$`]/gu, "\\$&")}"`;
const pathBlock = (path: string) => `# >>> hypit.desktop-managed@1 >>>\nexport PATH=${quote(path)}:"$PATH"\n# <<< hypit.desktop-managed@1 <<<\n`;

type RunPowerShell = (script: string, encodedValue?: string) => Promise<string>;
const runPowerShell: RunPowerShell = async (script, encodedValue) => {
  const result = await promisify(execFile)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
    windowsHide: true, env: { ...process.env, ...(encodedValue === undefined ? {} : { HYPIT_USER_PATH_VALUE: encodedValue }) },
  });
  return result.stdout;
};

/** Only HKCU is touched. Raw expandable values and their registry kind survive updates. */
export function createWindowsUserPath(run: RunPowerShell = runPowerShell): UserPath {
  return {
    async read() {
      return run(`$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$key=[Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment')
if ($null -ne $key) {
  try { [Console]::Write($key.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)) }
  finally { $key.Dispose() }
}`);
    },
    async write(value) {
      await run(`$ErrorActionPreference='Stop'
$value=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:HYPIT_USER_PATH_VALUE))
$key=[Microsoft.Win32.Registry]::CurrentUser.CreateSubKey('Environment')
try {
  $kind=[Microsoft.Win32.RegistryValueKind]::ExpandString
  if ($null -ne $key.GetValue('Path',$null,[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)) { $kind=$key.GetValueKind('Path') }
  $key.SetValue('Path',$value,$kind)
} finally { $key.Dispose() }
Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class HypitEnvironment { [DllImport("user32.dll", CharSet=CharSet.Unicode, SetLastError=true)] public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, string lParam, uint flags, uint timeout, out UIntPtr result); }'
$result=[UIntPtr]::Zero
[void][HypitEnvironment]::SendMessageTimeout([IntPtr]0xffff,0x001a,[UIntPtr]::Zero,'Environment',2,5000,[ref]$result)`, Buffer.from(value).toString("base64"));
    },
  };
}
export const windowsUserPath = createWindowsUserPath();

export async function atomicFile(path: string, data: string | Buffer, mode = 0o600): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${randomUUID()}`;
  try {
    const file = await open(temp, "wx", mode);
    try { if (process.platform !== "win32") await file.chmod(mode); await file.writeFile(data); await file.sync(); }
    finally { await file.close(); }
    await rename(temp, path);
  } finally { await unlink(temp).catch(() => {}); }
}

export type FileSnapshot = { readonly path: string; readonly bytes?: Buffer; readonly mode?: number };
export async function snapshotFile(path: string): Promise<FileSnapshot> {
  if (!(await exists(path))) return { path };
  const info = await lstat(path);
  if (!info.isFile()) throw new Error("Expected a regular file");
  return { path, bytes: await readFile(path), mode: info.mode & 0o777 };
}
export async function restoreFiles(snapshots: readonly FileSnapshot[]): Promise<boolean> {
  let failed = false;
  for (const snapshot of [...snapshots].reverse()) {
    try {
      if (snapshot.bytes !== undefined) await atomicFile(snapshot.path, snapshot.bytes, snapshot.mode);
      else if (await exists(snapshot.path)) await unlink(snapshot.path);
    } catch { failed = true; }
  }
  return failed;
}
export function launcherFiles(options: Pick<LauncherOptions, "paths" | "platform" | "home">): string[] {
  return [options.paths.launcher, options.paths.managedState, ...(options.platform === "darwin" ? [join(options.home, ".zprofile")] : [])];
}

async function readState(path: string): Promise<LauncherState | undefined> {
  if (!(await exists(path))) return undefined;
  const value = JSON.parse(await readFile(path, "utf8")) as LauncherState;
  if (value?.format !== "hypit.desktop-launcher@1" || !/^[a-f0-9]{64}$/u.test(value.launcherDigest)
    || typeof value.pathAdded !== "boolean" || typeof value.pathEntry !== "string"
    || (value.zprofileBlock !== undefined && typeof value.zprofileBlock !== "string")) throw new Error("Invalid launcher state");
  if (value.zprofileBlock !== undefined && value.zprofileBlock !== pathBlock(value.pathEntry)
    && value.zprofileBlock !== `\n${pathBlock(value.pathEntry)}`) throw new Error("Invalid PATH block ownership");
  return value;
}
const normalizeEntry = (entry: string) => entry.trim().replace(/^"|"$/gu, "").replace(/[\\/]+$/u, "").toLowerCase();

export function renderLauncher(options: LauncherOptions): string {
  if (options.platform === "darwin") {
    if (!isAbsolute(options.electronExecutable) || !isAbsolute(options.cliEntry)) throw new Error("Absolute paths required");
    return `#!/bin/sh\nexport ELECTRON_RUN_AS_NODE=1\nexec ${quote(options.electronExecutable)} ${quote(options.cliEntry)} "$@"\n`;
  }
  const windowsPaths = win32.isAbsolute(options.paths.launcher);
  const path = windowsPaths ? win32 : { dirname, relative, isAbsolute };
  const reference = (target: string) => {
    if (!path.isAbsolute(target) || /[\r\n"%!]/u.test(target)) throw new Error("Unsupported Windows path");
    const rel = path.relative(path.dirname(options.paths.launcher), target);
    const located = path.isAbsolute(rel) ? rel : `%~dp0${rel.replace(/\//gu, "\\")}`;
    return `"${located}"`;
  };
  return `@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n${reference(options.electronExecutable)} ${reference(options.cliEntry)} %*\r\nexit /b %errorlevel%\r\n`;
}

export async function installLauncher(options: LauncherOptions): Promise<{ readonly restartMessage: string }> {
  const snapshots: FileSnapshot[] = [];
  let oldPath: string | undefined;
  let pathAttempted = false;
  const userPath = options.userPath ?? windowsUserPath;
  try {
    const text = renderLauncher(options);
    if (!(await lstat(options.electronExecutable)).isFile() || !(await lstat(options.cliEntry)).isFile()) throw new Error("Missing runtime");
    for (const path of launcherFiles(options)) snapshots.push(await snapshotFile(path));
    const oldState = await readState(options.paths.managedState);
    const oldLauncher = snapshots[0]!.bytes;
    if (oldLauncher !== undefined && (!oldState || digest(oldLauncher.toString()) !== oldState.launcherDigest)) throw new Error("Unmanaged launcher");
    const pathEntry = dirname(options.paths.launcher);
    if (oldState && oldState.pathEntry !== pathEntry) throw new Error("Launcher path changed");
    let state: LauncherState = { format: "hypit.desktop-launcher@1", launcherDigest: digest(text), pathAdded: false, pathEntry };
    await mkdir(pathEntry, { recursive: true, mode: 0o700 });
    if (options.platform === "darwin") {
      await chmod(pathEntry, 0o700);
      const profile = join(options.home, ".zprofile");
      const content = snapshots[2]!.bytes ?? Buffer.alloc(0);
      const core = pathBlock(pathEntry);
      const block = oldState?.zprofileBlock ?? `${content.length && content.at(-1) !== 10 ? "\n" : ""}${core}`;
      if (oldState?.zprofileBlock && !content.includes(block)) throw new Error("PATH block was edited");
      if (!content.includes(block)) await atomicFile(profile, Buffer.concat([content, Buffer.from(block)]), snapshots[2]!.mode ?? 0o600);
      state = { ...state, zprofileBlock: block };
    } else {
      oldPath = await userPath.read();
      const present = oldPath.split(";").some((entry) => normalizeEntry(entry) === normalizeEntry(pathEntry));
      state = { ...state, pathAdded: oldState?.pathAdded === true || !present };
      if (!present) { pathAttempted = true; await userPath.write(`${oldPath}${oldPath ? ";" : ""}${pathEntry}`); }
    }
    await atomicFile(options.paths.launcher, text, 0o755);
    await atomicFile(options.paths.managedState, `${JSON.stringify(state, null, 2)}\n`);
    return { restartMessage: RESTART_MESSAGE };
  } catch {
    let failed = await restoreFiles(snapshots);
    if (pathAttempted && oldPath !== undefined) await userPath.write(oldPath).catch(() => { failed = true; });
    throw new Error(`命令入口安装失败 [LAUNCHER_INSTALL_FAILED${failed ? "_ROLLBACK_FAILED" : ""}]`);
  }
}

export async function prepareLauncherRemoval(options: Pick<LauncherOptions, "paths" | "platform" | "home" | "userPath">): Promise<PreparedRemoval | undefined> {
  const snapshots: FileSnapshot[] = [];
  const userPath = options.userPath ?? windowsUserPath;
  let oldPath: string | undefined;
  let pathAttempted = false;
  let filesAttempted = false;
  try {
    const state = await readState(options.paths.managedState);
    if (!state) return undefined;
    for (const path of launcherFiles(options)) snapshots.push(await snapshotFile(path));
    if (state.pathEntry !== dirname(options.paths.launcher)) throw new Error("Invalid path ownership");
    if (snapshots[0]!.bytes !== undefined && digest(snapshots[0]!.bytes!.toString()) !== state.launcherDigest) throw new Error("Launcher was edited");
    let profileBytes: Buffer | undefined;
    let nextPath: string | undefined;
    if (options.platform === "darwin" && state.zprofileBlock) {
      const content = snapshots[2]!.bytes;
      const block = Buffer.from(state.zprofileBlock);
      const index = content?.indexOf(block) ?? -1;
      if (content && index !== -1) profileBytes = Buffer.concat([content.subarray(0, index), content.subarray(index + block.length)]);
    } else if (options.platform === "win32" && state.pathAdded) {
      oldPath = await userPath.read();
      const entries = oldPath.split(";");
      const index = entries.indexOf(state.pathEntry);
      if (index !== -1) { entries.splice(index, 1); nextPath = entries.join(";"); }
    }
    return {
      async commit() {
        if (nextPath !== undefined) { pathAttempted = true; await userPath.write(nextPath); }
        filesAttempted = true;
        if (profileBytes !== undefined) await atomicFile(join(options.home, ".zprofile"), profileBytes, snapshots[2]!.mode);
        if (snapshots[0]!.bytes !== undefined) await unlink(options.paths.launcher);
        await unlink(options.paths.managedState);
      },
      async rollback() {
        let failed = filesAttempted && await restoreFiles(snapshots);
        if (pathAttempted && oldPath !== undefined) await userPath.write(oldPath).catch(() => { failed = true; });
        return failed;
      },
      async dispose() {},
    };
  } catch {
    throw new Error("命令入口卸载失败 [LAUNCHER_REMOVE_FAILED]");
  }
}

export async function removeLauncher(options: Pick<LauncherOptions, "paths" | "platform" | "home" | "userPath">): Promise<boolean> {
  let removal: PreparedRemoval | undefined;
  let committed = false;
  try {
    removal = await prepareLauncherRemoval(options);
    if (!removal) return false;
    await removal.commit();
    committed = true;
    return true;
  } catch {
    const failed = await removal?.rollback();
    throw new Error(`命令入口卸载失败 [LAUNCHER_REMOVE_FAILED${failed ? "_ROLLBACK_FAILED" : ""}]`);
  } finally { await removal?.dispose(committed); }
}
