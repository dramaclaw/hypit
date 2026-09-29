import { isAbsolute, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import type { BrowserWindowConstructorOptions, WebContents } from "electron";
import { completeNewApiSetup } from "@dramaclaw/provider-newapi";
import { PlatformCredentialStore } from "@hypit/credential-store-platform";
import type { DiagnosticItem, SetupInput, SetupProgress, SetupResult } from "./contracts.js";
import { IPC_CHANNELS } from "./ipc.js";
import type { SetupFailure, SetupReply } from "./ipc.js";
import { desktopPaths } from "./paths.js";
import { commitDesktopSetup } from "./setup-core.js";
import { installDesktopIntegration } from "./lifecycle.js";

export function browserWindowOptions(preloadPath: string): BrowserWindowConstructorOptions {
  if (!isAbsolute(preloadPath)) throw new Error("Absolute preload path required");
  return { width: 920, height: 760, minWidth: 720, minHeight: 600, title: "Hypit 设置", backgroundColor: "#f3f6fa", autoHideMenuBar: true,
    webPreferences: { preload: preloadPath, contextIsolation: true, nodeIntegration: false, sandbox: true, webviewTag: false, webSecurity: true, devTools: false } };
}

export function localPageUrl(path: string): string {
  if (!isAbsolute(path)) throw new Error("Absolute local page required");
  return pathToFileURL(path).href;
}

export function isTrustedSender(event: { sender: unknown; senderFrame: unknown }, contents: { mainFrame?: { url: string } }, pageUrl: string): boolean {
  return pageUrl.startsWith("file:") && event.sender === contents && event.senderFrame === contents.mainFrame && contents.mainFrame?.url === pageUrl;
}

export function hardenWebContents(contents: WebContents): void {
  const refuse = (event: { preventDefault(): void }) => { event.preventDefault(); };
  contents.on("will-navigate", refuse);
  contents.on("will-frame-navigate", refuse);
  contents.on("will-redirect", refuse);
  contents.on("will-attach-webview", refuse);
  contents.setWindowOpenHandler(() => ({ action: "deny" }));
  contents.session.setPermissionRequestHandler((_contents, _permission, callback) => { callback(false); });
  contents.session.setPermissionCheckHandler(() => false);
}

function exactKeys(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype
    || Object.keys(value).length !== keys.length || Object.keys(value).some((key) => !keys.includes(key))) throw new Error("Invalid setup arguments");
}

export function validateIpcArguments(channel: string, args: readonly unknown[]): SetupInput | undefined {
  if (channel === IPC_CHANNELS.submit) {
    if (args.length !== 1) throw new Error("Invalid setup arguments");
    const value = args[0];
    exactKeys(value, ["baseUrl", "apiKey", "relay"]);
    exactKeys(value.relay, ["enabled", "endpoint", "bucket", "accessKeyId", "accessKeySecret"]);
    if (value.relay.enabled !== true) throw new Error("Invalid setup arguments");
    for (const field of [value.baseUrl, value.apiKey, value.relay.endpoint, value.relay.bucket, value.relay.accessKeyId, value.relay.accessKeySecret]) {
      if (typeof field !== "string" || !field.trim() || field.length > 8192 || /[\u0000-\u001f\u007f]/u.test(field)) throw new Error("Invalid setup arguments");
    }
    // URL credentials/query fragments are never ordinary resumable configuration.
    const url = new URL(value.baseUrl as string);
    if (url.username || url.password || url.search || url.hash) throw new Error("Invalid setup arguments");
    const endpoint = new URL((value.relay.endpoint as string).includes("://") ? value.relay.endpoint as string : `https://${value.relay.endpoint as string}`);
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== "/") throw new Error("Invalid setup arguments");
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/u.test(value.relay.bucket as string)) throw new Error("Invalid setup arguments");
    const input = value as unknown as SetupInput;
    completeNewApiSetup(input);
    return { baseUrl: input.baseUrl, apiKey: input.apiKey, relay: { ...input.relay } };
  }
  if (![IPC_CHANNELS.status, IPC_CHANNELS.diagnostics, IPC_CHANNELS.openConfig, IPC_CHANNELS.clear, IPC_CHANNELS.subscribe, IPC_CHANNELS.unsubscribe].some((allowed) => allowed === channel) || args.length !== 0) throw new Error("Invalid setup arguments");
  return undefined;
}

