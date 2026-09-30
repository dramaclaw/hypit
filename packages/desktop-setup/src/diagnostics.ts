import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep, win32 } from "node:path";
import { promisify } from "node:util";
import { newApiDefaultBindings, parseNewApiEndpointConfig, testNewApiSetupConnection } from "@dramaclaw/provider-newapi";
import type { CredentialStore } from "@hypit/runtime";
import type { DesktopPaths } from "./paths.js";
import type { DiagnosticItem, SetupInput } from "./contracts.js";
import { desktopCredentialRefs } from "./clear-configuration.js";
import { isManagedLauncherInstalled } from "./launcher-install.js";
import type { UserPath } from "./launcher-install.js";
import { exists, isManagedLegacyCodexSkillInstalled, isManagedSkillInstalled, isManagedSkillOwned, skillBackupWarnings, skillRecoveryWarnings } from "./skill-install.js";
import { scanAgentTargets, supportedSkillTargets } from "./agent-targets.js";
import { transactionRecoveryWarnings } from "./recovery-discovery.js";

export function diagnosticEnvironment(bin: string, platform: "darwin" | "win32", source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR", "LANG"]) if (source[key] !== undefined) env[key] = source[key];
  const windows = source.SystemRoot ?? source.SYSTEMROOT ?? "C:\\Windows";
  env.PATH = platform === "darwin" ? `${bin}:/usr/bin:/bin` : `${bin};${windows}\\System32;${windows}`;
  env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

/** Verify the installed manifest without requiring a source checkout. */
export async function verifyInstalledResources(root: string, platform: "darwin" | "win32", arch: string): Promise<void> {
  const base = await realpath(root);
  const manifestPath = join(base, "resource-manifest.json");
  if (!(await lstat(manifestPath)).isFile()) throw new Error("Invalid resource manifest");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const suffix = platform === "win32" ? ".exe" : "";
  if (manifest.schemaVersion !== 1 || manifest.platform !== platform || manifest.arch !== arch || !manifest.files
    || ![`bin/ffmpeg${suffix}`, `bin/ffprobe${suffix}`, "runtime/node_modules/@hypit/hypit/bin/hypit.mjs", "skill/hypit/SKILL.md"].every(path => manifest.files[path])) throw new Error("Incomplete resource manifest");
  for (const [path, entry] of Object.entries(manifest.files) as [string, { sha256: string; bytes: number; link?: string }][]) {
    if (isAbsolute(path) || path.includes("\\") || path.split("/").some(part => !part || part === "." || part === ".." || part.includes(":"))) throw new Error("Invalid resource path");
    const full = resolve(base, path); const actual = await realpath(full);
    if (!actual.startsWith(base + sep)) throw new Error("Resource escapes bundle");
    const info = await lstat(full);
    if (entry.link !== undefined && (!info.isSymbolicLink() || !/^runtime\/node_modules\/(?:.*\/)?\.bin\/[^/]+$/u.test(path))) throw new Error("Invalid resource link");
    if (entry.link === undefined && !info.isFile()) throw new Error("Invalid resource file");
    const bytes = entry.link === undefined ? await readFile(full) : Buffer.from(await readlink(full));
    if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) throw new Error("Corrupt resource");
  }
}

type ExecuteOptions = { readonly timeout: number; readonly shell: false; readonly windowsHide: true; readonly maxBuffer: number; readonly env: NodeJS.ProcessEnv };
export type DiagnosticsOptions = {
  readonly paths: DesktopPaths; readonly resources: string; readonly home: string;
  readonly platform: "darwin" | "win32"; readonly arch: string; readonly electronExecutable: string;
  readonly credentialStore: CredentialStore & { owns(ref: typeof desktopCredentialRefs[number]): boolean }; readonly userPath?: UserPath;
  readonly execute?: (file: string, args: string[], options: ExecuteOptions) => Promise<unknown>;
  readonly testConnection?: typeof testNewApiSetupConnection;
};

