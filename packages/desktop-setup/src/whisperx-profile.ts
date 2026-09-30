import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { DiagnosticItem } from "./contracts.js";
import { prepareFileChange, snapshotFile } from "./launcher-install.js";
import { parseDesktopProfileDocument } from "./profile.js";
import type { DesktopProfileDocument } from "./profile.js";
import type { PreparedRemoval } from "./skill-install.js";

export const LOCAL_WHISPERX_ENDPOINT = "whisperx.local";
export const WHISPERX_ALIGNMENT_CAPABILITY = "@hypit/whisperx@1#whisperx-alignment";
export const localWhisperXConfig = Object.freeze({
  expectedModel: "small", expectedDevice: "cpu", expectedCompute: "int8", alignmentLanguages: Object.freeze(["zh", "en"] as const),
});
export type PreparedWhisperXProfile = PreparedRemoval & { readonly candidatePath: string };
export type WhisperXProfileOptions = { readonly profilePath: string; readonly platform: "darwin" | "win32" };
const endpoint = { use: "@hypit/provider-whisperx-local", pool: LOCAL_WHISPERX_ENDPOINT, config: localWhisperXConfig };

function hasExactActivation(profile: DesktopProfileDocument): boolean {
  const hasEndpoint = Object.hasOwn(profile.endpoints, LOCAL_WHISPERX_ENDPOINT);
  const hasBinding = Object.hasOwn(profile.bindings, WHISPERX_ALIGNMENT_CAPABILITY);
  if ((hasEndpoint && !isDeepStrictEqual(profile.endpoints[LOCAL_WHISPERX_ENDPOINT], endpoint))
    || (hasBinding && profile.bindings[WHISPERX_ALIGNMENT_CAPABILITY] !== LOCAL_WHISPERX_ENDPOINT)) {
    throw new Error("WHISPERX_PROFILE_CONFLICT");
  }
  return hasEndpoint && hasBinding;
}

/** Read the real Profile only; a candidate or a healthy process cannot establish activation. */
export async function isWhisperXProfileActivated(options: Pick<WhisperXProfileOptions, "profilePath">): Promise<boolean> {
  const snapshot = await snapshotFile(options.profilePath);
  if (snapshot.bytes === undefined) throw new Error("WHISPERX_PROFILE_REQUIRED");
  let profile;
  try { profile = parseDesktopProfileDocument(snapshot.bytes); }
  catch { throw new Error("WHISPERX_PROFILE_INVALID"); }
  return hasExactActivation(profile);
}

/** Prepare a sibling so the runtime resolves relative dataRoot exactly as it will after publication. */
export async function prepareWhisperXProfile(options: WhisperXProfileOptions): Promise<PreparedWhisperXProfile> {
  const before = await snapshotFile(options.profilePath);
  if (before.bytes === undefined) throw new Error("WHISPERX_PROFILE_REQUIRED");
  let profile;
  try { profile = parseDesktopProfileDocument(before.bytes); }
  catch { throw new Error("WHISPERX_PROFILE_INVALID"); }
  const activated = hasExactActivation(profile);
  profile.endpoints[LOCAL_WHISPERX_ENDPOINT] = endpoint;
  profile.bindings[WHISPERX_ALIGNMENT_CAPABILITY] = LOCAL_WHISPERX_ENDPOINT;
  const bytes = activated ? before.bytes : Buffer.from(`${JSON.stringify(profile, null, 2)}\n`);
  const candidatePath = `${options.profilePath}.whisperx-${randomUUID()}.json`;
  const candidate = prepareFileChange({ path: candidatePath }, bytes, options.platform, 0o600, "profile");
  let candidateSnapshot;
  try {
    await candidate.commit();
    candidateSnapshot = await snapshotFile(candidatePath);
    if (!candidateSnapshot.bytes?.equals(bytes)) throw new Error("WhisperX Profile candidate changed during preparation");
  } catch (error) {
    await candidate.rollback();
    const diagnostics = await candidate.dispose(false);
    if (diagnostics.length) throw Object.assign(new Error("WHISPERX_PROFILE_PREPARE_FAILED CLEANUP_INCOMPLETE"), { diagnostics });
    throw error;
  }
  const publication = prepareFileChange(before, bytes, options.platform, before.mode, "profile");
  return {
    candidatePath,
    async commit() {
      let unchanged = false;
      try { unchanged = isDeepStrictEqual(candidateSnapshot, await snapshotFile(candidatePath)); } catch { /* Refuse changed or non-regular candidates. */ }
      if (!unchanged) throw new Error("WhisperX Profile candidate changed before publication");
      await publication.commit();
    },
    rollback: publication.rollback,
    async dispose(committed) {
      const diagnostics: DiagnosticItem[] = [...await publication.dispose(committed)];
      // Candidate removal uses the same ownership checks as real Profile rollback.
      if (await candidate.rollback()) diagnostics.push({ code: "profile", label: "Runtime Profile", status: "warning",
        reason: "CLEANUP_INCOMPLETE", path: candidatePath });
      diagnostics.push(...await candidate.dispose(false));
      return diagnostics;
    },
  };
}
