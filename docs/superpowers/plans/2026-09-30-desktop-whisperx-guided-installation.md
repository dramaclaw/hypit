# Desktop WhisperX Guided Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an optional one-click local WhisperX installer to Hypit Setup, using a bundled pinned `uv`, managed `small/cpu/int8` resources for `zh` and `en`, ownership-safe Profile activation, and a non-technical Chinese UI.

**Architecture:** Extend the existing locked desktop resource pipeline with `uv` 0.12.20, then isolate WhisperX preparation in a dedicated desktop service that runs the existing Hypit Managed Program against a temporary candidate Profile with the bundled `uv` first on `PATH`. Only after the service is healthy does an ownership-aware Profile transaction publish `whisperx.local` and its existing `@hypit/whisperx@1#whisperx-alignment` binding. IPC exposes fixed no-secret actions and allowlisted progress/status; renderer, uninstall, diagnostics, and packaging consume those contracts without duplicating Managed Program logic.

**Tech Stack:** TypeScript, Node.js child processes and filesystem transactions, Electron context-isolated IPC, Hypit Runtime Profile and Managed Programs, `@hypit/provider-whisperx-local`, uv 0.12.20, Python/WhisperX frozen service lock, Node test runner, electron-builder DMG/NSIS packaging.

## Global Constraints

- Local WhisperX is optional and begins only after an explicit user action.
- Bundle uv 0.12.20 for `darwin-arm64` and `win32-x64`; never run an installer script and never fall back to a system `uv`.
- Default local configuration is `small`, `cpu`, `int8`, alignment languages `zh` and `en`.
- Python, packages, weights, language resources, logs, and process state live in Hypit's machine Program Home, never in a video project or system Python.
- Prepare and health-check the candidate Endpoint before publishing the real Profile.
- Modify only `endpoints["whisperx.local"]` and `bindings["@hypit/whisperx@1#whisperx-alignment"]`; preserve every unrelated byte and reject conflicting user-owned values.
- WhisperX actions do not read, test, write, or return NewAPI or OSS credentials.
- All IPC inputs, progress, statuses, errors, and paths are fixed-shape, bounded, hostile-object-safe, and secret-free.
- Closing the renderer does not cancel or misclassify a running preparation; reopening reads real state.
- Resource cleanup defaults to retaining local Python and model data; destructive removal requires a separate explicit confirmation.
- Windows artifacts are cross-built and statically inspected; do not claim native Windows acceptance.
- Future NewAPI alignment reuses `@hypit/whisperx@1#whisperx-alignment` and does not require project rewrites.

---

## File Map

- Create `packages/desktop-setup/uv-lock.json`: pinned target archives, members, hashes, sizes, version, license metadata.
- Create `packages/desktop-setup/uv-licenses/LICENSE-APACHE` and `LICENSE-MIT`: uv licensing material copied from the selected upstream tag.
- Modify `packages/desktop-setup/scripts/prepare-resources.mjs`: download, verify, decode, inspect, and stage target `uv`.
- Modify `packages/desktop-setup/scripts/check-artifact.mjs`: validate packaged `uv`, manifest fields, architecture, version, and licenses.
- Create `packages/desktop-setup/src/whisperx-profile.ts`: exact managed Endpoint/binding merge, conflict detection, candidate Profile transaction.
- Create `packages/desktop-setup/src/whisperx-program.ts`: serialized status/prepare/start/stop service using bundled CLI and `uv`.
- Modify `packages/desktop-setup/src/contracts.ts`, `ipc.ts`, `preload.ts`, and `main.ts`: no-secret WhisperX contracts and controller operations.
- Modify `packages/desktop-setup/src/renderer.ts`: optional card, progress, actions, retry guidance.
- Modify `packages/desktop-setup/src/cleanup-entry.ts` and `build/installer.nsh`: retain-by-default and explicit managed-resource removal guidance.
- Modify `skills/hypit/references/environment/distribution.md` and `docs/zh/guide/desktop-installer.md`: user instructions and future NewAPI binding behavior.
- Add focused tests beside each responsibility under `packages/desktop-setup/test/`.

