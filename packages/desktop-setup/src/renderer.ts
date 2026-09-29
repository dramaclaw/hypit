import type { SetupInput, SetupProgress, SetupResult, SetupStage } from "./contracts.js";
import type { SetupBridge, SetupFailure } from "./ipc.js";

export const EXAMPLE_PROMPT = "请使用 $hypit，把我的参考视频改编成新版本；使用本机已配置的 NewAPI 和 OSS。";
export const stageCopy: Readonly<Record<SetupStage, string>> = {
  validating: "正在检查配置", "testing-newapi": "正在测试 NewAPI", "testing-oss": "正在测试 OSS 上传、下载与清理",
  "saving-credentials": "正在保存平台凭据", "writing-profile": "正在写入运行配置", "installing-skill": "正在安装 Codex Skill",
  "installing-launcher": "正在安装命令入口与 Codex Skill", diagnosing: "正在检查安装结果", complete: "配置完成",
};
type Fields = { baseUrl: string; apiKey: string; endpoint: string; bucket: string; accessKeyId: string; accessKeySecret: string };
type SecretField = "apiKey" | "accessKeyId" | "accessKeySecret";
export type WizardState = {
  readonly screen: "welcome" | "settings" | "working" | "complete";
  readonly fields: Fields;
  readonly visible: Record<SecretField, boolean>;
  readonly stage: SetupStage;
  readonly result?: SetupResult;
  readonly error?: SetupFailure;
  readonly confirmClear: boolean;
  readonly returnScreen: "settings" | "complete";
};
export type WizardAction =
  | { type: "begin" | "working" | "edit" | "confirm-clear" | "cancel-clear" }
  | { type: "field"; field: keyof Fields; value: string }
  | { type: "toggle-secret"; field: SecretField }
  | { type: "progress"; progress: SetupProgress }
  | { type: "success"; result: SetupResult }
  | { type: "failure"; error: SetupFailure };
type UiAction = WizardAction | { type: "submit" | "diagnostics" | "open-config" | "clear" | "remove-integration" };
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
  }, visible: hidden(), stage: "validating", confirmClear: false, returnScreen: "settings" };
}

export function persistedWizardState(state: WizardState) {
  return { screen: state.screen === "welcome" ? "welcome" : "settings", baseUrl: resumableAddress(state.fields.baseUrl),
    endpoint: resumableAddress(state.fields.endpoint, true), bucket: /^[a-z0-9-]{1,63}$/u.test(state.fields.bucket) ? state.fields.bucket : "" };
}

export function canSubmit(state: WizardState): boolean {
  return state.screen === "settings" && Object.values(state.fields).every((value) => value.trim().length > 0);
}