const errorMessages: Readonly<Record<string, string>> = {
  SETUP_VALIDATION_FAILED: "配置校验失败", SETUP_NEWAPI_FAILED: "NewAPI 连接测试失败", SETUP_OSS_FAILED: "OSS 连接测试失败",
  SETUP_CREDENTIAL_SNAPSHOT_FAILED: "读取平台凭据失败", SETUP_CREDENTIAL_WRITE_FAILED: "保存平台凭据失败", SETUP_PROFILE_WRITE_FAILED: "写入 Runtime Profile 失败",
  INTEGRATION_INSTALL_FAILED: "桌面集成安装失败", SETUP_UNAVAILABLE: "此操作尚未可用", SETUP_REQUEST_FAILED: "操作失败，请检查配置后重试",
};
export function serializeFailure(error: unknown): SetupFailure {
  const candidate = error instanceof Error ? /\[([A-Z_]+)\]$/u.exec(error.message)?.[1] : undefined;
  const base = candidate?.replace(/_ROLLBACK_FAILED$/u, "");
  const known = base && Object.hasOwn(errorMessages, base);
  const code = known ? candidate! : "SETUP_REQUEST_FAILED";
  const message = known ? `${errorMessages[base!]}${candidate !== base ? "；回滚未完成，请重新运行诊断" : ""}` : errorMessages.SETUP_REQUEST_FAILED!;
  const key = error && typeof error === "object" && "cleanupObjectKey" in error ? error.cleanupObjectKey : undefined;
  return { code, message, ...(code === "SETUP_OSS_FAILED" && typeof key === "string" && /^relay\/hypit\/setup-test\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt$/u.test(key) ? { cleanupObjectKey: key } : {}) };
}

export type SetupServices = {
  readonly getStatus: () => Promise<SetupResult>;
  readonly commit: (input: SetupInput) => Promise<SetupResult>;
  readonly install: () => Promise<unknown>;
  readonly diagnose: () => Promise<readonly DiagnosticItem[]>;
  readonly openConfig: () => Promise<void>;
  /** Task 8 supplies session-confirmed clearing and full diagnostics at this boundary. */
  readonly clear: () => Promise<SetupResult>;
};

const diagnosticLabels = { bundle: "安装资源", launcher: "命令入口", version: "Hypit 版本", ffmpeg: "FFmpeg", skill: "Codex Skill", profile: "Runtime Profile", credentials: "平台凭据", newapi: "NewAPI", oss: "OSS" } as const;
function publicDiagnostic(item: DiagnosticItem): DiagnosticItem {
  if (!Object.hasOwn(diagnosticLabels, item.code) || !["pass", "warning", "fail"].includes(item.status)) throw new Error("Invalid diagnostic result");
  return { code: item.code, status: item.status, label: diagnosticLabels[item.code], ...(typeof item.path === "string" ? { path: item.path } : {}) };
}
function publicResult(result: SetupResult): SetupResult {
  return { configured: result.configured === true, modelCount: Number.isSafeInteger(result.modelCount) && result.modelCount >= 0 ? result.modelCount : 0,
    relayVerified: result.relayVerified === true, profilePath: result.profilePath, skillPath: result.skillPath, launcherPath: result.launcherPath,
    diagnostics: result.diagnostics.map(publicDiagnostic) };
}