---

### Task 1: Lock and package uv for both desktop targets

**Files:**
- Create: `packages/desktop-setup/uv-lock.json`
- Create: `packages/desktop-setup/uv-licenses/LICENSE-APACHE`
- Create: `packages/desktop-setup/uv-licenses/LICENSE-MIT`
- Modify: `packages/desktop-setup/scripts/prepare-resources.mjs`
- Modify: `packages/desktop-setup/scripts/check-artifact.mjs`
- Modify: `packages/desktop-setup/test/prepare-resources.test.ts`
- Modify: `packages/desktop-setup/test/builder-config.test.ts`

**Interfaces:**
- Produces staged `bin/uv` on macOS and `bin/uv.exe` on Windows.
- Produces manifest field `uv: { name: "astral-sh/uv", version: "0.12.20", sha256, bytes }`.
- Later tasks consume `bundledUv` as an absolute executable path resolved beside bundled FFmpeg.

- [ ] **Step 1: Write failing lock and resource tests**

Add tests that require exact target names and reject wrong archive/member hashes, unexpected archive members, target architecture mismatch, executable version mismatch, and missing licenses:

```ts
assert.equal(macManifest.uv.version, "0.12.20");
assert.equal(await isExecutable(join(macOutput, "bin/uv")), true);
assert.equal(await isExecutable(join(winOutput, "bin/uv.exe")), true);
await assert.rejects(stageFixture({ uvArchiveSha256: "0".repeat(64) }), /uv archive integrity mismatch/u);
await assert.rejects(stageFixture({ uvMember: "../uv" }), /safe path|locked member/u);
```

- [ ] **Step 2: Run RED**

```bash
pnpm exec tsx --test packages/desktop-setup/test/prepare-resources.test.ts packages/desktop-setup/test/builder-config.test.ts
```

Expected: failures because no uv lock, staged binary, manifest field, or licenses exist.

- [ ] **Step 3: Add the immutable uv lock**

Select the official uv 0.12.20 release assets:

```text
darwin-arm64: https://github.com/astral-sh/uv/releases/download/0.12.20/uv-aarch64-apple-darwin.tar.gz
member: uv-aarch64-apple-darwin/uv
win32-x64: https://github.com/astral-sh/uv/releases/download/0.12.20/uv-x86_64-pc-windows-msvc.zip
member: uv-x86_64-pc-windows-msvc/uv.exe
```

Download each archive once during implementation, verify its published upstream checksum/attestation, extract only the named member in memory, calculate the member SHA-256 and byte count, and commit those exact immutable values to `uv-lock.json`. Do not accept a floating release URL or calculate trust from the downloaded bytes alone.

- [ ] **Step 4: Stage and inspect uv**

Refactor the existing locked-media helper only enough to share safe cache/download primitives. Add `lockedUv()` that:

```js
assert.equal(digest(download).sha256, item.archiveSha256, "uv archive integrity mismatch");
assert.deepEqual(Object.keys(entries), [item.entry], "Missing locked uv archive member");
assert.deepEqual(digest(bytes), { sha256: item.sha256, bytes: item.bytes }, "uv binary integrity mismatch");
checkUvBinary(bytes, target);
```

