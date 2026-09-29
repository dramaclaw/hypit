import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { parseHTML } from "linkedom";
import { canSubmit, initialWizardState, persistedWizardState, renderWizard, mountWizard, stageCopy, wizardReducer, EXAMPLE_PROMPT } from "../src/renderer.js";
import type { SetupResult } from "../src/contracts.js";

const fields = { baseUrl: "https://api.example/v1", apiKey: "SECRET_API", endpoint: "oss.example", bucket: "test-bucket", accessKeyId: "SECRET_ID", accessKeySecret: "SECRET_KEY" };
const result: SetupResult = { configured: true, modelCount: 2, relayVerified: true, profilePath: "/profile", skillPath: "/skill", launcherPath: "/launcher", diagnostics: [] };
const filled = () => Object.entries(fields).reduce((state, [field, value]) => wizardReducer(state, { type: "field", field: field as keyof typeof fields, value }), wizardReducer(initialWizardState(), { type: "begin" }));

test("all six fields are required and secrets toggle individually", () => {
  const state = filled();
  assert.equal(canSubmit(state), true);
  for (const field of Object.keys(fields) as (keyof typeof fields)[]) assert.equal(canSubmit(wizardReducer(state, { type: "field", field, value: " " })), false);
  const visible = wizardReducer(state, { type: "toggle-secret", field: "apiKey" });
  assert.equal(visible.visible.apiKey, true);
  assert.equal(visible.visible.accessKeySecret, false);
  assert.equal(wizardReducer(visible, { type: "toggle-secret", field: "apiKey" }).visible.apiKey, false);
});

test("work disables repeat submission, success wipes secrets, failure permits retry", () => {
  const state = wizardReducer(filled(), { type: "working" });
  assert.equal(state.screen, "working");
  assert.equal(canSubmit(state), false);
  assert.deepEqual(wizardReducer(state, { type: "field", field: "bucket", value: "changed" }), state);
  const failure = wizardReducer(state, { type: "failure", error: { code: "SETUP_OSS_FAILED", message: "OSS 连接测试失败", cleanupObjectKey: "relay/hypit/setup-test/probe.txt" } });
  assert.equal(failure.screen, "settings");
  assert.equal(canSubmit(failure), true);
  assert.equal(failure.error?.cleanupObjectKey, "relay/hypit/setup-test/probe.txt");
  const success = wizardReducer(state, { type: "success", result });
  assert.equal(success.screen, "complete");
  for (const secret of ["apiKey", "accessKeyId", "accessKeySecret"] as const) assert.equal(success.fields[secret], "");
});

test("failed edits to an existing setup return to settings for retry", () => {
  let state = wizardReducer(filled(), { type: "success", result });
  state = wizardReducer(state, { type: "edit" });
  state = wizardReducer(state, { type: "working" });
  state = wizardReducer(state, { type: "failure", error: { code: "SETUP_NEWAPI_FAILED", message: "NewAPI 连接测试失败" } });
  assert.equal(state.screen, "settings");
});

test("resumption accepts only non-secret draft fields and never restores working state", () => {
  const draft = persistedWizardState(wizardReducer(filled(), { type: "working" }));
  assert.deepEqual(draft, { screen: "settings", baseUrl: fields.baseUrl, endpoint: fields.endpoint, bucket: fields.bucket });
  assert.equal(JSON.stringify(draft).includes("SECRET"), false);
  const restored = initialWizardState({ ...draft, apiKey: "secret", accessKeyId: "secret", accessKeySecret: "secret" });
  assert.equal(restored.fields.apiKey, "");
  assert.equal(restored.fields.endpoint, fields.endpoint);
  assert.equal(restored.screen, "settings");
});

