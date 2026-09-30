import type { SetupInput, SetupProgress, SetupResult, SetupStage, WhisperXProgressStage, WhisperXPublicStatus } from "./contracts.js";
import type { SetupBridge, SetupFailure } from "./ipc.js";

export const EXAMPLE_PROMPT = "请使用 $hypit，把我的参考视频改编成新版本；使用本机已配置的 NewAPI 和 OSS。";
export const stageCopy: Readonly<Record<SetupStage, string>> = {
  validating: "正在检查配置", "testing-newapi": "正在测试 NewAPI", "testing-oss": "正在测试 OSS 上传、下载与清理",
  "saving-credentials": "正在保存平台凭据", "writing-profile": "正在写入运行配置", "installing-skill": "正在安装 Agent Skill",
  "installing-launcher": "正在安装命令入口与 Agent Skill", diagnosing: "正在检查安装结果", complete: "配置完成",
};
type Fields = { baseUrl: string; apiKey: string; endpoint: string; bucket: string; accessKeyId: string; accessKeySecret: string };
type SecretField = "apiKey" | "accessKeyId" | "accessKeySecret";
type WhisperXOperation = "status" | "install" | "start" | "stop";
const whisperXRequestFailure = "操作未完成，请检查状态后重试。";
const whisperXStageCopy: Record<WhisperXProgressStage, string> = {
  "preparing-runtime": "正在准备运行环境与中文模型", "preparing-en": "正在准备英文模型",
  "starting-service": "正在启动服务", ready: "服务已就绪",
};
const whisperXStateCopy: Record<WhisperXPublicStatus["state"], string> = {
  "not-installed": "尚未安装", preparing: "正在准备", prepared: "已准备，尚未启动", stopped: "服务已停止",
  starting: "正在启动服务", stopping: "正在停止服务", ready: "服务已就绪", mismatch: "本地配置需要检查", failed: "本地操作失败",
};
const whisperXErrorCopy: Record<NonNullable<WhisperXPublicStatus["errorCode"]>, string> = {
  WHISPERX_BUNDLED_UV_INVALID: "安装资源不完整，请重新安装 Hypit 后重试。",
  WHISPERX_PROFILE_REQUIRED: "请先完成本机配置，再启动本地服务。",
  WHISPERX_PROFILE_INVALID: "运行配置无法读取，请检查本机配置后重试。",
  WHISPERX_PROFILE_CONFLICT: "已有本地服务配置与此安装不一致，请检查运行配置。",
  WHISPERX_PROFILE_PREPARE_FAILED: "无法准备运行配置，请检查配置目录的访问权限后重试。",
  WHISPERX_PROFILE_COMMIT_FAILED: "服务配置未能保存，请检查配置目录的访问权限后重试。",
  WHISPERX_COMMAND_FAILED: "本地准备或服务操作失败，请检查网络和日志后重试。",
  WHISPERX_INVALID_REPORT: "无法确认本地服务结果，请检查状态和日志后重试。",
  WHISPERX_OUTPUT_LIMIT: "本地操作输出超出限制，请检查日志后重试。",
  WHISPERX_TIMEOUT: "本地操作等待超时，请检查网络和日志后重试。",
  WHISPERX_NOT_READY: "服务尚未就绪，请检查状态和日志后重试。",
  WHISPERX_STATE_FAILED: "无法读取或保存本地状态，请检查目录的访问权限后重试。",
  WHISPERX_CLEANUP_INCOMPLETE: "临时文件清理未完成，请检查日志和配置目录后重试。",
};
export type WizardState = {
  readonly screen: "welcome" | "settings" | "working" | "complete";
  readonly fields: Fields;
  readonly visible: Record<SecretField, boolean>;
  readonly stage: SetupStage;
  readonly result?: SetupResult;
  readonly error?: SetupFailure;
  readonly confirmClear: boolean;
  readonly returnScreen: "settings" | "complete";
  readonly whisperX: { readonly status?: WhisperXPublicStatus; readonly pending?: WhisperXOperation;
    readonly stage?: WhisperXProgressStage; readonly error?: string };
};
export type WizardAction =
  | { type: "begin" | "working" | "refresh-agents" | "edit" | "confirm-clear" | "cancel-clear" }
  | { type: "field"; field: keyof Fields; value: string }
  | { type: "toggle-secret"; field: SecretField }
  | { type: "progress"; progress: SetupProgress }
  | { type: "success"; result: SetupResult }
  | { type: "whisperx-request"; operation: WhisperXOperation }
  | { type: "whisperx-result"; status: WhisperXPublicStatus }
  | { type: "whisperx-failure" | "whisperx-settled" }
  | { type: "failure"; error: SetupFailure };
