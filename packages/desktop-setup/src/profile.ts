import { newApiDefaultBindings } from "@dramaclaw/provider-newapi";
import type { CanonicalValue } from "@hypit/protocol";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, posix, win32 } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { isManagedLauncherInstalled, prepareFileChange, snapshotFile } from "./launcher-install.js";
import type { LauncherOptions } from "./launcher-install.js";
import type { PreparedRemoval } from "./skill-install.js";

export type DesktopProfileDocument = Record<string, unknown> & {
  readonly format: "hypit.runtime-local@1";
  readonly dataRoot: string;
  readonly endpoints: Record<string, unknown>;
  readonly bindings: Record<string, unknown>;
};

/** Keep the original document, including unrelated provider settings, when editing owned keys. */
export function parseDesktopProfileDocument(bytes: Buffer): DesktopProfileDocument {
  const profile: unknown = JSON.parse(bytes.toString("utf8"));
  const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
  if (!record(profile) || profile.format !== "hypit.runtime-local@1" || typeof profile.dataRoot !== "string"
    || !profile.dataRoot.trim() || !record(profile.endpoints) || !record(profile.bindings)) throw new Error("Invalid desktop Profile");
  return profile as DesktopProfileDocument;
}

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
export async function prepareDesktopMediaRefresh(options: LauncherOptions): Promise<PreparedRemoval | undefined> {
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
  return changed ? prepareFileChange(snapshot, Buffer.from(`${JSON.stringify(profile, null, 2)}\n`), options.platform, snapshot.mode, "profile") : undefined;
}

/** Upgrade only missing NewAPI bindings and an exactly installer-managed legacy speech binding. */
export async function prepareDesktopNewApiBindingsRefresh(options: { readonly profile: string; readonly platform: "darwin" | "win32" }): Promise<PreparedRemoval | undefined> {
  const snapshot = await snapshotFile(options.profile);
  if (!snapshot.bytes) return undefined;
  let profile: DesktopProfileDocument;
  try { profile = parseDesktopProfileDocument(snapshot.bytes); } catch { return undefined; }
  const endpoint = profile.endpoints["newapi.personal"];
  if (!endpoint || typeof endpoint !== "object" || Array.isArray(endpoint)
    || (endpoint as Record<string, unknown>).use !== "@dramaclaw/provider-newapi"
    || (endpoint as Record<string, unknown>).pool !== "newapi.personal") return undefined;
  const key = "@hypit/whisperx@1#whisperx-alignment";
  const managedLegacySpeech = { use: "@hypit/provider-whisperx-local", pool: "whisperx.local", config: {
    expectedModel: "small", expectedDevice: "cpu", expectedCompute: "int8", alignmentLanguages: ["zh", "en"],
  } };
  let changed = false;
  if (profile.bindings[key] === "whisperx.local" && isDeepStrictEqual(profile.endpoints["whisperx.local"], managedLegacySpeech)) {
    profile.bindings[key] = "newapi.personal";
    changed = true;
    if (!Object.values(profile.bindings).includes("whisperx.local")) delete profile.endpoints["whisperx.local"];
  }
  for (const [capability, target] of Object.entries(newApiDefaultBindings)) {
    if (Object.hasOwn(profile.bindings, capability)) continue;
    profile.bindings[capability] = target;
    changed = true;
  }
  if (!changed) return undefined;
  return prepareFileChange(snapshot, Buffer.from(`${JSON.stringify(profile, null, 2)}\n`), options.platform, snapshot.mode, "profile");
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
