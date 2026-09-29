import type { SetupInput, SetupProgress, SetupResult } from "./contracts.js";

export const IPC_CHANNELS = Object.freeze({
  status: "setup:status", submit: "setup:submit", diagnostics: "setup:diagnostics",
  openConfig: "setup:open-config", clear: "setup:clear", progress: "setup:progress",
  subscribe: "setup:subscribe", unsubscribe: "setup:unsubscribe",
  removeIntegration: "setup:remove-integration",
} as const);
export type IpcChannel = typeof IPC_CHANNELS[keyof typeof IPC_CHANNELS];
export type SetupFailure = { readonly code: string; readonly message: string; readonly cleanupObjectKey?: string };
export type SetupReply<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: SetupFailure };
export type SetupBridge = {
  readonly getStatus: () => Promise<SetupReply<SetupResult>>;
  readonly submit: (input: SetupInput) => Promise<SetupReply<SetupResult>>;
  readonly rerunDiagnostics: () => Promise<SetupReply<SetupResult>>;
  readonly openConfigDirectory: () => Promise<SetupReply<void>>;
  readonly clearConfiguration: () => Promise<SetupReply<SetupResult>>;
  readonly removeIntegration: () => Promise<SetupReply<SetupResult>>;
  readonly onProgress: (listener: (progress: SetupProgress) => void) => () => void;
};
