import { isAbsolute, dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { mkdir, readFile } from "node:fs/promises";
import type { BrowserWindowConstructorOptions, WebContents } from "electron";
import { completeNewApiSetup, newApiDefaultBindings, parseNewApiEndpointConfig } from "@dramaclaw/provider-newapi";
import { PlatformCredentialStore } from "@hypit/credential-store-platform";
import type { DiagnosticItem, SetupInput, SetupProgress, SetupResult } from "./contracts.js";
import { IPC_CHANNELS } from "./ipc.js";
import type { SetupFailure, SetupReply } from "./ipc.js";
import { desktopPaths } from "./paths.js";
import { scanAgentTargets, supportedSkillTargets, targetSummary } from "./agent-targets.js";
import type { AgentScanResult } from "./agent-targets.js";
import { canRefreshManagedSkill, exists, isManagedLegacyCodexSkillInstalled, isManagedSkillInstalled } from "./skill-install.js";
import { atomicFile, isManagedLauncherInstalled, restoreFiles } from "./launcher-install.js";
import type { LauncherOptions } from "./launcher-install.js";
import { desktopMediaAvailable, prepareDesktopMediaRefresh } from "./profile.js";
import { commitDesktopSetup } from "./setup-core.js";
import { installDesktopIntegration, removeDesktopIntegration } from "./lifecycle.js";
import type { DesktopIntegrationOptions } from "./lifecycle.js";
import { runDiagnostics } from "./diagnostics.js";
import { clearDesktopConfiguration, createConfirmationSession, desktopCredentialRefs } from "./clear-configuration.js";

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
  if (![IPC_CHANNELS.status, IPC_CHANNELS.diagnostics, IPC_CHANNELS.openConfig, IPC_CHANNELS.clear, IPC_CHANNELS.removeIntegration, IPC_CHANNELS.subscribe, IPC_CHANNELS.unsubscribe].some((allowed) => allowed === channel) || args.length !== 0) throw new Error("Invalid setup arguments");
  return undefined;
}

const errorMessages: Readonly<Record<string, string>> = {
  SETUP_VALIDATION_FAILED: "配置校验失败", SETUP_NEWAPI_FAILED: "NewAPI 连接测试失败", SETUP_OSS_FAILED: "OSS 连接测试失败",
  SETUP_CREDENTIAL_SNAPSHOT_FAILED: "读取平台凭据失败", SETUP_CREDENTIAL_WRITE_FAILED: "保存平台凭据失败", SETUP_PROFILE_WRITE_FAILED: "写入 Runtime Profile 失败",
  INTEGRATION_INSTALL_FAILED: "桌面集成安装失败", SETUP_UNAVAILABLE: "此操作尚未可用", SETUP_REQUEST_FAILED: "操作失败，请检查配置后重试",
  INTEGRATION_REMOVE_FAILED: "本机集成卸载失败，已保留用户数据；请检查命令入口与 Skill 路径", CLEAR_FAILED: "清除配置失败", CONFIRMATION_REQUIRED: "确认已取消或过期，请重新操作",
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
  readonly clear: () => Promise<SetupResult>;
  readonly removeIntegration?: () => Promise<SetupResult>;
};

