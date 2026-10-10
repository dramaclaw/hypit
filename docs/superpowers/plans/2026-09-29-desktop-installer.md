# Hypit One-Click Desktop Installer Implementation Plan

> 2026-09-30 update: Skill installation and Agent integration now follow the [universal Agent design](../specs/2026-09-30-universal-agent-skill-installation-design.md) and [implementation plan](2026-09-30-universal-agent-skill-installation.md), with a portable Skill and a conditional Claude Code compatibility copy. The original task descriptions below remain as historical implementation records.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an unsigned Apple Silicon DMG and a cross-built Windows x64 NSIS installer that install Hypit, its Codex Skill, FFmpeg, and a Chinese NewAPI/OSS setup application for non-technical users.

**Architecture:** A private Electron workspace package supplies a secure Chinese setup UI and a Node-only setup core. The setup core reuses the NewAPI provider's validation, writes secrets through Hypit's platform credential store, creates one host-level desktop Runtime Profile, and installs a managed Skill plus a stable launcher. electron-builder packages the same application for macOS arm64 and Windows x64; Hypit's npm tarball and platform FFmpeg binaries are staged as explicit resources outside ASAR.

**Tech Stack:** TypeScript 5.9.3, Node test runner + tsx, Electron 44.4.5, electron-builder 26.15.3, esbuild 0.28.2, ali-oss 6.23.0, NSIS, macOS DMG.

## Global Constraints

- macOS target is Apple Silicon only; Windows target is x64 only.
- Both installers are unsigned internal-test builds. The UI and documentation must explain Gatekeeper and SmartScreen warnings.
- Installation and setup are per-user and must not require administrator privileges.
- NewAPI address, API key, OSS endpoint, bucket, AccessKey ID, and AccessKey Secret are all required.
- Secrets must live in macOS Keychain or Windows Credential Manager; JSON, logs, diagnostics, renderer state, and errors must never contain them.
- The bundle includes Electron's Node runtime, Hypit, FFmpeg, and the Codex Skill. Chrome, WhisperX, and model weights remain on-demand downloads.
- The first release has no automatic updater and no telemetry.
- The desktop app may make network calls only for explicit connection tests; diagnostics do not submit image or video generation requests.
- The Windows executable is cross-built on macOS and must remain labeled unverified on real Windows until a Windows x64 installation test is recorded.
- Use `npm`, not `pnpm`, for the root Distribution pack scripts because `scripts/pack-distribution.mjs` intentionally checks npm's portable CLI entry.

---

## File Structure

New package `packages/desktop-setup` owns the installer without coupling desktop UI code into the CLI:

- `src/contracts.ts` — renderer/main IPC request and result types; no secret-bearing result type.
- `src/setup-core.ts` — validates input, tests connections, commits credentials and the host profile transactionally.
- `src/profile.ts` — derives the desktop Runtime Profile and canonical host profile path.
- `src/lifecycle.ts` — orchestrates Skill and launcher install/uninstall.
- `src/skill-install.ts` — managed Skill backup, atomic install, restore, and ownership marker.
- `src/launcher-install.ts` — platform launcher text, PATH registration, and removal.
- `src/main.ts` — hardened BrowserWindow and explicit IPC handlers.
- `src/preload.ts` — narrow `contextBridge` API.
- `src/renderer.ts` — Chinese wizard state and DOM behavior.
- `ui/index.html`, `ui/styles.css` — local-only setup interface.
- `scripts/build.mjs` — bundles main/preload/renderer and copies UI.
- `scripts/prepare-resources.mjs` — stages the packed Hypit Distribution, Skill, and target FFmpeg.
- `scripts/check-artifact.mjs` — inspects packaged resource architecture and required files.
- `electron-builder.yml` — arm64 DMG and x64 NSIS configuration.
- `build/entitlements.mac.plist`, `build/installer.nsh` — unsigned macOS runtime policy and per-user NSIS hooks.

Provider-side `packages/provider-newapi/src/connection-test.ts` owns the reusable, dependency-injected NewAPI/OSS test so CLI and desktop do not invent different service behavior.

