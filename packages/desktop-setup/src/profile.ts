import { newApiDefaultBindings } from "@dramaclaw/provider-newapi";
import type { CanonicalValue } from "@hypit/protocol";

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