Stage the executable under `bin`, copy both licenses under `licenses/uv`, run the staged executable with `--version` on the host-matching target, and statically inspect PE/Mach-O architecture for both targets. Cross-target Windows validation remains static.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec tsx --test packages/desktop-setup/test/prepare-resources.test.ts packages/desktop-setup/test/builder-config.test.ts
pnpm check
git add packages/desktop-setup/uv-lock.json packages/desktop-setup/uv-licenses packages/desktop-setup/scripts packages/desktop-setup/test
git commit -m "build(desktop): bundle locked uv runtime"
```

Expected: focused tests and type-check pass; no generated resource directory is tracked.

---

### Task 2: Build an ownership-safe WhisperX Profile candidate

**Files:**
- Create: `packages/desktop-setup/src/whisperx-profile.ts`
- Create: `packages/desktop-setup/test/whisperx-profile.test.ts`
- Modify: `packages/desktop-setup/src/profile.ts`

**Interfaces:**
- Produces `LOCAL_WHISPERX_ENDPOINT`, `WHISPERX_ALIGNMENT_CAPABILITY`, `localWhisperXConfig`.
- Produces `prepareWhisperXProfile(options): Promise<PreparedWhisperXProfile>`.
- `PreparedWhisperXProfile` exposes `candidatePath`, `commit()`, `rollback()`, and `dispose(committed)`.

- [ ] **Step 1: Write failing merge, conflict, and race tests**

Cover an absent Profile, an existing desktop Profile, unrelated custom Endpoints/bindings, an exact already-managed local configuration, a user-owned `whisperx.local`, a binding to another Endpoint, malformed JSON, symlinks, an edit after preparation, and rollback cleanup failure.

```ts
assert.deepEqual(candidate.endpoints["whisperx.local"], {
  use: "@hypit/provider-whisperx-local",
  pool: "whisperx.local",
  config: { expectedModel: "small", expectedDevice: "cpu", expectedCompute: "int8", alignmentLanguages: ["zh", "en"] },
});
assert.equal(candidate.bindings["@hypit/whisperx@1#whisperx-alignment"], "whisperx.local");
await assert.rejects(prepareWhisperXProfile(conflictingEndpoint), /WHISPERX_PROFILE_CONFLICT/u);
```

- [ ] **Step 2: Run RED**

```bash
pnpm exec tsx --test packages/desktop-setup/test/whisperx-profile.test.ts
```

- [ ] **Step 3: Implement exact managed fragments and candidate creation**

Use fixed constants:

```ts
export const LOCAL_WHISPERX_ENDPOINT = "whisperx.local";
export const WHISPERX_ALIGNMENT_CAPABILITY = "@hypit/whisperx@1#whisperx-alignment";
export const localWhisperXConfig = Object.freeze({
  expectedModel: "small", expectedDevice: "cpu", expectedCompute: "int8",
  alignmentLanguages: ["zh", "en"] as const,
});
```

Candidate files are private temporary siblings of the real Profile so relative `dataRoot` semantics remain identical. Preserve the original document and mutate only the two owned keys. Exact managed values may be refreshed; any other existing value is a conflict.

- [ ] **Step 4: Reuse prepared file publication for the real Profile**

Wrap the existing `snapshotFile()` and `prepareFileChange()` transaction. Preparation records the original Profile snapshot and candidate bytes. Commit succeeds only when the live Profile still matches the original; rollback and cleanup retain changed content and report recovery paths under the existing `CLEANUP_INCOMPLETE` rules.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec tsx --test packages/desktop-setup/test/whisperx-profile.test.ts packages/desktop-setup/test/profile.test.ts
pnpm check
git add packages/desktop-setup/src/whisperx-profile.ts packages/desktop-setup/src/profile.ts packages/desktop-setup/test/whisperx-profile.test.ts
git commit -m "feat(desktop): prepare local WhisperX Profile safely"
```

---

### Task 3: Operate the existing WhisperX Managed Program

**Files:**
- Create: `packages/desktop-setup/src/whisperx-program.ts`
- Create: `packages/desktop-setup/test/whisperx-program.test.ts`
- Modify: `packages/desktop-setup/src/paths.ts`

**Interfaces:**
- Produces `WhisperXProgramStatus`, `WhisperXProgressStage`, and `WhisperXProgramService`.
- Produces `createWhisperXProgramService(options)` with `status()`, `installAndStart(report)`, `start(report)`, and `stop()`.
- Consumes absolute `bundledUv`, `cliEntry`, candidate Profile path, and machine state.

