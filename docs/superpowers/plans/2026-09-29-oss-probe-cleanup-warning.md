# OSS Probe Cleanup Warning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow Hypit desktop setup to complete when the OSS probe is uploaded and downloaded successfully but its best-effort deletion fails.

**Architecture:** The NewAPI provider will return a successful connection result with an optional validated cleanup object key instead of throwing for cleanup-only failure. Desktop setup, diagnostics, IPC, and renderer will propagate that key as a warning while retaining blocking failures for upload, signing, download, and content verification.

**Tech Stack:** TypeScript, Node.js test runner, Electron renderer DOM, `ali-oss`, electron-builder.

## Global Constraints

- NewAPI models, OSS upload, signature creation, download, and exact probe content validation remain mandatory.
- OSS deletion remains best-effort and is still attempted after every successful upload.
- Only `relay/hypit/setup-test/<UUID-v4>.txt` may cross the provider/desktop/IPC warning boundary.
- SDK errors, signed URLs, endpoints, bucket names, and credentials must never cross IPC or appear in logs/UI.
- No paid image or video generation is run during verification.

---

### Task 1: Make OSS cleanup failure non-blocking end to end

**Files:**
- Modify: `packages/provider-newapi/src/connection-test.ts`
- Modify: `packages/provider-newapi/test/connection-test.test.ts`
- Modify: `packages/desktop-setup/src/contracts.ts`
- Modify: `packages/desktop-setup/src/setup-core.ts`
- Modify: `packages/desktop-setup/src/diagnostics.ts`
- Modify: `packages/desktop-setup/src/renderer.ts`
- Modify: `packages/desktop-setup/test/setup-core.test.ts`
- Modify: `packages/desktop-setup/test/diagnostics.test.ts`
- Modify: `packages/desktop-setup/test/renderer.test.ts`
- Modify: `packages/desktop-setup/TEST-REPORT.md`

**Interfaces:**
- Produces: `NewApiConnectionTestResult = { modelCount: number; relayVerified: true; cleanupObjectKey?: string }`.
- Produces: successful desktop setup diagnostics where the OSS item is `{ code: "oss", status: "warning", label: "OSS", cleanupObjectKey }` when deletion alone fails.
- Retains: thrown safe provider errors for upload, signing, download, and content mismatch.

- [ ] **Step 1: Write provider failing tests**

Change the cleanup-failure test to require a resolved result and prove deletion was attempted:

```ts
const result = await testNewApiSetupConnection(input, dependenciesWithFailingDelete);
assert.deepEqual(result, {
  modelCount: 1,
  relayVerified: true,
  cleanupObjectKey: objectKey,
});
assert.equal(deleteAttempts, 1);
```

Keep or add separate rejection tests for `put`, `signatureUrl`, signed `GET`, and content mismatch.

- [ ] **Step 2: Run provider test and verify RED**

Run:

```bash
node --import tsx --test packages/provider-newapi/test/connection-test.test.ts
```

Expected: cleanup-failure test fails because the current implementation throws `OSS probe cleanup failed`.

- [ ] **Step 3: Implement provider result warning**

Extend the result type and avoid throwing from `finally`:

```ts
export type NewApiConnectionTestResult = {
  readonly modelCount: number;
  readonly relayVerified: true;
  readonly cleanupObjectKey?: string;
};

let cleanupObjectKey: string | undefined;
// after successful upload/sign/download
try {
  await client.delete(objectKey);
} catch {
  cleanupObjectKey = objectKey;
}
return { modelCount: count, relayVerified: true, ...(cleanupObjectKey ? { cleanupObjectKey } : {}) };
```

Structure control flow so a download/signing failure remains the thrown primary error even if deletion also fails; the cleanup warning is returned only after all mandatory checks succeed.

- [ ] **Step 4: Run provider tests and verify GREEN**

Run:

```bash
node --import tsx --test packages/provider-newapi/test/connection-test.test.ts packages/provider-newapi/test/setup.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Write desktop failing tests**

Add assertions that a successful connection result with `cleanupObjectKey`:

```ts
assert.equal(result.configured, true);
assert.deepEqual(result.diagnostics.find(item => item.code === "oss"), {
  code: "oss",
  status: "warning",
  label: "OSS",
  cleanupObjectKey: objectKey,
});
assert.equal(profileWrites, 1);
```

Add diagnostics and renderer assertions for the warning copy “OSS 已验证；测试对象未自动删除” and ensure the page is the configured/completed state, not the failure page.

- [ ] **Step 6: Run desktop tests and verify RED**

Run:

```bash
node --import tsx --test packages/desktop-setup/test/setup-core.test.ts packages/desktop-setup/test/diagnostics.test.ts packages/desktop-setup/test/renderer.test.ts
```

Expected: tests fail because setup currently recognizes cleanup only as a thrown OSS failure and successful diagnostics cannot carry the key.

- [ ] **Step 7: Propagate the warning through desktop setup and UI**

Update contracts so diagnostic items may safely carry `cleanupObjectKey`. In `commitDesktopSetup`, derive the OSS diagnostic from the successful connection result:

```ts
const ossDiagnostic = connection.cleanupObjectKey
  ? { code: "oss", status: "warning", label: "OSS", cleanupObjectKey: connection.cleanupObjectKey }
  : { code: "oss", status: "pass", label: "OSS" };
```

Use the same interpretation in diagnostics. Render warning status with the exact safe object key and keep `configured: true`. Remove the obsolete parsing path for a thrown cleanup-only error while retaining strict IPC key validation.

- [ ] **Step 8: Verify focused and complete suites**

Run:

```bash
node --import tsx --test packages/provider-newapi/test/*.test.ts packages/desktop-setup/test/*.test.ts
npm run check
npm test
git diff --check
```

Expected: all tests and type checking pass; no paid generation runs.

- [ ] **Step 9: Rebuild and inspect final installers**

Run:

```bash
npm run desktop:dist:mac
npm run desktop:dist:win
cd packages/desktop-setup/release
shasum -a 256 -c Hypit-Setup-0.1.0-arm64.dmg.sha256
shasum -a 256 -c Hypit-Setup-0.1.0-x64.exe.sha256
```

Expected: DMG and EXE build successfully and both checksum checks print `OK`. Mount/inspect the DMG and unpack/inspect the EXE with the existing package inspection scripts. Windows remains cross-built and not native-machine verified.

- [ ] **Step 10: Update acceptance report and commit**

Document that cleanup-only failure is a warning, record new file sizes/hashes, preserve unsigned/Windows/paid-generation limitations, and commit:

```bash
git add packages/provider-newapi packages/desktop-setup docs/superpowers
git commit -m "fix(desktop): make OSS probe cleanup nonblocking"
```