---

### Task 1: Reusable NewAPI and OSS Connection Test

**Files:**
- Create: `packages/provider-newapi/src/connection-test.ts`
- Modify: `packages/provider-newapi/src/index.ts`
- Modify: `packages/provider-newapi/package.json`
- Test: `packages/provider-newapi/test/connection-test.test.ts`

**Interfaces:**
- Consumes: `NewApiSetupInput` and `completeNewApiSetup()` from `setup.ts`.
- Produces: `testNewApiSetupConnection(input, dependencies?) => Promise<NewApiConnectionTestResult>`.
- `NewApiConnectionTestResult` is `{ readonly modelCount: number; readonly relayVerified: true }` and contains no URL, object key, or secret.

- [ ] **Step 1: Write failing tests for the complete connection lifecycle**

Create table-driven tests with an injected `fetch` and `OssSetupTestClient`. Assert that success performs exactly `GET <normalizedBaseUrl>/models`, `put`, `signatureUrl`, signed `GET`, and `delete`; assert deletion is attempted after download failure; assert API keys, OSS secrets, signed URLs, and nested causes are absent from every thrown message. A cleanup failure must identify the non-secret object key so the user can remove it manually.

```ts
test("verifies models, uploads, downloads and removes one OSS probe", async () => {
  const events: string[] = [];
  const result = await testNewApiSetupConnection(validInput, {
    fetch: async (url, init) => {
      events.push(`${init?.method ?? "GET"} ${String(url).includes("Signature=") ? "signed" : "models"}`);
      return String(url).includes("Signature=")
        ? new Response(Uint8Array.of(0x48, 0x59))
        : Response.json({ data: [{ id: "seedance-2.5" }] });
    },
    createOssClient: () => ({
      put: async () => { events.push("put"); },
      signatureUrl: () => "https://signed.invalid/probe?Signature=secret",
      delete: async () => { events.push("delete"); },
    }),
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
  });
  assert.deepEqual(result, { modelCount: 1, relayVerified: true });
  assert.deepEqual(events, ["GET models", "put", "GET signed", "delete"]);
});
```

- [ ] **Step 2: Run the new test and verify it fails**

Run: `node --import tsx --test packages/provider-newapi/test/connection-test.test.ts`

Expected: FAIL because `testNewApiSetupConnection` is not exported.

- [ ] **Step 3: Implement the dependency-injected connection test**

Use a two-byte `text/plain` body, the key `relay/hypit/setup-test/<uuid>.txt`, a 60-second signed URL, and a `finally` block that deletes only after `put` succeeds. Treat non-2xx responses, non-array model data, zero models, byte mismatch, and cleanup failure as distinct stable errors. Redact all input secrets, Authorization values, signed URLs, and nested error causes before crossing the public boundary; retain only the generated object key in the cleanup-failure message.

```ts
export type NewApiConnectionTestResult = {
  readonly modelCount: number;
  readonly relayVerified: true;
};

export async function testNewApiSetupConnection(
  input: NewApiSetupInput,
  dependencies: NewApiConnectionTestDependencies = defaultDependencies,
): Promise<NewApiConnectionTestResult>;
```

- [ ] **Step 4: Run provider tests and type checking**

Run:

```bash
node --import tsx --test packages/provider-newapi/test/*.test.ts
npm run check
```

Expected: provider tests PASS and `tsc` exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/provider-newapi
git commit -m "feat(newapi): verify setup connections safely"
```

---

### Task 2: Desktop Package Skeleton and IPC Contracts

**Files:**
- Create: `packages/desktop-setup/package.json`
- Create: `packages/desktop-setup/tsconfig.json`
- Create: `packages/desktop-setup/src/contracts.ts`
- Create: `packages/desktop-setup/src/paths.ts`
- Create: `packages/desktop-setup/test/contracts.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces `SetupInput`, `SetupProgress`, `SetupResult`, `DiagnosticItem`, `DesktopPaths`, and `desktopPaths(options)`.
- `SetupResult` includes only booleans, counts, labels, and filesystem paths; it cannot represent a secret.