- [ ] **Step 1: Write failing subprocess and resume tests**

Use a fake CLI fixture and assert exact argv/environment:

```ts
assert.deepEqual(call.args, [cliEntry, "programs", "prepare", "--runtime", candidate, "--endpoint", "whisperx.local", "--json"]);
assert.equal(call.env.PATH?.split(delimiter)[0], dirname(bundledUv));
assert.equal(call.env.UV, undefined);
assert.equal(JSON.stringify(publicStatus).includes("SECRET"), false);
```

Cover prepared/stopped/starting/ready/mismatch/failure, process still running after renderer closure, repeated install calls sharing one in-flight promise, bounded stdout/stderr, timeout, cancellation of observation without killing preparation, and restart after cached preparation.

- [ ] **Step 2: Run RED**

```bash
pnpm exec tsx --test packages/desktop-setup/test/whisperx-program.test.ts
```

- [ ] **Step 3: Implement bounded CLI execution**

Invoke the packaged Hypit CLI through the packaged Node executable with `shell: false`, `windowsHide: true`, a bounded output buffer, and a fixed environment that prepends only the bundled `uv` directory to inherited `PATH`. Validate that `bundledUv` is an absolute regular executable inside the packaged `bin` directory before every mutation.

Preparation uses two candidate passes so UI stages are truthful:

```text
candidate 1: alignmentLanguages ["zh"] -> programs prepare
candidate 2: alignmentLanguages ["zh", "en"] -> programs prepare
final candidate -> programs up
final candidate -> programs status
```

The second pass reuses Python, packages, ASR, and Chinese caches. Map only fixed stages: `preparing-python`, `preparing-model`, `preparing-zh`, `preparing-en`, `starting-service`, `ready`.

- [ ] **Step 4: Publish Profile only after readiness**

`installAndStart()` prepares the `PreparedWhisperXProfile`, runs both prepare passes and `programs up`, verifies status `ready`, commits the real Profile, and disposes the candidate transaction. Any failure before Profile commit leaves the original Profile untouched and retains reusable Program data. Profile commit failure leaves the ready service/resources available for retry and reports a fixed public error.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec tsx --test packages/desktop-setup/test/whisperx-program.test.ts packages/desktop-setup/test/whisperx-profile.test.ts
pnpm check
git add packages/desktop-setup/src/whisperx-program.ts packages/desktop-setup/src/paths.ts packages/desktop-setup/test/whisperx-program.test.ts
git commit -m "feat(desktop): manage optional local WhisperX"
```

---

### Task 4: Add no-secret IPC and controller operations

**Files:**
- Modify: `packages/desktop-setup/src/contracts.ts`
- Modify: `packages/desktop-setup/src/ipc.ts`
- Modify: `packages/desktop-setup/src/preload.ts`
- Modify: `packages/desktop-setup/src/main.ts`
- Modify: `packages/desktop-setup/test/main-security.test.ts`

**Interfaces:**
- Adds channels `setup:whisperx-status`, `setup:whisperx-install`, `setup:whisperx-start`, `setup:whisperx-stop`.
- Adds bridge methods with no arguments and `SetupReply<WhisperXPublicStatus>`.
- Adds progress stages to the existing `SetupProgress` union.

- [ ] **Step 1: Write failing channel, queue, and hostile-value tests**

Assert every new action accepts exactly zero arguments, uses trusted-sender checks, shares the existing serialized queue, returns only canonical public fields, recovers the queue after hostile errors, and never invokes credential/NewAPI/OSS services.

```ts
for (const channel of whisperXChannels) {
  assert.equal(validateIpcArguments(channel, []), undefined);
  assert.throws(() => validateIpcArguments(channel, [{ apiKey: "SECRET" }]));
}
assert.equal(calls.credentials, 0);
assert.equal(calls.newapi, 0);
assert.equal(calls.oss, 0);
```

- [ ] **Step 2: Run RED**

```bash
pnpm exec tsx --test packages/desktop-setup/test/main-security.test.ts
```

- [ ] **Step 3: Define exact public status**

```ts
export type WhisperXPublicStatus = {
  readonly state: "not-installed" | "preparing" | "stopped" | "ready" | "mismatch" | "failed";
  readonly model: "small";
  readonly device: "cpu";
  readonly compute: "int8";
  readonly languages: readonly ["zh", "en"];
  readonly stage?: WhisperXProgressStage;
  readonly logPath?: string;
  readonly errorCode?: "WHISPERX_PREPARE_FAILED" | "WHISPERX_START_FAILED" | "WHISPERX_PROFILE_CONFLICT" | "WHISPERX_UV_INVALID";
};
```

Project this object field-by-field using the existing hostile-object rules: single reads, bounded arrays, canonical enum reconstruction, safe paths, total error serialization, and fresh output objects.

- [ ] **Step 4: Wire services and preserve renderer-independent work**

Controller operations enqueue status/install/start/stop. Progress listeners are observers only; listener removal or renderer closure never cancels the Managed Program command. A second install request waits for or reports the existing in-flight operation rather than spawning another preparation.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec tsx --test packages/desktop-setup/test/main-security.test.ts packages/desktop-setup/test/whisperx-program.test.ts
pnpm check
git add packages/desktop-setup/src/contracts.ts packages/desktop-setup/src/ipc.ts packages/desktop-setup/src/preload.ts packages/desktop-setup/src/main.ts packages/desktop-setup/test/main-security.test.ts
git commit -m "feat(desktop): expose safe WhisperX setup controls"
```