type UiAction = WizardAction | { type: "submit" | "diagnostics" | "open-config" | "clear" | "remove-integration"
  | "whisperx-status" | "whisperx-install" | "whisperx-start" | "whisperx-stop" };
const agentLabels = { codex: "Codex", "claymore-piko": "Claymore Piko", cursor: "Cursor", "claude-code": "Claude Code" } as const;
const hidden = (): Record<SecretField, boolean> => ({ apiKey: false, accessKeyId: false, accessKeySecret: false });

function resumableAddress(value: unknown, bare = false): string {
  if (typeof value !== "string" || value.length > 8192) return "";
  try {
    const parsed = new URL(bare && !value.includes("://") ? `https://${value}` : value);
    if (parsed.username || parsed.password || parsed.search || parsed.hash || !["https:", "http:"].includes(parsed.protocol)) return "";
    return value;
  } catch { return ""; }
}

export function initialWizardState(draft: unknown = {}): WizardState {
  const item = draft && typeof draft === "object" ? draft as Record<string, unknown> : {};
  return { screen: item.screen === "settings" ? "settings" : "welcome", fields: {
    baseUrl: resumableAddress(item.baseUrl), apiKey: "", endpoint: resumableAddress(item.endpoint, true),
    bucket: typeof item.bucket === "string" && /^[a-z0-9-]{1,63}$/u.test(item.bucket) ? item.bucket : "", accessKeyId: "", accessKeySecret: "",
  }, visible: hidden(), stage: "validating", confirmClear: false, returnScreen: "settings", whisperX: {} };
}

export function persistedWizardState(state: WizardState) {
  return { screen: state.screen === "welcome" ? "welcome" : "settings", baseUrl: resumableAddress(state.fields.baseUrl),
    endpoint: resumableAddress(state.fields.endpoint, true), bucket: /^[a-z0-9-]{1,63}$/u.test(state.fields.bucket) ? state.fields.bucket : "" };
}

export function canSubmit(state: WizardState): boolean {
  return state.screen === "settings" && Object.values(state.fields).every((value) => value.trim().length > 0);
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  if (state.screen === "working" && ["field", "toggle-secret", "begin", "edit", "confirm-clear", "cancel-clear", "refresh-agents"].includes(action.type)) return state;
  switch (action.type) {
    case "begin": case "edit": return { ...state, screen: "settings", confirmClear: false };
    case "field": return { ...state, fields: { ...state.fields, [action.field]: action.value } };
    case "toggle-secret": return { ...state, visible: { ...state.visible, [action.field]: !state.visible[action.field] } };
    case "working": {
      const { error: _error, ...rest } = state;
      return { ...rest, screen: "working", stage: "validating", confirmClear: false, visible: hidden(), returnScreen: state.screen === "complete" ? "complete" : "settings" };
    }
    case "refresh-agents": {
      const { error: _error, ...rest } = state;
      return { ...rest, screen: "working", stage: "installing-skill", confirmClear: false, visible: hidden(),
        fields: { ...state.fields, apiKey: "", accessKeyId: "", accessKeySecret: "" },
        returnScreen: state.screen === "complete" ? "complete" : "settings" };
    }
    case "progress": return action.progress.kind === "stage" ? { ...state, stage: action.progress.stage }
      : action.progress.kind === "whisperx-stage" ? { ...state, whisperX: { ...state.whisperX, stage: action.progress.stage } } : state;
    case "whisperx-request": return { ...state, whisperX: { ...(state.whisperX.status ? { status: state.whisperX.status } : {}), pending: action.operation } };
    case "whisperx-result": {
      const { stage: _stage, ...rest } = state.whisperX;
      return { ...state, whisperX: { ...rest, status: action.status, ...(action.status.stage ? { stage: action.status.stage } : {}) } };
    }
    case "whisperx-failure": return { ...state, whisperX: { ...state.whisperX, error: whisperXRequestFailure } };
    case "whisperx-settled": {
      const { pending: _pending, ...rest } = state.whisperX;
      return { ...state, whisperX: rest };
    }
    case "success": {
      const { error: _error, ...rest } = state;
      return { ...rest, screen: action.result.configured ? "complete" : "settings", result: action.result, stage: "complete", confirmClear: false,
        fields: { ...state.fields, apiKey: "", accessKeyId: "", accessKeySecret: "" }, visible: hidden() };
    }
    case "failure": return { ...state, screen: state.screen === "working" ? state.returnScreen : state.screen === "complete" ? "complete" : "settings", error: action.error, confirmClear: false };
    case "confirm-clear": return { ...state, confirmClear: true };
    case "cancel-clear": return { ...state, confirmClear: false };
  }
}