const diagnosticLabels = { bundle: "安装资源", launcher: "命令入口", version: "Hypit 版本", ffmpeg: "FFmpeg", profile: "Runtime Profile", credentials: "平台凭据", newapi: "NewAPI", oss: "OSS" } as const;
const skillLabels = { portable: "通用 Agent Skill", claude: "Claude Code Skill" } as const;
function publicDiagnostic(item: DiagnosticItem): DiagnosticItem {
  if (!["pass", "warning", "fail"].includes(item.status)) throw new Error("Invalid diagnostic result");
  if (item.code === "skill") {
    if (!item.target || !Object.hasOwn(skillLabels, item.target) || item.label !== skillLabels[item.target]) throw new Error("Invalid diagnostic result");
    return { code: "skill", status: item.status, label: skillLabels[item.target], target: item.target,
      ...(typeof item.path === "string" ? { path: item.path } : {}) };
  }
  if (!Object.hasOwn(diagnosticLabels, item.code) || item.label !== diagnosticLabels[item.code] || item.target !== undefined) throw new Error("Invalid diagnostic result");
  const key = item.code === "oss" && typeof item.cleanupObjectKey === "string" && /^relay\/hypit\/setup-test\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt$/u.test(item.cleanupObjectKey) ? item.cleanupObjectKey : undefined;
  return { code: item.code, status: item.status, label: diagnosticLabels[item.code], ...(typeof item.path === "string" ? { path: item.path } : {}), ...(key ? { cleanupObjectKey: key } : {}) };
}
function publicResult(result: SetupResult): SetupResult {
  const skillTargets = result.skillTargets.map(target => {
    if (!Object.hasOwn(skillLabels, target.id) || target.label !== skillLabels[target.id] || typeof target.path !== "string"
      || !Array.isArray(target.detectedAgents) || target.detectedAgents.some(id => !["codex", "claymore-piko", "cursor", "claude-code"].includes(id))) throw new Error("Invalid Skill target result");
    return { id: target.id, label: skillLabels[target.id], path: target.path, detectedAgents: [...target.detectedAgents] };
  });
  return { configured: result.configured === true, modelCount: Number.isSafeInteger(result.modelCount) && result.modelCount >= 0 ? result.modelCount : 0,
    relayVerified: result.relayVerified === true, profilePath: result.profilePath, skillTargets, launcherPath: result.launcherPath,
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
      return { ...result, diagnostics: [...result.diagnostics, ...(await services.diagnose()).map(publicDiagnostic)] };
    }),
    openConfigDirectory: () => enqueue(services.openConfig),
    clearConfiguration: () => enqueue(async () => publicResult(await services.clear())),
    removeIntegration: () => enqueue(async () => { if (!services.removeIntegration) throw new Error("Unavailable [SETUP_UNAVAILABLE]"); return publicResult(await services.removeIntegration()); }),
  };
}

export async function readDesktopStatus(options: Pick<LauncherOptions, "paths" | "platform" | "home" | "userPath"> & Partial<DesktopIntegrationOptions>, scan?: AgentScanResult): Promise<SetupResult> {
  const { paths } = options;
  const activeTargets = scan?.targets ?? options.targets ?? (await scanAgentTargets({ paths })).targets;
  const retained = await Promise.all(supportedSkillTargets(paths).filter(target => !activeTargets.some(active => active.id === target.id))
    .map(async target => ({ target, managed: await isManagedSkillInstalled(target) })));
  const targets = [...activeTargets, ...retained.filter(item => item.managed).map(item => item.target)];
  const profileValid = async () => {
    try {
      const profile = JSON.parse(await readFile(paths.profile, "utf8"));
      const endpoint = profile?.endpoints?.["newapi.personal"];
      if (profile?.format !== "hypit.runtime-local@1" || typeof profile.dataRoot !== "string" || !profile.dataRoot.trim()
        || profile.credentials?.platform?.use !== "@hypit/credential-store-platform"
        || endpoint?.use !== "@dramaclaw/provider-newapi" || endpoint.pool !== "newapi.personal"
        || profile.endpoints?.["media.local"]?.use !== "@hypit/provider-media-local"
        || profile.endpoints?.["hyperframes.local"]?.use !== "@hypit/provider-hyperframes-local"
        || Object.entries(newApiDefaultBindings).some(([key, value]) => profile.bindings?.[key] !== value)) return false;
      const config = parseNewApiEndpointConfig(endpoint.config);
      if (!config.relay) return false;
      for (const [ref, key] of [[config.apiKey, "newapi.personal.api-key"], [config.relay.accessKeyId, "newapi.personal.oss-ak"], [config.relay.accessKeySecret, "newapi.personal.oss-sk"]] as const) {
        if (ref.store !== "platform" || ref.key !== key) return false;
      }
      // Reuse the same nonblank/address checks as submission, without resolving credentials.
      validateIpcArguments(IPC_CHANNELS.submit, [{ baseUrl: config.baseUrl, apiKey: "status-validation", relay: {
        enabled: true, endpoint: config.relay.endpoint, bucket: config.relay.bucket, accessKeyId: "status-validation", accessKeySecret: "status-validation",
      } }]);
      return true;
    } catch { return false; }
  };
  const [profile, targetStates, launcher, evidence, media, legacyExists, legacyManaged] = await Promise.all([
    profileValid(), Promise.all(targets.map(async target => ({ target, installed: await isManagedSkillInstalled(target, options.sourceDirectory && options.installedVersion
      ? { sourceDirectory: options.sourceDirectory, installedVersion: options.installedVersion } : undefined) }))), isManagedLauncherInstalled(options),
    Promise.all([paths.profile, ...targets.flatMap(target => [target.skillDirectory, target.backupDirectory]), paths.launcher, paths.managedState, paths.legacyCodexSkill].map(exists)),
    desktopMediaAvailable(paths.profile), exists(paths.legacyCodexSkill), isManagedLegacyCodexSkillInstalled(paths),
  ]);
  const skillsReady = targetStates.every(({ installed }) => installed);
  return { configured: profile && skillsReady && launcher && media !== false, modelCount: 0, relayVerified: false,
    profilePath: paths.profile, skillTargets: targets.map(targetSummary), launcherPath: paths.launcher, diagnostics: evidence.some(Boolean) ? [
      { code: "profile", label: "Runtime Profile", status: profile ? "pass" : "fail", path: paths.profile },
      ...targetStates.map(({ target, installed }) => ({ code: "skill" as const, target: target.id, label: target.label, status: installed ? "pass" as const : "fail" as const, path: target.skillDirectory })),
      ...(legacyExists && !legacyManaged ? [{ code: "skill" as const, target: "portable" as const, label: "通用 Agent Skill" as const, status: "warning" as const, path: paths.legacyCodexSkill }] : []),
      { code: "launcher", label: "命令入口", status: launcher ? "pass" : "fail", path: paths.launcher },
      ...(profile && media !== undefined ? [{ code: "ffmpeg" as const, label: "FFmpeg" as const, status: media ? "pass" as const : "fail" as const }] : []),
    ] : [] };
}

