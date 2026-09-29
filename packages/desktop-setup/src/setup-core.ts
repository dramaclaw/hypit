import { randomUUID } from "node:crypto";
import { mkdir, open, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";

import { completeNewApiSetup, testNewApiSetupConnection } from "@dramaclaw/provider-newapi";
import type { NewApiConnectionTestDependencies } from "@dramaclaw/provider-newapi";
import type { CanonicalValue } from "@hypit/protocol";
import type { CredentialRef, CredentialValue, WritableCredentialStore } from "@hypit/runtime";

import type { SetupInput, SetupResult } from "./contracts.js";
import type { DesktopPaths } from "./paths.js";
import { createDesktopProfile } from "./profile.js";

export type DesktopSetupDependencies = {
  readonly paths: DesktopPaths;
  readonly credentialStore: WritableCredentialStore;
  readonly platform?: NodeJS.Platform;
  readonly connectionTest?: NewApiConnectionTestDependencies;
  /** Must replace atomically: rejection means the previous profile is still in place. */
  readonly writeProfile?: (path: string, document: CanonicalValue, options: { readonly mode?: number }) => Promise<void>;
};

type Snapshot = { readonly ref: CredentialRef; readonly value: CredentialValue | undefined };

const failures = {
  VALIDATION: "配置校验失败",
  NEWAPI: "NewAPI 连接测试失败",
  OSS: "OSS 连接测试失败",
  CREDENTIAL_SNAPSHOT: "读取平台凭据失败",
  CREDENTIAL_WRITE: "保存平台凭据失败",
  PROFILE_WRITE: "写入 Runtime Profile 失败",
} as const;

function failure(stage: keyof typeof failures, rollbackFailed = false): Error {
  // Never attach the original error or cause: SDK and OS errors may contain secrets.
  return new Error(`${failures[stage]}${rollbackFailed ? "；平台凭据回滚未完成" : ""} [SETUP_${stage}_FAILED${rollbackFailed ? "_ROLLBACK_FAILED" : ""}]`);
}

function cleanupObjectKey(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  // Accept only the provider's complete cleanup message and its UUID-v4 probe path.
  // Never copy arbitrary upstream text into an outbound error.
  const match = /^OSS probe cleanup failed; remove object (relay\/hypit\/setup-test\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt) manually$/u.exec(error.message);
  return match?.[0] === error.message ? match[1] : undefined;
}

async function writeProfileAtomically(path: string, document: CanonicalValue, options: { readonly mode?: number }): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true });
  const temporary = join(directory, `.desktop-profile-${randomUUID()}.tmp`);
  let created = false;
  try {
    const file = await open(temporary, "wx", options.mode);
    created = true;
    try {
      // Explicit chmod also guarantees 0600 with a restrictive inherited umask.
      if (options.mode !== undefined) await file.chmod(options.mode);
      await file.writeFile(`${JSON.stringify(document, null, 2)}\n`, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(temporary, path);
  } catch (error) {
    if (created) await unlink(temporary).catch(() => {});
    throw error;
  }
}

async function rollback(store: WritableCredentialStore, attempted: readonly Snapshot[]): Promise<boolean> {
  let failed = false;
  for (const snapshot of [...attempted].reverse()) {
    try {
      if (snapshot.value === undefined) await store.delete(snapshot.ref);
      else await store.put(snapshot.ref, snapshot.value);
    } catch {
      failed = true;
    }
  }
  return failed;
}

export async function commitDesktopSetup(input: SetupInput, dependencies: DesktopSetupDependencies): Promise<SetupResult> {
  let setup: ReturnType<typeof completeNewApiSetup>;
  let submitted: SetupInput;
  try {
    // IPC data is not trusted merely because the TypeScript contract requires OSS.
    if (input.relay.enabled !== true) throw failure("VALIDATION");
    submitted = { ...input, relay: { ...input.relay } };
    setup = completeNewApiSetup(submitted);
  } catch {
    throw failure("VALIDATION");
  }

  let connection: Awaited<ReturnType<typeof testNewApiSetupConnection>>;
  try {
    connection = await testNewApiSetupConnection(submitted, dependencies.connectionTest);
  } catch (error) {
    // The provider owns the OSS stage; only classify it, never forward its message.
    const stage = error instanceof Error && error.message.startsWith("OSS ") ? "OSS" : "NEWAPI";
    const safeError = failure(stage);
    const key = stage === "OSS" ? cleanupObjectKey(error) : undefined;
    if (key !== undefined) Object.assign(safeError, { cleanupObjectKey: key });
    throw safeError;
  }

  const store = dependencies.credentialStore;
  const config = setup.config as Record<string, CanonicalValue>;
  const snapshots: Snapshot[] = [];
  try {
    for (const credential of setup.credentials) {
      const ref = config[credential.slot] as CredentialRef;
      if (!store.owns(ref)) throw failure("CREDENTIAL_SNAPSHOT");
      const value = await store.resolve(ref);
      snapshots.push({ ref, value: value === undefined ? undefined : { ...value } });
    }
  } catch {
    throw failure("CREDENTIAL_SNAPSHOT");
  }

  const attempted: Snapshot[] = [];
  let stage: "CREDENTIAL_WRITE" | "PROFILE_WRITE" = "CREDENTIAL_WRITE";
  try {
    for (const [index, credential] of setup.credentials.entries()) {
      const snapshot = snapshots[index]!;
      // A store may mutate and then reject; that attempted write must also be restored.
      attempted.push(snapshot);
      await store.put(snapshot.ref, { secret: credential.secret });
    }
    stage = "PROFILE_WRITE";
    const options = (dependencies.platform ?? process.platform) === "win32" ? {} : { mode: 0o600 };
    await (dependencies.writeProfile ?? writeProfileAtomically)(dependencies.paths.profile, createDesktopProfile(setup.config), options);
  } catch {
    throw failure(stage, await rollback(store, attempted));
  }

  return {
    configured: true,
    modelCount: connection.modelCount,
    relayVerified: connection.relayVerified,
    profilePath: dependencies.paths.profile,
    skillPath: dependencies.paths.skill,
    launcherPath: dependencies.paths.launcher,
    diagnostics: [
      { code: "newapi", status: "pass", label: "NewAPI" },
      { code: "oss", status: "pass", label: "OSS" },
      { code: "credentials", status: "pass", label: "平台凭据" },
      { code: "profile", status: "pass", label: "Runtime Profile", path: dependencies.paths.profile },
    ],
  };
}