export function wizardReducer(state: WizardState, action: WizardAction): WizardState {
  if (state.screen === "working" && ["field", "toggle-secret", "begin", "edit", "confirm-clear", "cancel-clear"].includes(action.type)) return state;
  switch (action.type) {
    case "begin": case "edit": return { ...state, screen: "settings", confirmClear: false };
    case "field": return { ...state, fields: { ...state.fields, [action.field]: action.value } };
    case "toggle-secret": return { ...state, visible: { ...state.visible, [action.field]: !state.visible[action.field] } };
    case "working": {
      const { error: _error, ...rest } = state;
      return { ...rest, screen: "working", stage: "validating", confirmClear: false, visible: hidden(), returnScreen: state.screen === "complete" ? "complete" : "settings" };
    }
    case "progress": return action.progress.kind === "stage" ? { ...state, stage: action.progress.stage } : state;
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
export function renderWizard(root: HTMLElement, state: WizardState, dispatch: (action: UiAction) => void): void {
  const document = root.ownerDocument;
  const node = <K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] => {
    const element = document.createElement(tag);
    if (text !== undefined) element.textContent = text;
    if (className) element.className = className;
    return element;
  };
  const button = (text: string, action: UiAction, className = "secondary") => {
    const element = node("button", text, className); element.type = "button";
    element.addEventListener("click", () => { dispatch(action); });
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
      if (item.cleanupObjectKey) line.append(node("p", "请在 OSS 中手动删除测试对象："), node("code", item.cleanupObjectKey));
      diagnostics.append(line);
    }
    panel.append(diagnostics);
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
    panel.append(node("p", "让 Codex 开始制作视频", "eyebrow"), node("h1", "在这台电脑上\n准备好 Hypit"),
      node("p", "连接你的 NewAPI 和 OSS，安装视频命令与 Codex Skill。完成后，可以直接用中文描述想做的视频。", "intro"));
    const summary = node("ul", undefined, "summary");
    ["NewAPI：连接你已有的模型服务", "OSS：验证视频素材的上传与下载", "本机：安装命令入口与 Codex Skill"].forEach((text) => summary.append(node("li", text)));
    panel.append(summary, node("p", "API Key 与 OSS 密钥将保存在系统凭据库。请准备好六项配置。", "muted"), button("开始配置", { type: "begin" }, "primary"));
    return;
  }
  if (state.screen === "settings") {
    panel.append(node("h1", "连接 NewAPI 与 OSS"), node("p", "六项均为必填。测试会读取可用模型，并在 OSS 中上传、下载及删除一个小型测试文件。", "intro"));
    if (state.result && !state.result.configured) {
      panel.append(node("h2", "安装尚未完成"), node("p", "请检查以下未完成项目，重新填写配置并测试安装。已保存的 Profile 不代表命令入口与 Skill 已安装。", "muted"));
      appendDiagnostics();
    }
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
      input.value = state.fields[field]; input.autocomplete = "off"; input.spellcheck = false;
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
      row.append(label, control); form.append(row);
    }
    form.append(node("p", "仅地址、Endpoint 和 Bucket 可恢复。关闭向导后，密钥需要重新填写。", "muted"));
    const submit = node("button", state.error ? "重新测试并安装" : "测试连接并安装", "primary"); submit.type = "submit"; submit.id = "submit-setup"; submit.disabled = !canSubmit(state);
    form.addEventListener("submit", (event) => { event.preventDefault(); dispatch({ type: "submit" }); });
    form.append(submit); panel.append(form);
    if (state.result) {
      panel.append(button("重新运行诊断", { type: "diagnostics" }), button("清除本机配置和凭据…", { type: "clear" }, "text-button"));
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
    node("p", "请重启 Codex 和 Terminal，再测试 hypit 命令是否可用。", "intro"));
  if (state.result) appendDiagnostics();
  panel.append(node("p", "在 Codex 中试试", "eyebrow"), node("blockquote", EXAMPLE_PROMPT), node("p", "Chrome 和 WhisperX 及模型权重可能在以后首次使用时下载。", "muted"));
  const actions = node("div", undefined, "actions");
  actions.append(button("重新运行诊断", { type: "diagnostics" }, "primary"), button("打开配置目录", { type: "open-config" }), button("修改配置", { type: "edit" }));
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
  const render = () => { if (!disposed) renderWizard(root, state, dispatch); };
  const persist = () => { try { storage.setItem(draftKey, JSON.stringify(persistedWizardState(state))); } catch { /* Storage may be disabled; setup still works. */ } };
  const failure: SetupFailure = { code: "SETUP_REQUEST_FAILED", message: "操作失败，请检查配置后重试" };
  async function dispatch(action: UiAction): Promise<void> {
    if (disposed || busy && !["progress"].includes(action.type)) return;
    if (action.type !== "progress") interactionGeneration++;
    if (["submit", "diagnostics", "clear", "open-config", "remove-integration"].includes(action.type)) {
      if (action.type === "submit" && !canSubmit(state)) return;
      if (action.type === "clear" && !state.confirmClear && state.screen !== "settings") return;
      const input = action.type === "submit" ? setupInput(state) : undefined;
      busy = true;
      if (action.type !== "open-config") state = wizardReducer(state, { type: "working" });
      render();
      try {
        if (action.type === "open-config") {
          const reply = await bridge.openConfigDirectory();
          if (!reply.ok) state = wizardReducer(state, { type: "failure", error: reply.error });
        } else {
          const reply = action.type === "submit" ? await bridge.submit(input!) : action.type === "clear" ? await bridge.clearConfiguration() : action.type === "remove-integration" ? await bridge.removeIntegration() : await bridge.rerunDiagnostics();
          state = reply.ok ? wizardReducer(state, { type: "success", result: reply.value }) : wizardReducer(state, { type: "failure", error: reply.error });
          if (action.type === "clear" && reply.ok) { state = { ...initialWizardState(), screen: "settings", result: reply.value }; try { storage.removeItem(draftKey); } catch {} }
        }
      } catch { state = wizardReducer(state, { type: "failure", error: failure }); }
      finally { busy = false; persist(); render(); }
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
