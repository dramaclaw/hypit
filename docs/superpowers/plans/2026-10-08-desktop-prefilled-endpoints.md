# Desktop Editable Endpoint Defaults Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepopulate the Hypit desktop setup form with the requested NewAPI and OSS values while keeping them editable and keeping secrets blank.

**Architecture:** `initialWizardState` is the sole source of initial form values and draft restoration. Add three non-secret defaults there, apply each only when the sanitized saved value is empty, and continue using the existing reducer, `setupInput`, and draft persistence without changing Profile or credential handling.

**Tech Stack:** TypeScript, Electron renderer, Node test runner, pnpm, electron-builder.

## Global Constraints

- NewAPI default: `https://llm-gateway-test.cdnfg.com/v1`.
- OSS Endpoint default: `oss-cn-chengdu.aliyuncs.com`.
- OSS Bucket default: `claymore-llm-relay`.
- API Key, OSS AccessKey ID, and OSS AccessKey Secret must remain blank and must never enter the saved draft.
- Existing valid non-empty custom draft values take precedence; absent, blank, or invalid values receive defaults.
- Editing, clearing, and submitting fields must use the current user-entered values, not reapply defaults after initialization.
- Opening the wizard must not mutate Runtime Profile, credentials, or server state.
- Build macOS ARM64 DMG and Windows x64 EXE; Windows real-machine launch is outside this verification.

---

### Task 1: Prefill the three editable fields

**Files:**
- Modify: `packages/desktop-setup/src/renderer.ts:10-54,184-205`
- Test: `packages/desktop-setup/test/renderer.test.ts`

**Interfaces:**
- Consumes: `initialWizardState(draft?: unknown): WizardState`, `wizardReducer(state, action): WizardState`, `persistedWizardState(state)`, and `setupInput(state)` in `renderer.ts`.
- Produces: the same public signatures; only initial field values and matching placeholders change.

- [ ] **Step 1: Write failing tests** in `renderer.test.ts` for first-run values, old empty/invalid draft fallback, valid custom draft priority, editable values, blank secrets, and non-secret draft persistence. Add `setupInput` to the existing import from `../src/renderer.js`, then add:

```ts
const defaults = { baseUrl: "https://llm-gateway-test.cdnfg.com/v1", endpoint: "oss-cn-chengdu.aliyuncs.com", bucket: "claymore-llm-relay" };
test("fresh setup prepopulates editable NewAPI and OSS values, not secrets", () => {
  const initial = initialWizardState();
  for (const [field, value] of Object.entries(defaults)) assert.equal(initial.fields[field as keyof typeof defaults], value);
  for (const field of ["apiKey", "accessKeyId", "accessKeySecret"] as const) assert.equal(initial.fields[field], "");
  const changed = wizardReducer(initial, { type: "field", field: "bucket", value: "team-bucket" });
  assert.equal(changed.fields.bucket, "team-bucket");
  assert.equal(persistedWizardState(changed).bucket, "team-bucket");
  assert.deepEqual(setupInput(changed).relay, { enabled: true, endpoint: defaults.endpoint,
    bucket: "team-bucket", accessKeyId: "", accessKeySecret: "" });
  assert.equal(JSON.stringify(persistedWizardState(changed)).includes("apiKey"), false);
});
test("valid custom draft wins while missing, empty, or invalid fields use defaults", () => {
  const custom = initialWizardState({ baseUrl: "https://custom.example/v1", endpoint: "oss.example", bucket: "team-bucket", apiKey: "unsafe" });
  assert.deepEqual({ baseUrl: custom.fields.baseUrl, endpoint: custom.fields.endpoint, bucket: custom.fields.bucket },
    { baseUrl: "https://custom.example/v1", endpoint: "oss.example", bucket: "team-bucket" });
  assert.equal(custom.fields.apiKey, "");
  const recovered = initialWizardState({ baseUrl: "", endpoint: "https://user:pass@oss.example", bucket: "BAD_BUCKET" });
  assert.deepEqual({ baseUrl: recovered.fields.baseUrl, endpoint: recovered.fields.endpoint, bucket: recovered.fields.bucket }, defaults);
});
test("settings inputs display real default values and allow editing", () => {
  const { document } = parseHTML("<main id='app'></main>");
  const root = document.getElementById("app")! as unknown as HTMLElement;
  const state = wizardReducer(initialWizardState(), { type: "begin" });
  renderWizard(root, state, () => {});
  for (const [field, value] of Object.entries(defaults)) {
    assert.equal(root.querySelector<HTMLInputElement>(`#${field}`)?.value, value);
    assert.equal(root.querySelector<HTMLInputElement>(`#${field}`)?.disabled, false);
  }
});
```

- [ ] **Step 2: Verify RED.** Run `node --import tsx --test packages/desktop-setup/test/renderer.test.ts`. Expect the two new tests to fail because initial values are currently empty.

- [ ] **Step 3: Add the minimal implementation** in `renderer.ts`:

```ts
const defaultAddresses = {
  baseUrl: "https://llm-gateway-test.cdnfg.com/v1",
  endpoint: "oss-cn-chengdu.aliyuncs.com",
  bucket: "claymore-llm-relay",
} as const;