---

### Task 5: Add the optional Chinese setup card

**Files:**
- Modify: `packages/desktop-setup/src/renderer.ts`
- Modify: `packages/desktop-setup/test/renderer.test.ts`

**Interfaces:**
- Consumes `WhisperXPublicStatus` and no-argument bridge methods.
- Produces renderer actions `whisperx-status`, `whisperx-install`, `whisperx-start`, and `whisperx-stop`.

- [ ] **Step 1: Write failing UI and reducer tests**

Render every state and assert the exact principal copy:

```text
本地语音识别与字幕对齐（可选）
small · CPU · int8
中文和英文
安装并启动
重试安装
启动服务
停止服务
检查状态
```

Assert no button sends credentials, all mutation buttons disable while any mutation is pending, target/log paths use `textContent`, repeated clicks do not dispatch twice, reopen status comes from the bridge, and failure copy contains only fixed public messages.

- [ ] **Step 2: Run RED**

```bash
pnpm exec tsx --test packages/desktop-setup/test/renderer.test.ts
```

- [ ] **Step 3: Implement state and card rendering**

Keep WhisperX state separate from the NewAPI form fields. The card is visible after configuration and on later launches. Before installation, show that downloads can be large/slow, no NewAPI model fee is charged, and local preparation does not access NewAPI/OSS credentials. Do not promise an exact byte count or duration.

- [ ] **Step 4: Implement actions and progress**