- [ ] **Step 1: Add the failing contract and path tests**

Test Darwin and Windows path derivation with injected `home`, `appData`, and `platform`. Required paths are `hostState`, `profile`, `skill`, `skillBackup`, `launcher`, and `managedState`. Assert that JSON serialization of every public result fixture contains none of the six submitted secret/input values.

```ts
const paths = desktopPaths({
  platform: "darwin", home: "/Users/tester",
  appData: "/Users/tester/Library/Application Support",
});
assert.equal(paths.profile, "/Users/tester/Library/Application Support/Hypit/profiles/desktop-newapi.json");
assert.equal(paths.skill, "/Users/tester/.codex/skills/hypit");
assert.equal(paths.launcher, "/Users/tester/.local/bin/hypit");
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `node --import tsx --test packages/desktop-setup/test/contracts.test.ts`

Expected: FAIL because the package and exports do not exist.

- [ ] **Step 3: Create the private workspace package and exact dependencies**

Pin `electron@44.4.5`, `electron-builder@26.15.3`, `esbuild@0.28.2`, `yaml@2.8.1`, `@ffmpeg-installer/darwin-arm64@4.1.5`, and `@ffmpeg-installer/win32-x64@4.1.0`. Add workspace dependencies on `@dramaclaw/provider-newapi`, `@hypit/credential-store-platform`, `@hypit/runtime`, and `@hypit/video-cli`, plus `ali-oss@6.23.0`.

Add root scripts:

```json
{
  "desktop:build": "pnpm --filter @hypit/desktop-setup build",
  "desktop:dist:mac": "pnpm --filter @hypit/desktop-setup dist:mac",
  "desktop:dist:win": "pnpm --filter @hypit/desktop-setup dist:win",
  "desktop:dist": "pnpm --filter @hypit/desktop-setup dist"
}
```

- [ ] **Step 4: Implement serializable contracts and deterministic paths**

Keep `SetupInput` main-process-only. Expose `submitSetup(input)` across preload, but never send it back to the renderer after submission. Define discriminated progress events without arbitrary `unknown` payloads.

- [ ] **Step 5: Install and verify**

Run:

```bash
pnpm install
node --import tsx --test packages/desktop-setup/test/contracts.test.ts
npm run check
```

Expected: lockfile updated, test PASS, type check exits 0.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml packages/desktop-setup
git commit -m "feat(desktop): establish installer package contracts"
```

---

### Task 3: Transactional Profile and Credential Setup

**Files:**
- Create: `packages/desktop-setup/src/profile.ts`
- Create: `packages/desktop-setup/src/setup-core.ts`
- Test: `packages/desktop-setup/test/profile.test.ts`
- Test: `packages/desktop-setup/test/setup-core.test.ts`

**Interfaces:**
- Produces `createDesktopProfile(config): CanonicalValue`.
- Produces `commitDesktopSetup(input, dependencies): Promise<SetupResult>`.
- Consumes `completeNewApiSetup`, `newApiDefaultBindings`, `testNewApiSetupConnection`, and a `WritableCredentialStore`.

- [ ] **Step 1: Write failing profile tests**

Assert the generated profile uses `hypit.runtime-local@1`, host-relative `dataRoot`, platform credentials, all NewAPI bindings, `newapi.personal`, `media.local`, and `hyperframes.local`. Assert that the JSON contains credential refs but no submitted secret.

```ts
assert.deepEqual(profile.credentials, {
  platform: { use: "@hypit/credential-store-platform" },
});
assert.equal(profile.endpoints["newapi.personal"].use, "@dramaclaw/provider-newapi");
assert.equal(profile.endpoints["newapi.personal"].config.apiKey.key, "newapi.personal.api-key");
```

- [ ] **Step 2: Write failing transaction tests**

Use an in-memory credential store and injected atomic writer. Cover fresh setup, replacing all three secrets, connection failure before any write, second credential write failure with rollback, profile write failure with credential rollback, and successful commit. Assert the writer receives no secret-bearing document.