// In initialWizardState:
baseUrl: resumableAddress(item.baseUrl) || defaultAddresses.baseUrl,
apiKey: "",
endpoint: resumableAddress(item.endpoint, true) || defaultAddresses.endpoint,
bucket: typeof item.bucket === "string" && /^[a-z0-9-]{1,63}$/u.test(item.bucket)
  ? item.bucket : defaultAddresses.bucket,
accessKeyId: "",
accessKeySecret: "",

// In renderWizard, use the same values for placeholders after a field is cleared:
const placeholders: Partial<Record<keyof Fields, string>> = { ...defaultAddresses };
```

- [ ] **Step 4: Verify GREEN and regression behavior.** Run `node --import tsx --test packages/desktop-setup/test/renderer.test.ts`. Expect zero failures, including the DOM test from Step 1.

- [ ] **Step 5: Type-check and commit.** Run `pnpm check` and `git diff --check`; expect exit 0. Commit only `renderer.ts` and `renderer.test.ts` with `git commit -m 'feat(desktop): prefill editable NewAPI and OSS addresses'`.

### Task 2: Verify and repackage both desktop installers

**Files:**
- Read: `packages/desktop-setup/scripts/package.mjs`
- Output (ignored build artifacts): `packages/desktop-setup/release/Hypit-Setup-0.1.0-arm64.dmg`, `packages/desktop-setup/release/Hypit-Setup-0.1.0-x64.exe` and their `.sha256` files.

**Interfaces:**
- Consumes: Task 1's renderer output.
- Produces: DMG and EXE installers using the same packaging commands as the prior build.

- [ ] **Step 1: Run the complete test suite.** Run `pnpm test`; expect zero failures. Record skipped tests separately from failures.
- [ ] **Step 2: Confirm free disk space and preserve existing installer artifacts.** Run `df -h .` and `ls -lh packages/desktop-setup/release/Hypit-Setup-0.1.0-*`. If space is tight, remove only generated `release/mac-arm64`, `release/win-unpacked`, `resources/mac-arm64`, and `resources/win-x64` directories after verifying their purpose; do not delete previous final installers or historical backups.
- [ ] **Step 3: Rebuild macOS.** Run `pnpm --filter @hypit/desktop-setup dist:mac`; expect exit 0 and a new DMG checksum. The packaging command mounts the DMG and checks embedded resources.
- [ ] **Step 4: Rebuild Windows.** Run `pnpm --filter @hypit/desktop-setup dist:win`; expect exit 0 and a new EXE checksum. The packaging command unpacks the NSIS installer and checks embedded resources.
- [ ] **Step 5: Verify outputs and branch.** From `packages/desktop-setup/release`, run `shasum -a 256 -c Hypit-Setup-0.1.0-arm64.dmg.sha256 Hypit-Setup-0.1.0-x64.exe.sha256`; expect both `OK`. Run `git status --short` and confirm no source changes remain. Report that the EXE was cross-built on macOS and not boot-tested on Windows.
