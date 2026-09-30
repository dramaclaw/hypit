import { execFile, spawn } from "node:child_process";
import { access, lstat, readFile, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { dirname, isAbsolute, join, resolve, win32 } from "node:path";
import { prepareFileChange, snapshotFile } from "./launcher-install.js";
import { whisperXProgramPaths } from "./paths.js";
import type { DesktopPaths } from "./paths.js";
import type { PreparedRemoval } from "./skill-install.js";
import { LOCAL_WHISPERX_ENDPOINT, isWhisperXProfileActivated, prepareWhisperXProfile } from "./whisperx-profile.js";
import type { PreparedWhisperXProfile } from "./whisperx-profile.js";

/** The CLI has no structured boundary inside Python + ASR + Chinese preparation. */
export type WhisperXProgressStage = "preparing-runtime" | "preparing-en" | "starting-service" | "ready";
export type WhisperXProgramCode = "WHISPERX_BUNDLED_UV_INVALID" | "WHISPERX_PROFILE_REQUIRED"
  | "WHISPERX_PROFILE_INVALID" | "WHISPERX_PROFILE_CONFLICT" | "WHISPERX_PROFILE_PREPARE_FAILED"
  | "WHISPERX_PROFILE_COMMIT_FAILED" | "WHISPERX_COMMAND_FAILED" | "WHISPERX_INVALID_REPORT"
  | "WHISPERX_OUTPUT_LIMIT" | "WHISPERX_TIMEOUT" | "WHISPERX_NOT_READY" | "WHISPERX_STATE_FAILED"
  | "WHISPERX_CLEANUP_INCOMPLETE";
export type WhisperXProgramStatus = {
  readonly state: "not-installed" | "preparing" | "prepared" | "stopped" | "stopping" | "starting" | "ready" | "mismatch" | "failed";
  readonly stage?: WhisperXProgressStage;
  readonly code?: WhisperXProgramCode;
  readonly logPath?: string;
  readonly cleanupIncomplete?: boolean;
};
export type WhisperXProgressReporter = (stage: WhisperXProgressStage) => void;
export type WhisperXProgramService = {
  status(): Promise<WhisperXProgramStatus>;
  /** signal detaches only this observer. Preparation belongs to the main process, not a renderer. */
  installAndStart(report?: WhisperXProgressReporter, signal?: AbortSignal): Promise<WhisperXProgramStatus>;
  start(report?: WhisperXProgressReporter, signal?: AbortSignal): Promise<WhisperXProgramStatus>;
  stop(): Promise<WhisperXProgramStatus>;
};
export type WhisperXProgramOptions = {
  readonly paths: Pick<DesktopPaths, "hostState" | "profile">;
  readonly platform: "darwin" | "win32";
  /** Electron is the packaged Node executable, launched with ELECTRON_RUN_AS_NODE=1. */
  readonly electronExecutable: string;
  readonly cliEntry: string;
  readonly bundledBin: string;
  readonly bundledUv: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
};
type Action = "prepare" | "up" | "down" | "status";
type Operation = "install" | "start" | "stop";
type RecordValue = Record<string, unknown>;
type ProgramReport = { readonly ok: boolean; readonly ready: boolean; readonly program?: RecordValue };
type SavedState = { readonly format: "hypit.desktop-whisperx@1"; readonly prepared: true; readonly stopped: boolean };
const record = (value: unknown): value is RecordValue => value !== null && typeof value === "object" && !Array.isArray(value);
class ProgramError extends Error {
  constructor(readonly code: WhisperXProgramCode) { super(code); }
}

/** Preserve OS/network essentials, with bundled uv first; never inherit interpreter or uv overrides. */
function programEnvironment(options: WhisperXProgramOptions): NodeJS.ProcessEnv {
  const inherited = options.env ?? process.env;
  const env: NodeJS.ProcessEnv = {};
  for (const name of ["HOME", "USERPROFILE", "LOCALAPPDATA", "APPDATA", "SystemRoot", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "TMPDIR",
    "LANG", "LC_ALL", "HTTPS_PROXY", "HTTP_PROXY", "ALL_PROXY", "NO_PROXY", "https_proxy", "http_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR"]) {
    if (inherited[name] !== undefined) env[name] = inherited[name];
  }
  const separator = options.platform === "win32" ? ";" : ":";
  const path = inherited.PATH ?? (options.platform === "win32" ? inherited.Path : undefined);
  env.PATH = `${options.bundledBin}${path ? `${separator}${path}` : ""}`;
  env.HYPIT_STATE_HOME = options.paths.hostState;
  env.ELECTRON_RUN_AS_NODE = "1";
  return env;
}

async function validateBundledUv(options: WhisperXProgramOptions): Promise<void> {
  try {
    const uv = options.bundledUv;
    if (!isAbsolute(uv) || !isAbsolute(options.bundledBin)
      || resolve(uv) !== join(resolve(options.bundledBin), options.platform === "win32" ? "uv.exe" : "uv")
      || !(await lstat(uv)).isFile()
      || await realpath(uv) !== join(await realpath(options.bundledBin), options.platform === "win32" ? "uv.exe" : "uv")) throw new Error();
    await access(uv, options.platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch { throw new ProgramError("WHISPERX_BUNDLED_UV_INVALID"); }
}

/** Bound both pipes. Terminating a prepare CLI also terminates its owned installation children. */
async function execute(options: WhisperXProgramOptions, action: Action, profile: string): Promise<ProgramReport> {
  if (![options.electronExecutable, options.cliEntry, options.paths.hostState, profile].every(isAbsolute)) throw new ProgramError("WHISPERX_COMMAND_FAILED");
  if (action !== "status") await validateBundledUv(options);
  const env = programEnvironment(options);
  let exitCode: number | null = null;
  const output = await new Promise<string>((settle, reject) => {
    const child = spawn(options.electronExecutable, [options.cliEntry, "programs", action, "--runtime", profile, "--endpoint", LOCAL_WHISPERX_ENDPOINT, "--json"], {
      cwd: dirname(profile), env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let bytes = 0;
    let failure: ProgramError | undefined;
    const terminate = (code: WhisperXProgramCode) => {
      if (failure) return;
      failure = new ProgramError(code);
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        // Use the system binary, not a taskkill found through the inherited PATH.
        const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? "C:\\Windows";
        execFile(win32.join(systemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"],
          { shell: false, windowsHide: true, timeout: 15_000 }, () => { if (child.exitCode === null) child.kill("SIGKILL"); });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    };
    const timer = setTimeout(() => terminate("WHISPERX_TIMEOUT"), options.timeoutMs ?? (action === "prepare" ? 2 * 60 * 60_000 : action === "up" ? 10 * 60_000 : 90_000));
    const collect = (chunk: Buffer, stdout: boolean) => {
      bytes += chunk.length;
      if (bytes > (options.maxOutputBytes ?? 256 * 1024)) terminate("WHISPERX_OUTPUT_LIMIT");
      else if (stdout && !failure) chunks.push(chunk);
    };
    child.stdout.on("data", (chunk: Buffer) => collect(chunk, true));
    child.stderr.on("data", (chunk: Buffer) => collect(chunk, false));
    child.on("error", () => { clearTimeout(timer); reject(new ProgramError("WHISPERX_COMMAND_FAILED")); });
    child.on("close", code => {
      clearTimeout(timer);
      exitCode = code;
      if (failure) reject(failure);
      else if (code !== 0 && chunks.length === 0) reject(new ProgramError("WHISPERX_COMMAND_FAILED"));
      else settle(Buffer.concat(chunks).toString("utf8"));
    });
  });
  let value: unknown;
  try { value = JSON.parse(output); } catch { throw new ProgramError("WHISPERX_INVALID_REPORT"); }
  if (!record(value) || value.format !== "hypit.cli-programs@1" || value.action !== action || value.programCount !== 1
    || typeof value.ok !== "boolean" || typeof value.ready !== "boolean" || !Array.isArray(value.programs)
    || ![0, 1].includes(value.readyCount as number) || value.ready !== (value.readyCount === 1)) throw new ProgramError("WHISPERX_INVALID_REPORT");
  const ok = exitCode === 0 && value.ok;
  // Unsuccessful non-ready reports still describe stopped/mismatched Programs, but cannot attest readiness.
  if (!ok && (value.ok || value.ready)) throw new ProgramError("WHISPERX_COMMAND_FAILED");
  const programs = value.programs;
  if (programs.length > 1 || (action === "status" && programs.length !== 1)) throw new ProgramError("WHISPERX_INVALID_REPORT");
  const program: unknown = programs[0];
  if (program !== undefined && (!record(program) || program.endpoint !== LOCAL_WHISPERX_ENDPOINT || program.id !== LOCAL_WHISPERX_ENDPOINT
    || !["ready", "down", "mismatch"].includes(program.state as string))) throw new ProgramError("WHISPERX_INVALID_REPORT");
  if (record(program) && value.ready !== (program.state === "ready")) throw new ProgramError("WHISPERX_INVALID_REPORT");
  return { ok, ready: value.ready, ...(record(program) ? { program } : {}) };
}

/** Own one instance in the desktop main process. No lifecycle work is owned by an observer. */
export function createWhisperXProgramService(options: WhisperXProgramOptions): WhisperXProgramService {
  const paths = whisperXProgramPaths(options.paths);
  let current: WhisperXProgramStatus = { state: "not-installed" };
  let activeStage: WhisperXProgressStage | undefined;
  let mutationRevision = 0;
  let active: { operation: Operation; promise: Promise<WhisperXProgramStatus>; observers: Set<WhisperXProgressReporter> } | undefined;
  const failure = (code: WhisperXProgramCode): WhisperXProgramStatus => ({ state: "failed", code,
    ...(activeStage ? { stage: activeStage } : {}), logPath: activeStage === "starting-service" ? paths.serviceLog : paths.installationLog });
  const errorStatus = (error: unknown): WhisperXProgramStatus => {
    if (error instanceof ProgramError) return failure(error.code);
    const known = ["WHISPERX_PROFILE_REQUIRED", "WHISPERX_PROFILE_INVALID", "WHISPERX_PROFILE_CONFLICT"] as const;
    return failure(error instanceof Error && known.some(code => code === error.message)
      ? error.message as typeof known[number] : "WHISPERX_PROFILE_PREPARE_FAILED");
  };
  const stage = (value: WhisperXProgressStage) => {
    activeStage = value;
    current = { state: value === "ready" ? "ready" : value === "starting-service" ? "starting" : "preparing", stage: value };
    for (const observer of active?.observers ?? []) {
      // Electron throws if its renderer disappears; neither sync nor async observer failures cancel work.
      try { void Promise.resolve(observer(value)).catch(() => undefined); } catch { /* Detached observer. */ }
    }
  };
  const parseState = (bytes: Buffer | undefined): SavedState | undefined => {
    if (!bytes) return undefined;
    let value: unknown;
    try { value = JSON.parse(bytes.toString()); } catch { throw new ProgramError("WHISPERX_STATE_FAILED"); }
    if (!record(value) || Object.keys(value).sort().join(",") !== "format,prepared,stopped"
      || value.format !== "hypit.desktop-whisperx@1" || value.prepared !== true || typeof value.stopped !== "boolean") throw new ProgramError("WHISPERX_STATE_FAILED");
    return value as SavedState;
  };
  const stateSnapshot = async () => {
    try { return await snapshotFile(paths.state); } catch { throw new ProgramError("WHISPERX_STATE_FAILED"); }
  };
  const readState = async (): Promise<SavedState | undefined> => parseState((await stateSnapshot()).bytes);
  const saveState = async (stopped: boolean) => {
    const before = await stateSnapshot();
    parseState(before.bytes); // Validate exactly the snapshot the transaction will replace.
    const change = prepareFileChange(before, Buffer.from(`${JSON.stringify({ format: "hypit.desktop-whisperx@1", prepared: true, stopped })}\n`), options.platform);
    let committed = false;
    try { await change.commit(); committed = true; }
    catch { await change.rollback(); throw new ProgramError("WHISPERX_STATE_FAILED"); }
    finally { if ((await change.dispose(committed)).length) throw new ProgramError("WHISPERX_CLEANUP_INCOMPLETE"); }
  };
  const project = (report: ProgramReport, saved: SavedState | undefined): WhisperXProgramStatus => {
    const program = report.program;
    if (program?.state === "mismatch") return { state: "mismatch", code: "WHISPERX_NOT_READY", logPath: paths.serviceLog };
    if (program?.state === "ready") return { state: "ready", stage: "ready", logPath: paths.serviceLog };
    if (typeof program?.pid === "number" && Number.isSafeInteger(program.pid) && program.pid > 0) return { state: "starting", stage: "starting-service", logPath: paths.serviceLog };
    return { state: saved ? saved.stopped ? "stopped" : "prepared" : "not-installed", logPath: paths.installationLog };
  };
  const statusError = (error: unknown): WhisperXProgramStatus => {
    const result = errorStatus(error);
    return result.code === "WHISPERX_PROFILE_REQUIRED" || result.code === "WHISPERX_PROFILE_INVALID" || result.code === "WHISPERX_PROFILE_CONFLICT"
      ? { state: "mismatch", code: result.code, logPath: paths.serviceLog } : result;
  };
  const status = async (): Promise<WhisperXProgramStatus> => {
    if (active) return { ...current };
    const revision = mutationRevision;
    let result: WhisperXProgramStatus;
    let cleanupIncomplete = false;
    let candidate: PreparedWhisperXProfile | undefined;
    try {
      candidate = await prepareWhisperXProfile({ profilePath: options.paths.profile, platform: options.platform });
      result = project(await execute(options, "status", candidate.candidatePath), await readState());
    } catch (error) { result = statusError(error); }
    finally {
      try { cleanupIncomplete = !!candidate && (await candidate.dispose(false)).length > 0; }
      catch { cleanupIncomplete = true; }
    }
    if (result.state === "ready") {
      try {
        if (!await isWhisperXProfileActivated({ profilePath: options.paths.profile })) {
          result = { state: "prepared", code: "WHISPERX_PROFILE_REQUIRED", logPath: paths.serviceLog };
        }
      } catch (error) { result = statusError(error); }
    }
    // A probe started before a mutation cannot overwrite its newer progress, even after completion.
    if (revision === mutationRevision) current = result;
    if (cleanupIncomplete) current = { ...current, cleanupIncomplete: true, code: current.code ?? "WHISPERX_CLEANUP_INCOMPLETE" };
    return current;
  };
  const perform = async (operation: Operation): Promise<WhisperXProgramStatus> => {
    let candidate: PreparedWhisperXProfile | undefined;
    let firstPass: PreparedRemoval | undefined;
    let committed = false;
    let publicationAttempted = false;
    try {
      await validateBundledUv(options);
      candidate = await prepareWhisperXProfile({ profilePath: options.paths.profile, platform: options.platform });
      if (operation === "install") {
        const document = JSON.parse(await readFile(candidate.candidatePath, "utf8"));
        document.endpoints[LOCAL_WHISPERX_ENDPOINT].config.alignmentLanguages = ["zh"];
        const firstPath = `${candidate.candidatePath}.zh.json`;
        firstPass = prepareFileChange({ path: firstPath }, Buffer.from(`${JSON.stringify(document, null, 2)}\n`), options.platform, 0o600, "profile");
        await firstPass.commit();
        stage("preparing-runtime");
        const zh = await execute(options, "prepare", firstPath);
        if (!zh.ok || !zh.ready) throw new ProgramError("WHISPERX_COMMAND_FAILED");
        stage("preparing-en");
        const en = await execute(options, "prepare", candidate.candidatePath);
        if (!en.ok || !en.ready) throw new ProgramError("WHISPERX_COMMAND_FAILED");
        await saveState(false);
      }
      if (operation !== "stop") stage("starting-service");
      const changed = await execute(options, operation === "stop" ? "down" : "up", candidate.candidatePath);
      const inspected = await execute(options, "status", candidate.candidatePath);
      const observed = project(inspected, await readState());
      if (operation === "stop") {
        if (!changed.ok || inspected.program?.state !== "down" || inspected.program?.pid !== undefined) throw new ProgramError("WHISPERX_COMMAND_FAILED");
        if (await readState()) await saveState(true);
        current = project(inspected, await readState());
      } else if (changed.ok && inspected.ok && inspected.ready && inspected.program?.state === "ready") {
        // Keep shared status at starting until both the marker and real Profile publication succeed.
        await saveState(false);
        publicationAttempted = true;
        await candidate.commit();
        committed = true;
        stage("ready");
      } else if (observed.state === "starting" || observed.state === "mismatch") current = observed;
      else throw new ProgramError("WHISPERX_NOT_READY");
    } catch (error) {
      current = publicationAttempted && !committed ? failure("WHISPERX_PROFILE_COMMIT_FAILED") : errorStatus(error);
    } finally {
      let cleanupIncomplete = false;
      try {
        if (firstPass) { cleanupIncomplete = await firstPass.rollback(); cleanupIncomplete = (await firstPass.dispose(false)).length > 0 || cleanupIncomplete; }
        if (candidate) {
          if (!committed) cleanupIncomplete = await candidate.rollback() || cleanupIncomplete;
          cleanupIncomplete = (await candidate.dispose(committed)).length > 0 || cleanupIncomplete;
        }
      } catch { cleanupIncomplete = true; }
      if (cleanupIncomplete) current = { ...current, cleanupIncomplete: true, code: current.code ?? "WHISPERX_CLEANUP_INCOMPLETE" };
    }
    return current;
  };
  const observe = (report: WhisperXProgressReporter | undefined, signal: AbortSignal | undefined, run: NonNullable<typeof active>) => {
    if (!report || signal?.aborted) return;
    run.observers.add(report);
    const detach = () => { run.observers.delete(report); };
    signal?.addEventListener("abort", detach, { once: true });
    void run.promise.finally(() => { detach(); signal?.removeEventListener("abort", detach); });
  };
  const begin = (operation: Operation, report?: WhisperXProgressReporter, signal?: AbortSignal): Promise<WhisperXProgramStatus> => {
    if (active) {
      if (active.operation === operation) { observe(report, signal, active); return active.promise; }
      return active.promise.then(() => begin(operation, report, signal));
    }
    current = operation === "install" ? { state: "preparing", stage: "preparing-runtime" }
      : operation === "start" ? { state: "starting", stage: "starting-service" } : { state: "stopping" };
    mutationRevision++;
    activeStage = operation === "stop" ? undefined : current.stage;
    const observers = new Set<WhisperXProgressReporter>();
    const promise = Promise.resolve().then(() => perform(operation)).finally(() => { active = undefined; });
    active = { operation, promise, observers };
    observe(report, signal, active);
    return promise;
  };
  return { status, installAndStart: (report, signal) => begin("install", report, signal), start: (report, signal) => begin("start", report, signal), stop: () => begin("stop") };
}