- [ ] **Step 3: Run and verify failure**

Run: `node --import tsx --test packages/desktop-setup/test/profile.test.ts packages/desktop-setup/test/setup-core.test.ts`

Expected: FAIL because the implementations do not exist.

- [ ] **Step 4: Implement the profile builder and transaction**

`commitDesktopSetup` must execute in this order:

1. validate with `completeNewApiSetup`;
2. run `testNewApiSetupConnection` using the in-memory input;
3. snapshot the three existing CredentialRefs;
4. write all three new credentials;
5. atomically write the profile with mode `0o600` on POSIX;
6. roll back credentials in reverse order if any write after step 3 fails;
7. replace errors with stable Chinese stage messages plus a non-secret diagnostic code.

- [ ] **Step 5: Run focused and full NewAPI tests**

Run:

```bash
node --import tsx --test packages/desktop-setup/test/profile.test.ts packages/desktop-setup/test/setup-core.test.ts
node --import tsx --test packages/provider-newapi/test/*.test.ts packages/video-cli/test/newapi-first-run.test.ts
npm run check
```

Expected: all tests PASS and type check exits 0.

- [ ] **Step 6: Commit**

```bash
git add packages/desktop-setup/src packages/desktop-setup/test
git commit -m "feat(desktop): commit NewAPI setup transactionally"
```

---

### Task 4: Managed Skill and Launcher Lifecycle

**Files:**
- Create: `packages/desktop-setup/src/skill-install.ts`
- Create: `packages/desktop-setup/src/launcher-install.ts`
- Create: `packages/desktop-setup/src/lifecycle.ts`
- Test: `packages/desktop-setup/test/skill-install.test.ts`
- Test: `packages/desktop-setup/test/launcher-install.test.ts`
- Test: `packages/desktop-setup/test/lifecycle.test.ts`
- Modify: `skills/hypit/references/environment/distribution.md`

**Interfaces:**
- Produces `installManagedSkill(options)`, `removeManagedSkill(options)`, `installLauncher(options)`, `removeLauncher(options)`, `installDesktopIntegration(options)`, and `removeDesktopIntegration(options)`.
- Managed marker format: `hypit.desktop-managed@1` with `installedVersion`, `sourceDigest`, and optional `backupDirectory`.

- [ ] **Step 1: Write failing Skill lifecycle tests**

Use temporary homes to cover no existing Skill, managed upgrade, externally installed Skill backup, interrupted copy, uninstall restore, and path names containing spaces and Chinese characters. Verify atomic directory swaps and exact byte restoration.

- [ ] **Step 2: Write failing launcher tests**

Assert the macOS launcher uses quoted absolute paths and `ELECTRON_RUN_AS_NODE=1`; assert the Windows `.cmd` uses `%~dp0`-safe quoting and preserves `%*`. Run the macOS launcher against a fake Electron executable that records arguments; statically test Windows text without executing it.

```sh
#!/bin/sh
export ELECTRON_RUN_AS_NODE=1
exec "/Applications/Hypit Setup.app/Contents/MacOS/Hypit Setup" "/absolute/resources/runtime/node_modules/@hypit/hypit/bin/hypit.mjs" "$@"
```

- [ ] **Step 3: Run and verify failure**

Run: `node --import tsx --test packages/desktop-setup/test/skill-install.test.ts packages/desktop-setup/test/launcher-install.test.ts packages/desktop-setup/test/lifecycle.test.ts`

Expected: FAIL because lifecycle modules do not exist.

- [ ] **Step 4: Implement atomic Skill management and launchers**

Copy into sibling temporary paths, validate `SKILL.md` and the complete reference tree, then rename into place. Never delete an unmanaged Skill. On Windows update only the current-user PATH segment, preserve unrelated entries, and record whether this installer added it. On macOS create `~/.local/bin` with mode `0o700` and launcher mode `0o755`; add one idempotent, marked PATH block to `~/.zprofile`, preserve all unrelated shell text, remove only that exact block during integration uninstall, and tell the user to restart Codex/Terminal before testing command discovery.

