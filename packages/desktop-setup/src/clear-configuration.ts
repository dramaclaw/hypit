import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import type { CredentialRef, WritableCredentialStore } from "@hypit/runtime";
import type { DesktopPaths } from "./paths.js";
import { snapshotFile, restoreFiles } from "./launcher-install.js";

export const desktopCredentialRefs: readonly CredentialRef[] = ["newapi.personal.api-key", "newapi.personal.oss-ak", "newapi.personal.oss-sk"].map(key => ({ store: "platform", key }));
export type ConfirmationAction = "clear" | "integration";
export function createConfirmationSession(now: () => number = Date.now) {
  let pending: { token: string; action: ConfirmationAction; targets: readonly string[]; expires: number } | undefined;
  return {
    issue(action: ConfirmationAction, targets: readonly string[]) {
      pending = { token: randomUUID(), action, targets: [...targets], expires: now() + 60_000 };
      return { token: pending.token, targets: [...pending.targets] };
    },
    consume(token: string, action: ConfirmationAction, targets: readonly string[]) {
      const current = pending; pending = undefined;
      if (!current || token !== current.token || action !== current.action || now() >= current.expires
        || JSON.stringify(targets) !== JSON.stringify(current.targets)) throw new Error("请重新确认操作 [CONFIRMATION_REQUIRED]");
    },
    invalidate() { pending = undefined; },
  };
}
export type ConfirmationSession = ReturnType<typeof createConfirmationSession>;
export type ClearResult = { readonly profilePresent: boolean; readonly credentials: readonly { readonly key: string; readonly present: boolean }[] };

/** Exact fixed targets only. Roll back partial credential deletion if any operation fails. */
export async function clearDesktopConfiguration(options: { readonly paths: DesktopPaths; readonly credentialStore: WritableCredentialStore; readonly session: ConfirmationSession; readonly token: string }): Promise<ClearResult> {
  const { paths, credentialStore: store } = options;
  options.session.consume(options.token, "clear", [paths.profile, ...desktopCredentialRefs.map(ref => ref.key)]);
  const profile = await snapshotFile(paths.profile); // Reject links/directories before any write.
  const values = [];
  for (const ref of desktopCredentialRefs) {
    if (!store.owns(ref)) throw new Error("无法读取平台凭据 [CLEAR_FAILED]");
    values.push({ ref, value: await store.resolve(ref) });
  }
  const attempted: typeof values = [];
  try {
    for (const entry of values) { attempted.push(entry); await store.delete(entry.ref); }
    if (profile.bytes !== undefined) await unlink(paths.profile);
  } catch {
    let failed = await restoreFiles([profile]);
    for (const { ref, value } of attempted.reverse()) {
      try { if (value === undefined) await store.delete(ref); else await store.put(ref, value); } catch { failed = true; }
    }
    throw new Error(`清除配置失败 [CLEAR_FAILED${failed ? "_ROLLBACK_FAILED" : ""}]`);
  }
  return { profilePresent: profile.bytes !== undefined, credentials: values.map(({ ref, value }) => ({ key: ref.key, present: value !== undefined })) };
}