Map fixed stages to Chinese copy, clear stale errors at action start, preserve current state while a request is pending, and refresh status after each terminal result. Closing/unsubscribing only detaches progress observation.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec tsx --test packages/desktop-setup/test/renderer.test.ts packages/desktop-setup/test/main-security.test.ts
pnpm --filter @hypit/desktop-setup build
pnpm check
git add packages/desktop-setup/src/renderer.ts packages/desktop-setup/test/renderer.test.ts
git commit -m "feat(desktop): guide local WhisperX installation"
```

---

### Task 6: Add retention-safe removal, documentation, and final packaging evidence

**Files:**
- Modify: `packages/desktop-setup/src/cleanup-entry.ts`
- Modify: `packages/desktop-setup/build/installer.nsh`
- Modify: `packages/desktop-setup/test/uninstall.test.ts`
- Modify: `packages/desktop-setup/test/builder-config.test.ts`
- Modify: `skills/hypit/references/environment/distribution.md`
- Modify: `docs/zh/guide/desktop-installer.md`
- Modify: `packages/desktop-setup/TEST-REPORT.md`

**Interfaces:**
- Default uninstall retains Program Home.
- Explicit confirmed cleanup removes only the exact owned WhisperX Program root and never shared/upstream caches without separate ownership proof.

- [ ] **Step 1: Write failing removal and documentation tests**

Cover default retention, explicit exact-root deletion, modified/unknown root preservation, symlink refusal, cleanup warning display, and documentation strings for optional local setup and future NewAPI binding.

```ts
assert.equal(await exists(f.whisperXProgramRoot), true, "ordinary uninstall retains models");
await removeLocalWhisperXResources({ confirmed: true, ...f.options });
assert.equal(await exists(f.whisperXProgramRoot), false);
```

- [ ] **Step 2: Run RED**

```bash
pnpm exec tsx --test packages/desktop-setup/test/uninstall.test.ts packages/desktop-setup/test/builder-config.test.ts
```

- [ ] **Step 3: Implement retention and explicit cleanup guidance**

Ordinary NSIS/application uninstall prints that local speech resources were retained and gives the exact Hypit Setup action for removal. If both native uninstallers cannot safely offer the same explicit confirmation, expose `删除本地语音资源` in Hypit Setup before launching uninstall; do not add asymmetric implicit deletion.

- [ ] **Step 4: Update documentation**

Document the optional card, defaults, managed storage, retry/status commands, log locations, no NewAPI fee/credential access, retained resources, and future binding switch. State that sentence-only timestamps cannot replace word-level alignment.

- [ ] **Step 5: Run full verification**

```bash
git diff --check
pnpm check
pnpm test
pnpm --filter @hypit/desktop-setup build
node --import tsx --test packages/desktop-setup/test/*.test.ts
```

Expected: zero failures; conditional platform/media skips are itemized.

- [ ] **Step 6: Build and inspect installers**

```bash
pnpm desktop:dist:mac
pnpm desktop:dist:win
```

Verify the DMG mounts and contains the exact `uv`/licenses/runtime/Skill, the EXE unpacks and passes static resource/architecture inspection, checksums match adjacent files, no generated artifact is tracked, and the report states that native Windows WhisperX preparation remains untested.

- [ ] **Step 7: Run available secret checks and commit**

```bash
pre-commit run --all-files
git status --short
git add packages/desktop-setup skills/hypit/references/environment/distribution.md docs/zh/guide/desktop-installer.md
git commit -m "docs(desktop): document managed local WhisperX"
```

If `pre-commit` or `gitleaks` is unavailable, record the exact command-not-found limitation. Record unsigned/notarization, native Windows, fresh-download, real-service, and real-credential limitations without weakening test claims.

---

## Final Review Checklist

- [ ] `uv` 0.12.20 is immutable, licensed, target-specific, inspected, and packaged; no system fallback exists.
- [ ] The initial NewAPI/OSS setup remains usable without WhisperX downloads.
- [ ] One explicit click prepares `small/cpu/int8` and `zh/en` through the existing Managed Program.
- [ ] Candidate preparation and health succeed before the real Profile changes.
- [ ] User-owned Endpoint/binding/Profile edits are preserved or rejected with recovery guidance.
- [ ] Closing/reopening the renderer does not stop or misreport preparation.
- [ ] Status/install/start/stop IPC is zero-argument, serialized, hostile-safe, and credential-free.
- [ ] Local readiness produces real word-level alignment, not transcript text alone.
- [ ] Ordinary uninstall retains local resources; explicit deletion is separately confirmed and ownership-safe.
- [ ] A future NewAPI implementation can take the same capability binding without project changes.
- [ ] Full tests, desktop tests, build, DMG mount, EXE extraction, resource inspection, and checksums have fresh evidence.