- [ ] **Step 5: Document desktop Distribution discovery for Codex**

Update the Skill reference so an agent checks the installed launcher's `hypit paths --json`, selects the host profile at `<hostState>/profiles/desktop-newapi.json` for a new project with `hypit runtime use <profile> --workspace <project>`, and never asks the user to re-enter secrets already reported as configured.

- [ ] **Step 6: Run tests and commit**

Run:

```bash
node --import tsx --test packages/desktop-setup/test/*install.test.ts packages/desktop-setup/test/lifecycle.test.ts
npm run check
git add packages/desktop-setup skills/hypit/references/environment/distribution.md
git commit -m "feat(desktop): install managed Skill and launcher"
```

Expected: tests PASS; commit created.

---

### Task 5: Secure Electron Shell and Chinese Wizard

**Files:**
- Create: `packages/desktop-setup/src/main.ts`
- Create: `packages/desktop-setup/src/preload.ts`
- Create: `packages/desktop-setup/src/renderer.ts`
- Create: `packages/desktop-setup/ui/index.html`
- Create: `packages/desktop-setup/ui/styles.css`
- Create: `packages/desktop-setup/test/main-security.test.ts`
- Create: `packages/desktop-setup/test/renderer.test.ts`
- Create: `packages/desktop-setup/scripts/build.mjs`

**Interfaces:**
- Renderer sees only `window.hypitSetup.getStatus()`, `submit(input)`, `rerunDiagnostics()`, `openConfigDirectory()`, and `clearConfiguration()`.
- Main process owns every secret and returns only `SetupProgress`, `SetupResult`, and redacted diagnostics.

- [ ] **Step 1: Write failing BrowserWindow security tests**

Extract `browserWindowOptions(preloadPath)` and assert `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`, no remote module, no arbitrary navigation, and a local file URL only. Assert IPC channel names are a closed literal union.

- [ ] **Step 2: Write failing wizard reducer tests**

Test six required fields, password visibility toggles, disabled submit during work, resumable non-secret values, Chinese stage copy, successful completion, cleanup warning, and error retry. Assert reducer state returned to persistence excludes `apiKey`, `accessKeyId`, and `accessKeySecret`.

- [ ] **Step 3: Run and verify failure**

Run: `node --import tsx --test packages/desktop-setup/test/main-security.test.ts packages/desktop-setup/test/renderer.test.ts`

Expected: FAIL because shell and renderer do not exist.

- [ ] **Step 4: Implement the hardened main/preload boundary**

Validate every IPC argument again in the main process. Reject unexpected keys. Register `will-navigate`, `setWindowOpenHandler`, permission handlers, and CSP so remote content cannot execute. Send progress through a subscription that is removed when the renderer unsubscribes.

- [ ] **Step 5: Implement the Chinese UI**

Create four screens: 欢迎、NewAPI 与 OSS、测试与安装、完成/诊断. The completion screen must state that Chrome and WhisperX may download later and must show this exact example:

```text
请使用 $hypit，把我的参考视频改编成新版本；使用本机已配置的 NewAPI 和 OSS。
```

Do not use React. Keep renderer state deterministic and DOM rendering local so the package adds no UI framework.

- [ ] **Step 6: Bundle and test**

`build.mjs` must emit `dist/main.cjs`, `dist/preload.cjs`, `dist/renderer.js`, `dist/index.html`, and `dist/styles.css`. Run:

```bash
pnpm --filter @hypit/desktop-setup build
node --import tsx --test packages/desktop-setup/test/main-security.test.ts packages/desktop-setup/test/renderer.test.ts
npm run check
```

