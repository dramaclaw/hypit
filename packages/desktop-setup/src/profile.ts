import { newApiDefaultBindings } from "@dramaclaw/provider-newapi";
import type { CanonicalValue } from "@hypit/protocol";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, posix, win32 } from "node:path";
import { isManagedLauncherInstalled, snapshotFile } from "./launcher-install.js";
import type { FileSnapshot, LauncherOptions } from "./launcher-install.js";

const mediaFields = ["ffmpegPath", "ffprobePath"] as const;
function mediaConfigs(profile: { endpoints?: Record<string, { config?: Record<string, unknown> }> }): Record<string, unknown>[] {
  return ["media.local", "hyperframes.local"].map(key => profile.endpoints?.[key]?.config)
    .filter((config): config is Record<string, unknown> => !!config && typeof config === "object" && !Array.isArray(config));
}

/** Explicit binary paths must still exist; custom paths are checked without being changed. */
export async function desktopMediaAvailable(profilePath: string): Promise<boolean | undefined> {
  try {
    const configs = mediaConfigs(JSON.parse(await readFile(profilePath, "utf8")));
    const paths = configs.flatMap(config => mediaFields.filter(field => config[field] !== undefined).map(field => config[field]));
    if (!paths.length) return undefined;
    for (const path of paths) if (typeof path !== "string" || !isAbsolute(path) || !(await stat(path)).isFile()) return false;
    return true;
  } catch { return false; }
}

/** Claim old media paths only when they reproduce the complete, intact managed launcher. */
export async function prepareDesktopMediaRefresh(options: LauncherOptions): Promise<{ snapshot: FileSnapshot; content: string } | undefined> {
  if (!options.bundledBin) return undefined;
  const snapshot = await snapshotFile(options.paths.profile);
  if (!snapshot.bytes) return undefined;
  const profile = JSON.parse(snapshot.bytes.toString("utf8"));
  const path = options.platform === "win32" && !posix.isAbsolute(options.bundledBin) ? win32 : posix;
  const suffix = options.platform === "win32" ? ".exe" : "";
  let changed = false;
  for (const config of mediaConfigs(profile)) {
    for (const field of mediaFields) {
      const previous = config[field];
      const filename = `${field === "ffmpegPath" ? "ffmpeg" : "ffprobe"}${suffix}`;
      const next = path.join(options.bundledBin, filename);
      if (typeof previous !== "string" || previous === next || !path.isAbsolute(previous) || path.basename(previous) !== filename) continue;
      const oldBin = path.dirname(previous);
      if (path.basename(oldBin) !== "bin") continue;
      const owned = await isManagedLauncherInstalled({ ...options, bundledBin: oldBin,
        electronExecutable: path.resolve(oldBin, path.relative(options.bundledBin, options.electronExecutable)),
        cliEntry: path.resolve(oldBin, path.relative(options.bundledBin, options.cliEntry)) });
      if (!owned) continue;
      if (!(await stat(next)).isFile()) throw new Error("Missing bundled media binary");
      config[field] = next;
      changed = true;
    }
  }
  return changed ? { snapshot, content: `${JSON.stringify(profile, null, 2)}\n` } : undefined;
}

/** Accepts the secret-free endpoint config returned by completeNewApiSetup. */
export function createDesktopProfile(config: CanonicalValue, media?: { readonly ffmpegPath: string; readonly ffprobePath: string }): CanonicalValue {
  return {
    format: "hypit.runtime-local@1",
    // Profiles live in <hostState>/profiles; runtime data stays in the same host directory.
    dataRoot: "../runtimes/desktop-newapi",
    credentials: { platform: { use: "@hypit/credential-store-platform" } },
    bindings: { ...newApiDefaultBindings },
    endpoints: {
      "newapi.personal": { use: "@dramaclaw/provider-newapi", pool: "newapi.personal", config },
      "media.local": { use: "@hypit/provider-media-local", ...(media ? { config: { ...media } } : {}) },
      "hyperframes.local": { use: "@hypit/provider-hyperframes-local", ...(media ? { config: { ...media } } : {}) },
    },
  };
}