export async function runDiagnostics(options: DiagnosticsOptions): Promise<readonly DiagnosticItem[]> {
  const { paths, resources, platform, credentialStore: store } = options;
  const results: DiagnosticItem[] = [];
  const run = options.execute ?? promisify(execFile);
  const path = platform === "win32" ? win32 : { join };
  const bin = path.join(resources, "bin"); const suffix = platform === "win32" ? ".exe" : "";
  const processOptions: ExecuteOptions = { timeout: 30_000, shell: false, windowsHide: true, maxBuffer: 1024 * 1024, env: diagnosticEnvironment(bin, platform) };
  const check = async (code: DiagnosticItem["code"], label: DiagnosticItem["label"], operation: () => Promise<unknown>, resource?: string) => {
    try { if (await operation() === false) throw new Error(); results.push({ code, label, status: "pass", ...(resource ? { path: resource } : {}) }); }
    catch { results.push({ code, label, status: "fail", ...(resource ? { path: resource } : {}) }); }
  };
  await check("bundle", "安装资源", () => verifyInstalledResources(resources, platform, options.arch), resources);
  await check("launcher", "命令入口", () => isManagedLauncherInstalled(options), paths.launcher);
  const requireBundle = () => { if (results[0]?.status !== "pass") throw new Error("Resources failed verification"); };
  await check("version", "Hypit 版本", () => { requireBundle(); return run(options.electronExecutable, [path.join(resources, "runtime", "node_modules", "@hypit", "hypit", "bin", "hypit.mjs"), "--version"], processOptions); });
  await check("ffmpeg", "FFmpeg", async () => { requireBundle(); await run(path.join(bin, `ffmpeg${suffix}`), ["-version"], processOptions); await run(path.join(bin, `ffprobe${suffix}`), ["-version"], processOptions); });
  const { targets: activeTargets } = await scanAgentTargets({ paths });
  const retained = await Promise.all(supportedSkillTargets(paths).filter(target => !activeTargets.some(active => active.id === target.id))
    .map(async target => ({ target, managed: await isManagedSkillOwned(target) })));
  for (const target of [...activeTargets, ...retained.filter(item => item.managed).map(item => item.target)]) {
    results.push({ code: "skill", target: target.id, label: target.label,
      status: await isManagedSkillInstalled(target) ? "pass" : "fail", path: target.skillDirectory });
    results.push(...await skillBackupWarnings(target));
  }
  if (await exists(paths.legacyCodexSkill) && !(await isManagedLegacyCodexSkillInstalled(paths))) {
    results.push({ code: "skill", target: "portable", label: "通用 Agent Skill", status: "warning", path: paths.legacyCodexSkill });
  }
  results.push(...await skillRecoveryWarnings(paths));
  results.push(...await transactionRecoveryWarnings(options));
  let config: ReturnType<typeof parseNewApiEndpointConfig> | undefined;
  await check("profile", "Runtime Profile", async () => {
    const profile = JSON.parse(await readFile(paths.profile, "utf8"));
    if (profile.format !== "hypit.runtime-local@1" || typeof profile.dataRoot !== "string" || !profile.dataRoot.trim()
      || profile.credentials?.platform?.use !== "@hypit/credential-store-platform"
      || profile.endpoints?.["newapi.personal"]?.use !== "@dramaclaw/provider-newapi" || profile.endpoints?.["newapi.personal"]?.pool !== "newapi.personal"
      || profile.endpoints?.["media.local"]?.use !== "@hypit/provider-media-local" || profile.endpoints?.["hyperframes.local"]?.use !== "@hypit/provider-hyperframes-local"
      || Object.entries(newApiDefaultBindings).some(([key, value]) => profile.bindings?.[key] !== value)) throw new Error();
    const parsed = parseNewApiEndpointConfig(profile.endpoints["newapi.personal"].config);
    if (!parsed.relay) throw new Error();
    const refs = [parsed.apiKey, parsed.relay.accessKeyId, parsed.relay.accessKeySecret];
    if (refs.some((ref, index) => ref.store !== desktopCredentialRefs[index]!.store || ref.key !== desktopCredentialRefs[index]!.key)) throw new Error();
    config = parsed;
  }, paths.profile);
  const secrets: string[] = [];
  await check("credentials", "平台凭据", async () => {
    for (const ref of desktopCredentialRefs) { const value = await store.resolve(ref); if (!store.owns(ref) || !value?.secret) throw new Error(); secrets.push(value.secret); }
  });
  if (config?.relay && secrets.length === 3) {
    const input: SetupInput = { baseUrl: config.baseUrl, apiKey: secrets[0]!, relay: { enabled: true, endpoint: config.relay.endpoint, bucket: config.relay.bucket, accessKeyId: secrets[1]!, accessKeySecret: secrets[2]! } };
    try {
      const connection = await (options.testConnection ?? testNewApiSetupConnection)(input);
      results.push({ code: "newapi", label: "NewAPI", status: "pass" }, connection.cleanupObjectKey
        ? { code: "oss", label: "OSS", status: "warning", cleanupObjectKey: connection.cleanupObjectKey }
        : { code: "oss", label: "OSS", status: "pass" });
    } catch (error) {
      const oss = error instanceof Error && error.message.startsWith("OSS ");
      results.push({ code: "newapi", label: "NewAPI", status: oss ? "pass" : "fail" }, { code: "oss", label: "OSS", status: oss ? "fail" : "warning" });
    }
  } else results.push({ code: "newapi", label: "NewAPI", status: "warning" }, { code: "oss", label: "OSS", status: "warning" });
  return results;
}