Expected: five output files exist, tests PASS, type check exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/desktop-setup
git commit -m "feat(desktop): add Chinese setup wizard"
```

---

### Task 6: Stage Reproducible Runtime Resources

**Files:**
- Create: `packages/desktop-setup/scripts/prepare-resources.mjs`
- Create: `packages/desktop-setup/scripts/check-artifact.mjs`
- Create: `packages/desktop-setup/test/prepare-resources.test.ts`
- Create: `packages/desktop-setup/test/check-artifact.test.ts`
- Modify: `scripts/pack-distribution.mjs`
- Modify: `.gitignore`

**Interfaces:**
- `prepare-resources.mjs --platform darwin --arch arm64 --hypit-tgz <path> --out <dir>`.
- `prepare-resources.mjs --platform win32 --arch x64 --hypit-tgz <path> --out <dir>`.
- Output contains `runtime/node_modules/@hypit/hypit`, `skill/hypit`, `bin/ffmpeg[.exe]`, and `resource-manifest.json` with SHA-256 values.

- [ ] **Step 1: Write failing resource staging tests**

Use fixture tarballs and fake FFmpeg binaries. Assert target-specific executable names, PE/Mach-O magic checks, Skill completeness, npm package version, resource manifest digests, and rejection of any file matching credential/profile/media deny patterns.

- [ ] **Step 2: Run and verify failure**

Run: `node --import tsx --test packages/desktop-setup/test/prepare-resources.test.ts packages/desktop-setup/test/check-artifact.test.ts`

Expected: FAIL because staging scripts do not exist.

- [ ] **Step 3: Implement target-specific staging**

Install the already-created Hypit tarball into an isolated staging prefix with:

```bash
npm install --prefix <stage>/runtime --omit=dev --ignore-scripts --no-audit --no-fund <hypit.tgz>
```

Copy FFmpeg from the pinned target package rather than the host package. Copy `skills/hypit` from the checkout. Write SHA-256 and byte sizes for every top-level runtime resource. Refuse `.env`, `hypit.runtime.json`, credential documents, media outputs, and files outside the allowlist.

- [ ] **Step 4: Make Distribution packing return a machine-readable path**

Preserve existing human output, and add `--json-path` so desktop scripts can receive exactly the produced `.tgz` path without guessing version or parsing npm's inventory.

- [ ] **Step 5: Run staging tests for both targets**

Run:

```bash
npm run pack:distribution -- --json-path
node --import tsx --test packages/desktop-setup/test/prepare-resources.test.ts packages/desktop-setup/test/check-artifact.test.ts
npm run check
```

Expected: tests PASS and type check exits 0.

- [ ] **Step 6: Commit**

```bash
git add .gitignore scripts/pack-distribution.mjs packages/desktop-setup
git commit -m "build(desktop): stage target runtime resources"
```

---

### Task 7: DMG and NSIS Packaging

**Files:**
- Create: `packages/desktop-setup/electron-builder.yml`
- Create: `packages/desktop-setup/build/entitlements.mac.plist`
- Create: `packages/desktop-setup/build/installer.nsh`
- Create: `packages/desktop-setup/scripts/checksums.mjs`
- Create: `packages/desktop-setup/scripts/package.mjs`
- Modify: `packages/desktop-setup/package.json`
- Test: `packages/desktop-setup/test/builder-config.test.ts`

**Interfaces:**
- Produces `release/Hypit-Setup-0.1.0-arm64.dmg` and `release/Hypit-Setup-0.1.0-x64.exe`.
- Produces adjacent `.sha256` files in `<hex>  <filename>` format.

- [ ] **Step 1: Write failing builder configuration tests**

Parse the YAML and assert `asar: true`, runtime resources are outside ASAR, mac target is DMG arm64, Windows target is NSIS x64, `oneClick: true`, `perMachine: false`, `allowElevation: false`, signing discovery is disabled, and app launch after install is enabled.

- [ ] **Step 2: Run and verify failure**

Run: `node --import tsx --test packages/desktop-setup/test/builder-config.test.ts`

Expected: FAIL because builder configuration does not exist.

- [ ] **Step 3: Implement builder configuration and scripts**

Set product name `Hypit Setup`, app id `ai.hypit.setup`, artifact names exactly as specified, and `extraResources` to the target staging directory. NSIS must install per user. Do not request UAC. Disable signing and notarization in these internal builds.

Add scripts:

```json
{
  "dist:mac": "node scripts/package.mjs darwin arm64",
  "dist:win": "node scripts/package.mjs win32 x64",
  "dist": "npm run dist:mac && npm run dist:win"
}
```

`package.mjs` must pack Hypit through npm, prepare target resources, run electron-builder for one target, inspect the artifact, and write its SHA-256. The Windows command must fail early with a Chinese actionable message if the local cross-build prerequisites required by electron-builder are absent.

- [ ] **Step 4: Build and inspect the DMG**

Run: `npm run desktop:dist:mac`

Expected: `packages/desktop-setup/release/Hypit-Setup-0.1.0-arm64.dmg` and checksum exist; `hdiutil attach` shows `Hypit Setup.app`; `file` reports arm64 for its executable; resource inspection passes.

- [ ] **Step 5: Cross-build and inspect the EXE**

Run: `npm run desktop:dist:win`

Expected: `packages/desktop-setup/release/Hypit-Setup-0.1.0-x64.exe` and checksum exist; archive inspection finds the x64 Windows Electron executable, `ffmpeg.exe`, Hypit package, and Skill. If Wine is available, run the non-installing executable/version smoke supported by the generated artifact; never record this as a real Windows installation test.

- [ ] **Step 6: Run config tests and commit**

Run:

```bash
node --import tsx --test packages/desktop-setup/test/builder-config.test.ts packages/desktop-setup/test/check-artifact.test.ts
git add packages/desktop-setup package.json pnpm-lock.yaml
git commit -m "build(desktop): package DMG and Windows installer"
```

Expected: tests PASS; commit created. Do not commit generated installers.

---

### Task 8: Uninstall, Clear Configuration, and Diagnostics

**Files:**
- Create: `packages/desktop-setup/src/diagnostics.ts`
- Create: `packages/desktop-setup/src/clear-configuration.ts`
- Test: `packages/desktop-setup/test/diagnostics.test.ts`
- Test: `packages/desktop-setup/test/clear-configuration.test.ts`
- Modify: `packages/desktop-setup/src/main.ts`
- Modify: `packages/desktop-setup/src/renderer.ts`
- Modify: `packages/desktop-setup/ui/index.html`
- Modify: `packages/desktop-setup/build/installer.nsh`

**Interfaces:**
- Produces `runDiagnostics(options): Promise<readonly DiagnosticItem[]>`.
- Produces `clearDesktopConfiguration(options): Promise<ClearResult>` and accepts an explicit confirmation token generated for the current UI session.
- Consumes `removeDesktopIntegration(options)` for the separate, non-credential “卸载本机集成” action and the Windows uninstaller hook.

- [ ] **Step 1: Write failing diagnostic and clear tests**

Cover installed/missing/corrupt resources, CLI version, FFmpeg invocation, Skill marker, profile parse, credential slot status, and network tests. Assert ordinary diagnostics do not generate media. For clear, assert wrong or expired confirmation refuses all writes; successful clear removes only desktop profile and three platform credentials, not projects. For integration uninstall, assert the managed launcher, PATH entry, and managed Skill are removed, an external Skill backup is restored, and the profile/credentials/projects remain untouched.

- [ ] **Step 2: Run and verify failure**

Run: `node --import tsx --test packages/desktop-setup/test/diagnostics.test.ts packages/desktop-setup/test/clear-configuration.test.ts`

Expected: FAIL because diagnostics and clear functions do not exist.

- [ ] **Step 3: Implement bounded diagnostics and destructive confirmation**

Run subprocesses with explicit executable paths, sanitized environment, 30-second bounds, and captured output redaction. `clearDesktopConfiguration` lists exact targets before issuing the one-time token, deletes only after matching confirmation, and reports whether each credential/profile was present. Add a separate confirmed “卸载本机集成” action for macOS users to run before moving the app to Trash. Wire the NSIS uninstaller to the same packaged cleanup entrypoint before removing application files; if cleanup cannot run, keep the user data and report the integration paths that may require manual removal.

- [ ] **Step 4: Add UI actions and rerun tests**

Run:

```bash
node --import tsx --test packages/desktop-setup/test/diagnostics.test.ts packages/desktop-setup/test/clear-configuration.test.ts packages/desktop-setup/test/renderer.test.ts
npm run check
```

Expected: tests PASS and type check exits 0.

- [ ] **Step 5: Commit**

```bash
git add packages/desktop-setup
git commit -m "feat(desktop): add diagnostics and safe cleanup"
```

---

### Task 9: Documentation and Full Acceptance

**Files:**
- Create: `docs/zh/guide/desktop-installer.md`
- Create: `packages/desktop-setup/TEST-REPORT.md`
- Modify: `README.zh-CN.md`
- Modify: `docs/zh/guide/runtime.md`
- Modify: `packages/desktop-setup/README.md`

**Interfaces:**
- Documents exact artifact paths, unsigned warnings, setup fields, later downloads, update/uninstall behavior, checksum verification, and Windows verification status.

- [ ] **Step 1: Write the Chinese installation and troubleshooting guide**

Include macOS right-click-open instructions, Windows SmartScreen “更多信息/仍要运行”, all six configuration fields, the no-generation connection test, project profile selection behavior, later Chrome/WhisperX downloads, manual reinstall updates, default uninstall preservation, and complete credential clearing.

- [ ] **Step 2: Run the focused installer suite**

Run:

```bash
node --import tsx --test packages/desktop-setup/test/*.test.ts packages/provider-newapi/test/*.test.ts packages/video-cli/test/newapi-first-run.test.ts
npm run check
```

Expected: all tests PASS and type check exits 0.

- [ ] **Step 3: Run the complete repository suite**

Run: `npm test`

Expected: 0 failures. Environment-dependent browser tests may skip only with their existing explicit reason.

- [ ] **Step 4: Revalidate the npm Distribution**

Run:

```bash
npm run pack:distribution
npm run check:distribution -- ./dist/release/hypit-hypit-0.2.16.tgz
```

Expected: fresh install, component build, font, render, export, ffprobe, and decode all pass.

- [ ] **Step 5: Perform macOS installation acceptance**

Mount the DMG, copy the app to the current user's Applications directory, launch it, complete NewAPI/OSS testing with the user's test configuration, verify Keychain entries without printing them, check `~/.local/bin/hypit --version`, verify the managed Skill, run `doctor`, start/stop Runtime, and run an existing `plan`. Do not execute a paid generation until the user separately approves its expected cost.

- [ ] **Step 6: Record Windows cross-build limits honestly**

Update `TEST-REPORT.md` with every static/unpack/Wine command and result. The report must contain this status until a real machine test exists:

```text
Windows x64：已在 macOS 交叉构建并完成静态与解包检查；尚未在真实 Windows x64 机器完成安装、凭据管理和卸载验证。
```

- [ ] **Step 7: Verify artifacts and checksums**

Run:

```bash
shasum -a 256 -c packages/desktop-setup/release/Hypit-Setup-0.1.0-arm64.dmg.sha256
shasum -a 256 -c packages/desktop-setup/release/Hypit-Setup-0.1.0-x64.exe.sha256
```

Expected: both report `OK`.

- [ ] **Step 8: Commit documentation and test report**

```bash
git add README.zh-CN.md docs/zh packages/desktop-setup/README.md packages/desktop-setup/TEST-REPORT.md
git commit -m "docs(desktop): document installer acceptance"
```

---

## Final Review Gate

Before calling the installer complete:

1. Confirm `git status --short` contains no secret, Runtime Profile, generated media, mounted-volume path, installer, or unpacked application.
2. Inspect `git diff main...HEAD` for secrets with the existing repository secret scanner.
3. Run `npm run check`, the focused desktop/provider tests, `npm test`, and the npm Distribution check from fresh outputs.
4. Mount and inspect the exact DMG being delivered, not only the unpacked development app.
5. Recompute SHA-256 after the final build and verify both checksum files.
6. State that the Windows artifact is cross-built and lacks real Windows installation verification.
7. Do not merge, publish a release, or upload installers until the user separately chooses that integration step.