export function setupInput(state: WizardState): SetupInput {
  return { baseUrl: state.fields.baseUrl, apiKey: state.fields.apiKey, relay: { enabled: true, endpoint: state.fields.endpoint,
    bucket: state.fields.bucket, accessKeyId: state.fields.accessKeyId, accessKeySecret: state.fields.accessKeySecret } };
}

/** DOM text and properties only: no user, server or error text is parsed as HTML. */
export function renderWizard(root: HTMLElement, state: WizardState, dispatch: (action: UiAction) => void, pending = false): void {
  const document = root.ownerDocument;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const button = (text: string, action: UiAction, className = "secondary") => {
    const element = node("button", text, className); element.type = "button";
    element.disabled = pending || !!state.whisperX.pending || state.screen === "working";
    element.addEventListener("click", () => { if (!element.disabled) dispatch(action); });
    return element;
  };
  root.replaceChildren();
  const header = node("header", undefined, "masthead");
  header.append(node("span", "hypit", "wordmark"), node("span", "本机设置", "caption"));
  const steps = node("ol", undefined, "steps");
  const screens = ["welcome", "settings", "working", "complete"];
  ["欢迎", "NewAPI 与 OSS", "测试与安装", "完成 / 诊断"].forEach((text, index) => {
    const item = node("li", text);
    if (screens[index] === state.screen) item.setAttribute("aria-current", "step");
    steps.append(item);
  });
  root.append(header, steps);
  const buildNotice = node("aside", undefined, "warning");
  buildNotice.setAttribute("aria-label", "内部测试版说明");
  buildNotice.append(node("strong", "未签名的内部测试版"));
  const userAgent = document.defaultView?.navigator.userAgent ?? "";
  if (/Windows/u.test(userAgent)) {
    buildNotice.append(node("p", "Windows SmartScreen 若拦截，请在确认来源可信后选择“更多信息”→“仍要运行”。"),
      node("p", "Windows 安装包为跨平台构建，未经 Windows 实机验证。"));
  } else if (/Macintosh|Mac OS X/u.test(userAgent)) {
    buildNotice.append(node("p", "macOS Gatekeeper 若拦截，请在确认来源可信后右键点击应用并选择“打开”；若仍被阻止，请在系统设置的“隐私与安全性”中查看允许打开选项。"));
  } else buildNotice.append(node("p", "仅供内部测试；Windows 安装包为跨平台构建，未经 Windows 实机验证。"));
  root.append(buildNotice);
  const panel = node("section", undefined, "panel");
  panel.setAttribute("aria-busy", String(state.screen === "working"));
  root.append(panel);
  const appendDiagnostics = () => {
    const diagnostics = node("ul", undefined, "diagnostics");
    for (const item of state.result?.diagnostics ?? []) {
      const line = node("li"); line.append(node("span", item.label), node("span", { pass: "通过", warning: "待检查", fail: "失败" }[item.status], item.status));
      if (item.path) line.append(node("code", item.path));
      if (item.reason === "SKILL_BACKUP_UNAVAILABLE") line.append(node("p", "备份缺失或无法读取；请恢复此路径的原 Skill 备份后重试。"));
      if (item.reason === "CLEANUP_INCOMPLETE") line.append(node("p", item.path
        ? "恢复文件未自动清理；请检查此路径，确认无需恢复后再手动删除。"
        : item.code === "skill" ? "恢复文件检查或清理未完成；请检查 Skill 目录的访问权限，再重新运行诊断。"
          : "恢复文件检查未完成；请检查命令入口或 Runtime Profile 目录的访问权限，再重新运行诊断。"));
      if (item.code === "oss" && item.status === "warning" && item.cleanupObjectKey) line.append(node("p", "OSS 已验证；测试对象未自动删除"), node("p", "请在 OSS 中手动删除测试对象："), node("code", item.cleanupObjectKey));
      diagnostics.append(line);
    }
    panel.append(diagnostics);
  };
  const appendAgentTargets = () => {
    if (!state.result) return;
    panel.append(node("h2", "Agent Skill 安装目标"));
    const targets = node("ul", undefined, "diagnostics");
    for (const target of state.result.skillTargets) {
      const line = node("li"); line.setAttribute("data-agent-target", target.id);
      line.append(node("strong", target.label), node("span", target.detectedAgents.length
        ? target.detectedAgents.map(agent => agentLabels[agent]).join("、") : "未检测到对应 Agent"), node("code", target.path));
      targets.append(line);
    }
    panel.append(targets);
  };
  const appendMaintenance = () => {
    panel.append(button("卸载本机集成…", { type: "remove-integration" }, "text-button"), node("p", "移除命令入口、托管 Skill 和 PATH 配置；配置、凭据和视频项目会保留。卸载后可将应用移到废纸篓。", "muted"));
  };
  if (state.error) {
    const warning = node("div", undefined, "warning"); warning.setAttribute("role", "alert");
    warning.append(node("strong", state.error.message), node("p", `错误代码：${state.error.code}`));
    if (state.error.cleanupObjectKey) warning.append(node("p", "请在 OSS 中手动删除测试对象，再重试："), node("code", state.error.cleanupObjectKey));
    panel.append(warning);
  }
  if (state.screen === "welcome") {
    panel.append(node("p", "Agent 视频工作流", "eyebrow"), node("h1", "为你的 AI Agent 准备 Hypit"),
      node("p", "连接你的 NewAPI 和 OSS，安装视频命令与 Agent Skill。完成后，可以在已支持的 Agent 中直接用中文描述想做的视频。", "intro"));
    const summary = node("ul", undefined, "summary");
    ["NewAPI：连接你已有的模型服务", "OSS：验证视频素材的上传与下载", "本机：安装命令入口与 Agent Skill"].forEach((text) => summary.append(node("li", text)));
    panel.append(summary, node("p", "API Key 与 OSS 密钥将保存在系统凭据库。请准备好六项配置。", "muted"), button("开始配置", { type: "begin" }, "primary"));
    return;
  }
  if (state.screen === "settings") {
    panel.append(node("h1", "连接 NewAPI 与 OSS"), node("p", "六项均为必填。测试会读取可用模型，并在 OSS 中上传、下载及删除一个小型测试文件。", "intro"));
    if (state.result && !state.result.configured) {
      panel.append(node("h2", "安装尚未完成"), node("p", "请检查以下未完成项目，重新填写配置并测试安装。已保存的 Profile 不代表命令入口与 Skill 已安装。", "muted"));
      appendDiagnostics();
    }
    if (state.result) appendAgentTargets();
    const form = node("form");
    const labels: Record<keyof Fields, string> = { baseUrl: "NewAPI 地址", apiKey: "NewAPI API Key", endpoint: "OSS Endpoint", bucket: "OSS Bucket", accessKeyId: "OSS AccessKey ID", accessKeySecret: "OSS AccessKey Secret" };
    const placeholders: Partial<Record<keyof Fields, string>> = { baseUrl: "https://newapi.example.com", endpoint: "oss-cn-hangzhou.aliyuncs.com", bucket: "my-video-bucket" };
    for (const field of Object.keys(labels) as (keyof Fields)[]) {
      const row = node("div", undefined, "field");
      const label = node("label", labels[field]); label.htmlFor = field;
      const control = node("div", undefined, "input-row");
      const input = node("input"); input.id = field; input.name = field; input.setAttribute("required", ""); input.maxLength = 8192;
      const secret = ["apiKey", "accessKeyId", "accessKeySecret"].includes(field);
      input.type = secret && !state.visible[field as SecretField] ? "password" : "text";
      input.value = state.fields[field]; input.disabled = pending; input.autocomplete = "off"; input.spellcheck = false;
      input.setAttribute("autocapitalize", "none");
      input.placeholder = placeholders[field] ?? "请输入";
      input.addEventListener("input", () => { dispatch({ type: "field", field, value: input.value }); });
      control.append(input);
      if (secret) {
        const toggle = button(state.visible[field as SecretField] ? "隐藏" : "显示", { type: "toggle-secret", field: field as SecretField }, "reveal");
        toggle.setAttribute("aria-label", `${state.visible[field as SecretField] ? "隐藏" : "显示"}${labels[field]}`);
        toggle.setAttribute("aria-pressed", String(state.visible[field as SecretField]));
        control.append(toggle);
      }
      row.append(label, control);
      if (field === "baseUrl") row.append(node("p", "填写服务根地址时会自动补全 /v1；已有 /v1 或自定义 API 路径会保留。", "muted"));
      form.append(row);
    }
    form.append(node("p", "仅地址、Endpoint 和 Bucket 可恢复。关闭向导后，密钥需要重新填写。", "muted"));
    const submit = node("button", state.error ? "重新测试并安装" : "测试连接并安装", "primary"); submit.type = "submit"; submit.id = "submit-setup"; submit.disabled = pending || !canSubmit(state);
    form.addEventListener("submit", (event) => { event.preventDefault(); dispatch({ type: "submit" }); });
    form.append(submit); panel.append(form);
    if (state.result) {
      panel.append(button("重新扫描 Agent", { type: "refresh-agents" }), button("重新运行诊断", { type: "diagnostics" }), button("清除本机配置和凭据…", { type: "clear" }, "text-button"));
      appendMaintenance();
    }
    return;
  }
  if (state.screen === "working") {
    panel.append(node("p", "测试与安装", "eyebrow"), node("h1", stageCopy[state.stage]));
    const status = node("p", "连接测试、凭据保存和安装将依次进行。请保持窗口打开。", "intro"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const progress = node("progress"); progress.setAttribute("aria-label", "正在配置 Hypit");
    panel.append(status, progress, node("p", "连接测试包含 OSS 小型文件上传、下载与清理，不会生成图片或视频。", "muted"));
    return;
  }
  const failed = state.result?.diagnostics.some((item) => item.status === "fail");
  panel.append(node("p", "完成 / 诊断", "eyebrow"), node("h1", failed ? "配置已保存，需要检查" : "Hypit 已配置"),
    node("p", "请重启正在使用的 Agent 和 Terminal，再测试 hypit 命令是否可用。", "intro"));
  if (state.result) { appendAgentTargets(); appendDiagnostics(); }
  panel.append(node("p", "在你的 Agent 中试试", "eyebrow"), node("blockquote", EXAMPLE_PROMPT), node("p", "Chrome 可能在以后首次使用时下载。", "muted"));
  const local = state.whisperX;
  const card = node("section", undefined, "local-capability"); card.setAttribute("data-whisperx", "");
  card.setAttribute("aria-labelledby", "whisperx-title"); card.setAttribute("aria-busy", String(!!local.pending));
  const title = node("h2", "本地语音识别与字幕对齐（可选）"); title.id = "whisperx-title";
  card.append(node("p", "本机能力 · WhisperX", "eyebrow"), title,
    node("p", "small · CPU · int8", "local-spec"), node("p", "支持中文和英文，在本机识别语音并对齐字幕。", "muted"));
  const current = local.status?.state;
  const progressStage = local.stage ?? (!local.pending || local.pending === "status" ? local.status?.stage : undefined);
  const statusCopy = local.pending && local.pending !== "status"
    ? progressStage ? whisperXStageCopy[progressStage] : { install: "正在准备安装", start: "正在启动服务", stop: "正在停止服务" }[local.pending]
    : current ? whisperXStateCopy[current] : local.pending ? "正在检查本地状态" : "请检查本地状态";
  const localStatus = node("p", statusCopy, "local-status"); localStatus.setAttribute("role", "status"); localStatus.setAttribute("aria-live", "polite");
  card.append(localStatus);
  const trajectory = node("ol", undefined, "steps local-steps"); trajectory.setAttribute("aria-label", "本地准备过程");
  const stages: WhisperXProgressStage[] = ["preparing-runtime", "preparing-en", "starting-service", "ready"];
  ["环境与中文模型", "英文模型", "启动服务", "就绪"].forEach((label, index) => {
    const step = node("li", label);
    if (stages[index] === progressStage) step.setAttribute("aria-current", "step");
    trajectory.append(step);
  });
  card.append(trajectory, node("p", "首次准备的下载量较大，可能需要较长时间，具体取决于网络和本机性能。不收取 NewAPI 模型费用；本地准备不访问 NewAPI 或 OSS 凭据。", "muted"));
  if (!local.pending) {
    const error = local.error ?? (local.status?.errorCode ? whisperXErrorCopy[local.status.errorCode] : undefined);
    if (error) { const warning = node("p", error, "warning"); warning.setAttribute("role", "alert"); card.append(warning); }
  }
  if (local.status?.logPath) {
    const log = node("details"); log.append(node("summary", "查看日志位置"), node("code", local.status.logPath)); card.append(log);
  }
  const localActions = node("div", undefined, "actions");
  const localButton = (label: string, operation: WhisperXOperation, style = "secondary") => {
    const control = button(label, { type: `whisperx-${operation}` }, style); control.setAttribute("data-whisperx-action", operation); return control;
  };
  if (current === "not-installed") localActions.append(localButton("安装并启动", "install", "primary"));
  else if (current === "failed" || current === "mismatch") localActions.append(localButton("重试安装", "install", "primary"));
  else if (current === "prepared" || current === "stopped") localActions.append(localButton("启动服务", "start", "primary"));
  else if (current === "ready") localActions.append(localButton("停止服务", "stop"));
  localActions.append(localButton("检查状态", "status"));
  card.append(localActions, node("p", "此项可稍后设置。关闭窗口不会取消正在进行的本地准备。", "muted"));
  panel.append(card);
  const actions = node("div", undefined, "actions");
  actions.append(button("重新扫描 Agent", { type: "refresh-agents" }, "primary"), button("重新运行诊断", { type: "diagnostics" }), button("打开配置目录", { type: "open-config" }), button("修改配置", { type: "edit" }));
  panel.append(actions);
  if (state.confirmClear) {
    const confirm = node("section", undefined, "warning");
    confirm.append(node("h2", "清除本机配置和凭据？"), node("p", "将清除桌面运行配置及 NewAPI API Key、OSS AccessKey ID、OSS AccessKey Secret。视频项目将保留。"));
    if (state.result) confirm.append(node("code", state.result.profilePath));
    confirm.append(button("确认清除", { type: "clear" }, "danger"), button("取消", { type: "cancel-clear" })); panel.append(confirm);
  } else panel.append(button("清除本机配置和凭据…", { type: "confirm-clear" }, "text-button"));
  appendMaintenance();
}

declare global { interface Window { hypitSetup: SetupBridge } }
export function mountWizard(root: HTMLElement, bridge: SetupBridge, storage: Pick<Storage, "getItem" | "setItem" | "removeItem">): () => void {
  const draftKey = "hypit.setup.non-secret-draft.v1";
  let draft: unknown;
  try { draft = JSON.parse(storage.getItem(draftKey) ?? "{}"); } catch { draft = {}; }
  let state = initialWizardState(draft);
  let disposed = false;
  let busy = false;
  let interactionGeneration = 0;
  const render = () => { if (!disposed) renderWizard(root, state, dispatch, busy); };
  const persist = () => { try { storage.setItem(draftKey, JSON.stringify(persistedWizardState(state))); } catch { /* Storage may be disabled; setup still works. */ } };
  const failure: SetupFailure = { code: "SETUP_REQUEST_FAILED", message: "操作失败，请检查配置后重试" };
  async function refreshWhisperX(): Promise<void> {
    try {
      const reply = await bridge.getWhisperXStatus();
      if (!disposed) state = reply.ok ? wizardReducer(state, { type: "whisperx-result", status: reply.value })
        : wizardReducer(state, { type: "whisperx-failure" });
    } catch { if (!disposed) state = wizardReducer(state, { type: "whisperx-failure" }); }
  }
  async function dispatch(action: UiAction): Promise<void> {
    if (disposed || busy && !["progress"].includes(action.type)) return;
    if (action.type !== "progress") interactionGeneration++;
    if (action.type === "whisperx-status" || action.type === "whisperx-install" || action.type === "whisperx-start" || action.type === "whisperx-stop") {
      if (state.screen !== "complete") return;
      const operation: WhisperXOperation = action.type === "whisperx-install" ? "install" : action.type === "whisperx-start" ? "start" : action.type === "whisperx-stop" ? "stop" : "status";
      busy = true;
      state = wizardReducer(state, { type: "whisperx-request", operation }); render();
      try {
        if (operation === "status") await refreshWhisperX();
        else {
          try {
            const reply = operation === "install" ? await bridge.installWhisperX() : operation === "start" ? await bridge.startWhisperX() : await bridge.stopWhisperX();
            if (!disposed) {
              state = reply.ok ? wizardReducer(state, { type: "whisperx-result", status: reply.value }) : wizardReducer(state, { type: "whisperx-failure" });
              // A later status probe may no longer carry a failed operation's code.
              if (reply.ok && reply.value.errorCode) state = { ...state, whisperX: { ...state.whisperX, error: whisperXErrorCopy[reply.value.errorCode] } };
            }
          } catch { if (!disposed) state = wizardReducer(state, { type: "whisperx-failure" }); }
          if (!disposed) await refreshWhisperX();
        }
      } finally {
        busy = false;
        if (!disposed) state = wizardReducer(state, { type: "whisperx-settled" });
        render();
      }
      return;
    }
    if (["submit", "diagnostics", "clear", "open-config", "remove-integration", "refresh-agents"].includes(action.type)) {
      if (action.type === "submit" && !canSubmit(state)) return;
      if (action.type === "clear" && !state.confirmClear && state.screen !== "settings") return;
      const input = action.type === "submit" ? setupInput(state) : undefined;
      busy = true;
      if (action.type !== "open-config") state = wizardReducer(state, { type: action.type === "refresh-agents" ? "refresh-agents" : "working" });
      render();
      try {
        if (action.type === "open-config") {
          const reply = await bridge.openConfigDirectory();
          if (!reply.ok) state = wizardReducer(state, { type: "failure", error: reply.error });
        } else {
          const reply = action.type === "submit" ? await bridge.submit(input!) : action.type === "clear" ? await bridge.clearConfiguration() : action.type === "remove-integration" ? await bridge.removeIntegration() : action.type === "refresh-agents" ? await bridge.refreshAgentIntegration() : await bridge.rerunDiagnostics();
          state = reply.ok ? wizardReducer(state, { type: "success", result: reply.value }) : wizardReducer(state, { type: "failure", error: reply.error });
          if (action.type === "clear" && reply.ok) { state = { ...initialWizardState(), screen: "settings", result: reply.value }; try { storage.removeItem(draftKey); } catch {} }
        }
      } catch { state = wizardReducer(state, { type: "failure", error: failure }); }
      finally {
        busy = false; persist(); render();
        if (!disposed && state.screen === "complete" && action.type !== "open-config") await dispatch({ type: "whisperx-status" });
      }
      return;
    }
    state = wizardReducer(state, action as WizardAction);
    persist();
    // Keep the active text field and caret intact while typing.
    if (action.type === "field") {
      const submit = root.querySelector<HTMLButtonElement>("#submit-setup"); if (submit) submit.disabled = !canSubmit(state);
    } else render();
  }
  const unsubscribe = bridge.onProgress((progress) => { void dispatch({ type: "progress", progress }); });
  render();
  void bridge.getStatus().then((reply) => {
    // A startup snapshot predates every user interaction; it must never erase a draft
    // or replace the outcome of an operation that has already finished.
    if (disposed || busy || interactionGeneration !== 0) return;
    if (reply.ok && (reply.value.configured || reply.value.diagnostics.length > 0)) {
      state = wizardReducer(state, { type: "success", result: reply.value }); render();
      if (state.screen === "complete") void dispatch({ type: "whisperx-status" });
    }
    else if (!reply.ok) { state = wizardReducer(state, { type: "failure", error: reply.error }); render(); }
  }).catch(() => { if (!disposed && !busy && interactionGeneration === 0) { state = wizardReducer(state, { type: "failure", error: failure }); render(); } });
  return () => { disposed = true; unsubscribe(); state = initialWizardState(); root.replaceChildren(); };
}

if (typeof window !== "undefined" && window.hypitSetup) {
  const root = document.getElementById("app");
  if (root) {
    const dispose = mountWizard(root, window.hypitSetup, window.localStorage);
    window.addEventListener("pagehide", dispose, { once: true });
  }
}
