import { posix, win32 } from "node:path";

export type DesktopPaths = {
  readonly hostState: string;
  readonly profile: string;
  readonly skill: string;
  readonly skillBackup: string;
  readonly launcher: string;
  readonly managedState: string;
};

export type DesktopPathOptions = {
  readonly platform: "darwin" | "win32";
  readonly home: string;
  /** The user's application data root (Local AppData on Windows). */
  readonly appData: string;
};

export function desktopPaths(options: DesktopPathOptions): DesktopPaths {
  const path = options.platform === "win32" ? win32 : posix;
  const hostState = path.join(options.appData, "Hypit");
  const desktopState = path.join(hostState, "desktop");
  return {
    hostState,
    profile: path.join(hostState, "profiles", "desktop-newapi.json"),
    skill: path.join(options.home, ".codex", "skills", "hypit"),
    skillBackup: path.join(desktopState, "skill-backup", "hypit"),
    launcher: options.platform === "darwin"
      ? path.join(options.home, ".local", "bin", "hypit")
      : path.join(hostState, "bin", "hypit.cmd"),
    managedState: path.join(desktopState, "managed-state.json"),
  };
}