test("Chinese stages, cleanup warning and literal example render safely", () => {
  assert.equal(stageCopy["testing-newapi"], "正在测试 NewAPI");
  assert.equal(stageCopy["testing-oss"], "正在测试 OSS 上传、下载与清理");
  const { document } = parseHTML("<main id='app'></main>");
  const root = document.getElementById("app")! as unknown as HTMLElement;
  const failure = wizardReducer(filled(), { type: "failure", error: { code: "SETUP_OSS_FAILED", message: "OSS 连接测试失败", cleanupObjectKey: "<img src=x onerror=alert(1)>" } });
  renderWizard(root, failure, () => {});
  assert.match(root.textContent!, /请在 OSS 中手动删除测试对象/);
  assert.equal(root.querySelector("img"), null);
  renderWizard(root, wizardReducer(filled(), { type: "success", result }), () => {});
  assert.ok(root.textContent?.includes(EXAMPLE_PROMPT));
  assert.equal(EXAMPLE_PROMPT, "请使用 $hypit，把我的参考视频改编成新版本；使用本机已配置的 NewAPI 和 OSS。");
  assert.match(root.textContent!, /Chrome.*WhisperX.*下载/);
});

test("wizard DOM uses password inputs and disables actions while working", () => {
  const { document } = parseHTML("<main id='app'></main>");
  const root = document.getElementById("app")! as unknown as HTMLElement;
  renderWizard(root, filled(), () => {});
  assert.equal(root.querySelectorAll('input[type="password"]').length, 3);
  assert.equal(root.querySelectorAll("input[required]").length, 6);
  renderWizard(root, wizardReducer(filled(), { type: "working" }), () => {});
  assert.equal(root.querySelectorAll("input").length, 0);
  assert.equal(root.querySelectorAll("button:not([disabled])").length, 0);
});

test("local document CSP disallows network, inline scripts, objects, framing and forms", async () => {
  const html = await readFile(new URL("../ui/index.html", import.meta.url), "utf8");
  for (const directive of ["default-src 'none'", "script-src 'self'", "connect-src 'none'", "object-src 'none'", "form-action 'none'", "base-uri 'none'"]) assert.ok(html.includes(directive));
  assert.equal(html.includes("unsafe-inline"), false);
  assert.match(html, /lang="zh-CN"/);
});

test("typing then submitting sends current fields and unsubscribes on disposal", async () => {
  const { document, window } = parseHTML("<main id='app'></main>");
  const root = document.getElementById("app")! as unknown as HTMLElement;
  let submitted: unknown;
  let detached = false;
  const draft: string[] = [];
  const dispose = mountWizard(root, { getStatus: async () => ({ ok: true, value: { ...result, configured: false } }),
    submit: async (input) => { submitted = input; return { ok: true, value: result }; }, rerunDiagnostics: async () => ({ ok: true, value: result }),
    openConfigDirectory: async () => ({ ok: true, value: undefined }), clearConfiguration: async () => ({ ok: true, value: result }),
    onProgress: () => () => { detached = true; } }, { getItem: () => null, setItem: (_key, value) => { draft.push(value); }, removeItem: () => {} });
  root.querySelector<HTMLButtonElement>("button")!.click();
  for (const [field, value] of Object.entries(fields)) {
    const input = root.querySelector<HTMLInputElement>(`#${field}`)!; input.value = value;
    input.dispatchEvent(new window.Event("input", { bubbles: true }));
  }
  assert.equal(root.querySelector<HTMLButtonElement>("#submit-setup")!.disabled, false);
  root.querySelector("form")!.dispatchEvent(new window.Event("submit", { cancelable: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(submitted, { baseUrl: fields.baseUrl, apiKey: fields.apiKey, relay: { enabled: true, endpoint: fields.endpoint, bucket: fields.bucket, accessKeyId: fields.accessKeyId, accessKeySecret: fields.accessKeySecret } });
  assert.equal(draft.some((value) => value.includes("SECRET")), false);
  assert.match(root.textContent!, /Hypit 已配置/);
  dispose();
  assert.equal(detached, true);
  assert.equal(root.childNodes.length, 0);
});
