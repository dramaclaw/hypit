import { lstat, opendir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { DiagnosticItem } from "./contracts.js";
import type { DesktopPaths } from "./paths.js";

const MAX_DIRECTORY_ENTRIES = 256;
const MAX_RECOVERIES_PER_PATH = 3;
const recoverySuffix = /^[A-Za-z0-9]{6}$/u;

type RecoveryRoot = { readonly path: string; readonly code: "launcher" | "profile" };

function warning(root: RecoveryRoot, path?: string): DiagnosticItem {
  return { code: root.code, label: root.code === "launcher" ? "命令入口" : "Runtime Profile",
    status: "warning", reason: "CLEANUP_INCOMPLETE", ...(path === undefined ? {} : { path }) };
}

/** Inspect a fixed parent only; recovery contents and symlink targets are never opened. */
async function warningsAt(root: RecoveryRoot): Promise<DiagnosticItem[]> {
  const parent = dirname(root.path);
  const prefix = `${basename(root.path)}.recovery-`;
  const names: string[] = [];
  let incomplete = false;
  try {
    const parentInfo = await lstat(parent);
    if (!parentInfo.isDirectory() || parentInfo.isSymbolicLink()) return [warning(root)];
    const directory = await opendir(parent);
    let inspected = 0;
    for await (const entry of directory) {
      if (++inspected > MAX_DIRECTORY_ENTRIES) { incomplete = true; break; }
      if (!entry.name.startsWith(prefix) || !recoverySuffix.test(entry.name.slice(prefix.length))) continue;
      const path = join(parent, entry.name);
      try {
        const info = await lstat(path);
        if (info.isDirectory() || info.isSymbolicLink()) names.push(entry.name);
      } catch { incomplete = true; }
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    return [warning(root)];
  }
  names.sort();
  const paths = [...new Set(names)].slice(0, MAX_RECOVERIES_PER_PATH).map(name => warning(root, join(parent, name)));
  if (incomplete || names.length > MAX_RECOVERIES_PER_PATH) paths.push(warning(root));
  return paths;
}

/** Matches only the four file transaction targets used by prepareFileChange. */
export async function transactionRecoveryWarnings(options: { readonly paths: DesktopPaths; readonly home: string;
  readonly platform: "darwin" | "win32" }): Promise<readonly DiagnosticItem[]> {
  const roots: RecoveryRoot[] = [
    { path: options.paths.launcher, code: "launcher" },
    { path: options.paths.managedState, code: "launcher" },
    ...(options.platform === "darwin" ? [{ path: join(options.home, ".zprofile"), code: "launcher" as const }] : []),
    { path: options.paths.profile, code: "profile" },
  ];
  const results = (await Promise.all(roots.map(warningsAt))).flat();
  const seen = new Set<string>();
  return results.filter(item => {
    const key = `${item.code}\0${item.path ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