export function createSetupController(services: SetupServices) {
  const listeners = new Set<(progress: SetupProgress) => void>();
  let tail: Promise<unknown> = Promise.resolve();
  const emit = (progress: SetupProgress) => { for (const listener of listeners) { try { listener(progress); } catch { /* Closed renderer must not interrupt a transaction. */ } } };
  function enqueue<T>(operation: () => Promise<T>): Promise<SetupReply<T>> {
    const pending = tail.then(async (): Promise<SetupReply<T>> => {
      try { return { ok: true, value: await operation() }; }
      catch (error) { return { ok: false, error: serializeFailure(error) }; }
    });
    tail = pending;
    return pending;
  }
  return {
    subscribe(listener: (progress: SetupProgress) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getStatus: () => enqueue(async () => publicResult(await services.getStatus())),
    submit: (input: SetupInput) => enqueue(async () => {
      emit({ kind: "stage", stage: "validating" });
      const validated = validateIpcArguments(IPC_CHANNELS.submit, [input])!;
      emit({ kind: "stage", stage: "testing-newapi" });
      const result = publicResult(await services.commit(validated));
      emit({ kind: "model-count", count: result.modelCount });
      emit({ kind: "stage", stage: "installing-launcher" });
      await services.install();
      emit({ kind: "stage", stage: "diagnosing" });
      const diagnostics = (await services.diagnose()).map(publicDiagnostic);
      for (const item of diagnostics) emit({ kind: "diagnostic", item });
      emit({ kind: "stage", stage: "complete" });
      return { ...result, diagnostics: [...result.diagnostics, ...diagnostics] };
    }),
    rerunDiagnostics: () => enqueue(async () => {
      emit({ kind: "stage", stage: "diagnosing" });
      const result = publicResult(await services.getStatus());
      return { ...result, diagnostics: (await services.diagnose()).map(publicDiagnostic) };
    }),
    openConfigDirectory: () => enqueue(services.openConfig),
    clearConfiguration: () => enqueue(async () => publicResult(await services.clear())),
  };
}

/** Entry point is called by the bundled CJS footer, so unit tests never boot Electron. */
export async function startElectronShell(bundleDirectory: string): Promise<void> {
  const { app, BrowserWindow, ipcMain, shell } = await import("electron");
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  await app.whenReady();
  if (process.platform !== "darwin" && process.platform !== "win32") { app.quit(); return; }
  const platform = process.platform;
  const home = app.getPath("home");
  const paths = desktopPaths({ platform, home, appData: platform === "win32" ? process.env.LOCALAPPDATA || join(home, "AppData", "Local") : app.getPath("appData") });
  const resources = process.resourcesPath;
  const credentialStore = new PlatformCredentialStore({ directory: join(paths.hostState, "credentials"), platform });
  const emptyResult = (): SetupResult => ({ configured: false, modelCount: 0, relayVerified: false, profilePath: paths.profile, skillPath: paths.skill, launcherPath: paths.launcher, diagnostics: [] });
  const getStatus = async (): Promise<SetupResult> => {
    const result = emptyResult();
    try {
      const profile = JSON.parse(await readFile(paths.profile, "utf8"));
      return { ...result, configured: profile?.format === "hypit.runtime-local@1" && typeof profile?.endpoints?.["newapi.personal"]?.config?.baseUrl === "string" };
    } catch { return result; }
  };
  const controller = createSetupController({
    getStatus,
    commit: (input) => commitDesktopSetup(input, { paths, platform, credentialStore }),
    install: () => installDesktopIntegration({ paths, platform, home, electronExecutable: process.execPath,
      cliEntry: join(resources, "runtime", "node_modules", "@hypit", "hypit", "bin", "hypit.mjs"), sourceDirectory: join(resources, "skill", "hypit"), installedVersion: app.getVersion() }),
    diagnose: async () => [{ code: "bundle", label: "安装资源", status: "warning" }],
    openConfig: async () => { await mkdir(dirname(paths.profile), { recursive: true }); if (await shell.openPath(dirname(paths.profile))) throw new Error("Open failed"); },
    clear: async () => { throw new Error("Unavailable [SETUP_UNAVAILABLE]"); },
  });
  const pageUrl = localPageUrl(join(bundleDirectory, "index.html"));
  let window: InstanceType<typeof BrowserWindow> | undefined;
  let unsubscribe: (() => void) | undefined;
  const detach = () => { unsubscribe?.(); unsubscribe = undefined; };
  const createWindow = async () => {
    window = new BrowserWindow(browserWindowOptions(join(bundleDirectory, "preload.cjs")));
    hardenWebContents(window.webContents);
    window.webContents.on("destroyed", detach);
    window.webContents.on("did-start-loading", detach);
    window.on("closed", () => { window = undefined; detach(); });
    await window.loadURL(pageUrl);
  };
  const operations = { [IPC_CHANNELS.status]: controller.getStatus, [IPC_CHANNELS.submit]: controller.submit,
    [IPC_CHANNELS.diagnostics]: controller.rerunDiagnostics, [IPC_CHANNELS.openConfig]: controller.openConfigDirectory, [IPC_CHANNELS.clear]: controller.clearConfiguration };
  for (const channel of Object.keys(operations) as (keyof typeof operations)[]) {
    ipcMain.handle(channel, async (event, ...args: unknown[]) => {
      try {
        if (!window || !isTrustedSender(event, window.webContents, pageUrl)) throw new Error("Untrusted sender");
        const input = validateIpcArguments(channel, args);
        return channel === IPC_CHANNELS.submit ? await controller.submit(input!) : await (operations[channel] as () => Promise<unknown>)();
      } catch (error) { return { ok: false, error: serializeFailure(error) }; }
    });
  }
  for (const channel of [IPC_CHANNELS.subscribe, IPC_CHANNELS.unsubscribe]) {
    ipcMain.on(channel, (event, ...args: unknown[]) => {
      if (!window || !isTrustedSender(event, window.webContents, pageUrl)) return;
      try { validateIpcArguments(channel, args); } catch { return; }
      detach();
      if (channel === IPC_CHANNELS.subscribe) {
        const contents = window.webContents;
        unsubscribe = controller.subscribe((progress) => { if (!contents.isDestroyed() && contents.mainFrame.url === pageUrl) contents.send(IPC_CHANNELS.progress, progress); });
      }
    });
  }
  app.on("second-instance", () => { window?.show(); window?.focus(); });
  app.on("activate", () => { if (!window) void createWindow(); });
  app.on("window-all-closed", () => { if (platform !== "darwin") app.quit(); });
  await createWindow();
}