/** Startup-only repair uses the saved profile; it never reads or asks for credentials. */
export async function refreshDesktopStatus(options: DesktopIntegrationOptions): Promise<SetupResult> {
  const before = await readDesktopStatus(options);
  if (before.configured || !before.diagnostics.some(item => item.code === "profile" && item.status === "pass")) return before;
  if (!(await Promise.all(options.targets.map(canRefreshManagedSkill))).every(Boolean)) return before;
  let media: Awaited<ReturnType<typeof prepareDesktopMediaRefresh>>;
  let profileRollbackFailed = false;
  try {
    media = await prepareDesktopMediaRefresh(options);
    if (media) await atomicFile(options.paths.profile, media.content, media.snapshot.mode);
    await installDesktopIntegration({ ...options, preserveExisting: true });
  } catch {
    if (media) profileRollbackFailed = await restoreFiles([media.snapshot]);
    // Failed refreshes leave stale integration visible and attempt to restore the original profile.
  }
  const result = await readDesktopStatus(options);
  return profileRollbackFailed ? { ...result, configured: false,
    diagnostics: result.diagnostics.map(item => item.code === "profile" ? { ...item, status: "warning" as const } : item) } : result;
}

/** Entry point is called by the bundled CJS footer, so unit tests never boot Electron. */
export async function startElectronShell(bundleDirectory: string): Promise<void> {
  const { app, BrowserWindow, ipcMain, shell, dialog } = await import("electron");
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  await app.whenReady();
  if (process.platform !== "darwin" && process.platform !== "win32") { app.quit(); return; }
  const platform = process.platform;
  const home = app.getPath("home");
  const paths = desktopPaths({ platform, home, appData: platform === "win32" ? process.env.LOCALAPPDATA || join(home, "AppData", "Local") : app.getPath("appData"),
    agentData: app.getPath("appData") });
  const resources = process.resourcesPath;
  const credentialStore = new PlatformCredentialStore({ directory: join(paths.hostState, "credentials"), platform });
  const integration: DesktopIntegrationOptions = { paths, targets: (await scanAgentTargets({ paths })).targets, platform, home, electronExecutable: process.execPath,
    cliEntry: join(resources, "runtime", "node_modules", "@hypit", "hypit", "bin", "hypit.mjs"), bundledBin: join(resources, "bin"),
    sourceDirectory: join(resources, "skill", "hypit"), installedVersion: app.getVersion() };
  // Refresh once per app launch so explicit removal in this session stays removed.
  const refreshed = await refreshDesktopStatus(integration);
  let refreshWarnings = refreshed.diagnostics.filter(item => item.status === "warning");
  const getStatus = async () => {
    const result = await readDesktopStatus(integration);
    return refreshWarnings.length ? { ...result, configured: false,
      diagnostics: result.diagnostics.map(item => refreshWarnings.find(warning => warning.code === item.code && warning.target === item.target && warning.path === item.path) ?? item) } : result;
  };
  const confirmation = createConfirmationSession();
  let window: InstanceType<typeof BrowserWindow> | undefined;
  const confirm = async (action: "clear" | "integration", targets: readonly string[]) => {
    if (!window || window.isDestroyed()) throw new Error("No active session [CONFIRMATION_REQUIRED]");
    const issued = confirmation.issue(action, targets);
    const response = await dialog.showMessageBox(window, { type: "warning", title: action === "clear" ? "清除本机配置和凭据" : "卸载本机集成",
      message: action === "clear" ? "清除以下本机配置和系统凭据？视频项目会保留。" : "移除以下命令入口、托管 Skill 和对应 PATH 配置？已有 Skill 备份会恢复，配置、凭据和视频项目会保留。",
      detail: targets.join("\n"), buttons: ["取消", "确认"], defaultId: 0, cancelId: 0, noLink: true });
    if (response.response !== 1) { confirmation.invalidate(); throw new Error("Cancelled [CONFIRMATION_REQUIRED]"); }
    return issued.token;
  };
  const suffix = platform === "win32" ? ".exe" : "";
  const controller = createSetupController({
    getStatus,
    commit: (input) => commitDesktopSetup(input, { paths, targets: integration.targets, platform, credentialStore, media: { ffmpegPath: join(resources, "bin", `ffmpeg${suffix}`), ffprobePath: join(resources, "bin", `ffprobe${suffix}`) } }),
    install: async () => { const result = await installDesktopIntegration(integration); refreshWarnings = []; return result; },
    diagnose: () => runDiagnostics({ paths, resources, platform, arch: process.arch, home, electronExecutable: process.execPath, credentialStore }),
    openConfig: async () => { await mkdir(dirname(paths.profile), { recursive: true }); if (await shell.openPath(dirname(paths.profile))) throw new Error("Open failed"); },
    clear: async () => { const token = await confirm("clear", [paths.profile, ...desktopCredentialRefs.map(ref => ref.key)]); await clearDesktopConfiguration({ paths, credentialStore, session: confirmation, token }); refreshWarnings = []; return getStatus(); },
    removeIntegration: async () => {
      const targets = [paths.launcher, paths.skill, paths.managedState, platform === "darwin" ? join(home, ".zprofile") : "HKCU\\Environment\\Path"];
      const token = await confirm("integration", targets); confirmation.consume(token, "integration", targets);
      await removeDesktopIntegration({ paths, platform, home }); return getStatus();
    },
  });
  const pageUrl = localPageUrl(join(bundleDirectory, "index.html"));
  let unsubscribe: (() => void) | undefined;
  const detach = () => { unsubscribe?.(); unsubscribe = undefined; };
  const createWindow = async () => {
    window = new BrowserWindow(browserWindowOptions(join(bundleDirectory, "preload.cjs")));
    hardenWebContents(window.webContents);
    window.webContents.on("destroyed", detach);
    window.webContents.on("did-start-loading", detach);
    window.webContents.on("did-start-loading", () => confirmation.invalidate());
    window.webContents.on("destroyed", () => confirmation.invalidate());
    window.on("closed", () => { window = undefined; detach(); });
    await window.loadURL(pageUrl);
  };
  const operations = { [IPC_CHANNELS.status]: controller.getStatus, [IPC_CHANNELS.submit]: controller.submit,
    [IPC_CHANNELS.diagnostics]: controller.rerunDiagnostics, [IPC_CHANNELS.openConfig]: controller.openConfigDirectory, [IPC_CHANNELS.clear]: controller.clearConfiguration, [IPC_CHANNELS.removeIntegration]: controller.removeIntegration };
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
