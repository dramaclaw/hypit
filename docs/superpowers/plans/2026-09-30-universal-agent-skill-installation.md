# Universal Agent Skill Installation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Hypit Setup install, migrate, diagnose, refresh, and remove Hypit's Skill for any supported combination of Codex, Claymore Piko, Cursor, and Claude Code without duplicating runtime credentials or project configuration.

**Architecture:** Keep one portable managed Skill at `~/.agents/skills/hypit` for Agent Skills-compatible hosts, and add a managed Claude compatibility copy only when Claude Code is detected. Represent every installed copy as an `AgentSkillTarget`, run target changes through the existing prepare/commit/rollback/dispose transaction pattern, and migrate only the legacy `.codex/skills/hypit` tree carrying a valid v1 desktop marker.

**Tech Stack:** TypeScript 5.9, Node.js `node:test`, Electron 44, electron-builder 26, Node filesystem/path APIs, linkedom renderer tests, pnpm workspace.

## Global Constraints

- Do not add a background watcher, auto-updater, cloud/SSH synchronization, or Agent settings-file edits.
- Always install the portable target, even when no Agent is detected.
- Install the Claude compatibility target only when Claude Code is detected or when a previously managed Claude target still exists.
- A scan may add targets but must never automatically delete a target merely because its Agent is no longer detected.
- NewAPI credentials, OSS credentials, the Runtime Profile, FFmpeg, the Distribution, and the launcher remain one shared host installation.
- Never overwrite or delete an unmanaged Skill without first preserving a complete backup.
- Never treat a v1 marker as ownership outside the exact legacy Codex path and exact legacy backup path.
- Every outbound IPC object remains allowlisted and must contain none of the six submitted setup values.
- Windows packaging remains cross-built and must not be described as real Windows installation verification.
- Before feature work, merge current `origin/main`; retain both desktop connection testing and main's IndexTTS2 plus URL-secret rejection behavior.

---

## File Map

- Create `packages/desktop-setup/src/agent-targets.ts`: Agent IDs, probe results, active target selection, public target summaries.
- Create `packages/desktop-setup/test/agent-targets.test.ts`: deterministic macOS/Windows detection and target selection.
- Modify `packages/desktop-setup/src/paths.ts`: portable, Claude, legacy Codex, and per-target backup paths.
- Modify `packages/desktop-setup/src/contracts.ts`: Agent-neutral diagnostics and `skillTargets` result contract.
- Modify `packages/desktop-setup/src/skill-install.ts`: v2 target-aware markers and reusable single-target transactions.
- Modify `packages/desktop-setup/src/lifecycle.ts`: multi-target integration transaction and legacy migration.
- Modify `packages/desktop-setup/src/setup-core.ts`: return target summaries instead of one Codex path.
- Modify `packages/desktop-setup/src/diagnostics.ts`: one diagnostic per active/retained target and duplicate legacy warnings.
- Modify `packages/desktop-setup/src/main.ts`: scan orchestration, refresh service, confirmation targets, result projection.
- Modify `packages/desktop-setup/src/ipc.ts` and `src/preload.ts`: no-secret `refreshAgentIntegration()` bridge.
- Modify `packages/desktop-setup/src/renderer.ts`: Agent-neutral copy, detected-Agent list, refresh action.
- Modify `packages/desktop-setup/src/launcher-install.ts`: Agent-neutral restart message.
- Modify `packages/desktop-setup/build/installer.nsh` and `src/cleanup-entry.ts`: universal and compatibility paths in recovery guidance.
- Modify `skills/hypit/references/environment/distribution.md`: portable Skill and absolute-launcher discovery.
- Modify affected tests under `packages/desktop-setup/test/` alongside each production change.

---

### Task 1: Merge the NewAPI Provider branch into the desktop baseline

**Files:**
- Resolve: `packages/provider-newapi/README.md`
- Resolve: `packages/provider-newapi/package.json`
- Resolve: `packages/provider-newapi/src/base-url.ts`
- Resolve: `packages/provider-newapi/src/provider.ts`
- Resolve: `packages/provider-newapi/src/setup.ts`
- Resolve: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `origin/main` at or after merge commit `3289a3f6`.
- Produces: one desktop branch baseline containing connection probes, IndexTTS2, and `normalizeNewApiBaseUrl()` security validation.

- [ ] **Step 1: Fetch and start a non-rewriting merge**

```bash
git fetch origin main
git merge --no-ff origin/main
```

Expected: merge stops on the known provider and lockfile conflicts; do not rebase or force-push this long-lived desktop branch.

- [ ] **Step 2: Resolve `base-url.ts` with the union of both branches**

Use this exact behavior in `packages/provider-newapi/src/base-url.ts`:

```ts
const loopbackHosts = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

export function normalizeNewApiBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); }
  catch { throw new Error("DramaClaw NewAPI baseUrl must be a valid HTTPS or loopback HTTP URL"); }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopbackHosts.has(url.hostname))) {
    throw new Error("DramaClaw NewAPI baseUrl must use HTTPS or loopback HTTP");
  }
  if (url.username || url.password) throw new Error("DramaClaw NewAPI baseUrl must not contain credentials");
  if (url.search || url.hash) throw new Error("DramaClaw NewAPI baseUrl must not contain a query or fragment");
  url.pathname = url.pathname.replace(/\/+$/u, "") || "/v1";
  return url.toString();
}
```

This preserves the desktop connection probe's default `/v1` behavior while retaining the merged PR's credential, query, and fragment rejection.

- [ ] **Step 3: Resolve the remaining provider files by retaining the feature union**

Keep all of the following in the resolved tree:

```text
README model table: 4 image + 5 video + index-tts-2 speech
package devDependencies: @hypit/mimo-speech
provider: connection-test support + immediate audio response handling
setup: shared normalizeNewApiBaseUrl validation
lockfile: desktop dependencies + @hypit/mimo-speech link
```

Generate the lockfile from manifests instead of manually editing YAML:

```bash
pnpm install --lockfile-only
git add packages/provider-newapi pnpm-lock.yaml
git commit
```

Expected: the merge commit completes with no conflict markers.

- [ ] **Step 4: Verify the merged baseline before universal-Agent work**

```bash
rg -n '<<<<<<<|=======|>>>>>>>' packages/provider-newapi pnpm-lock.yaml
pnpm exec tsx --test packages/provider-newapi/test/*.test.ts packages/video-cli/test/newapi-first-run.test.ts packages/desktop-setup/test/*.test.ts
pnpm check
```

Expected: `rg` returns no matches; all selected tests pass; TypeScript exits 0.

---

### Task 2: Define Agent detection, target selection, paths, and public contracts

**Files:**
- Create: `packages/desktop-setup/src/agent-targets.ts`
- Create: `packages/desktop-setup/test/agent-targets.test.ts`
- Modify: `packages/desktop-setup/src/paths.ts`
- Modify: `packages/desktop-setup/src/contracts.ts`
- Modify: `packages/desktop-setup/test/contracts.test.ts`

**Interfaces:**
- Produces: `DetectedAgentId`, `AgentSkillTargetId`, `AgentScanResult`, `AgentSkillTarget`, `scanAgentTargets()`, `targetSummary()`.
- Produces: `DesktopPaths.portableSkill`, `claudeSkill`, `legacyCodexSkill`, and exact backup peers.
- Later tasks consume these names without redefining them.

- [ ] **Step 1: Write failing path and detection tests**

Add tests with injected existence checks:

```ts
test("no detected Agent still selects the portable target", async () => {
  const paths = desktopPaths({ platform: "darwin", home: "/Users/tester", appData: "/Users/tester/Library/Application Support" });
  const scan = await scanAgentTargets({ paths, exists: async () => false });
  assert.deepEqual(scan.detectedAgents, []);
  assert.deepEqual(scan.targets.map((target) => target.id), ["portable"]);
});

test("Codex, Piko and Cursor share portable while Claude adds one compatibility target", async () => {
  const paths = desktopPaths({ platform: "darwin", home: "/Users/tester", appData: "/Users/tester/Library/Application Support" });
  const present = new Set(Object.values(paths.agentProbePaths).map((paths) => paths[0]!));
  const scan = await scanAgentTargets({ paths, exists: async (path) => present.has(path) });
  assert.deepEqual(scan.detectedAgents, ["codex", "claymore-piko", "cursor", "claude-code"]);
  assert.deepEqual(scan.targets.map((target) => target.id), ["portable", "claude"]);
});
```

Update contract expectations to assert:

```ts
assert.equal(paths.portableSkill, "/Users/tester/.agents/skills/hypit");
assert.equal(paths.claudeSkill, "/Users/tester/.claude/skills/hypit");
assert.equal(paths.legacyCodexSkill, "/Users/tester/.codex/skills/hypit");
assert.equal(paths.portableSkillBackup.endsWith("skill-backup/portable/hypit"), true);
assert.equal(paths.claudeSkillBackup.endsWith("skill-backup/claude/hypit"), true);
```

- [ ] **Step 2: Run the tests and verify RED**

```bash
pnpm exec tsx --test packages/desktop-setup/test/contracts.test.ts packages/desktop-setup/test/agent-targets.test.ts
```

Expected: FAIL because the new paths, types, and scanner do not exist.

- [ ] **Step 3: Implement exact path and target types**

Replace the single `skill`/`skillBackup` pair with:

```ts
export type DesktopPaths = {
  readonly hostState: string;
  readonly profile: string;
  readonly portableSkill: string;
  readonly portableSkillBackup: string;
  readonly claudeSkill: string;
  readonly claudeSkillBackup: string;
  readonly legacyCodexSkill: string;
  readonly legacyCodexSkillBackup: string;
  readonly launcher: string;
  readonly managedState: string;
  readonly agentProbePaths: Readonly<Record<DetectedAgentId, readonly string[]>>;
};
```

Add optional `agentData` to `DesktopPathOptions`; it defaults to `appData` in unit tests, while Electron passes `app.getPath("appData")` so Windows probes use roaming application data instead of Hypit's Local AppData root. Build each `agentProbePaths` value from exact, read-only candidates:

```ts
export type DesktopPathOptions = {
  readonly platform: "darwin" | "win32";
  readonly home: string;
  readonly appData: string;
  readonly agentData?: string;
};
```

```text
Codex: ~/.codex, /Applications/Codex.app, ~/Applications/Codex.app, or %LOCALAPPDATA%\Programs\Codex\Codex.exe
Claymore Piko: <agentData>/Claymore Piko, /Applications/Claymore Piko.app, ~/Applications/Claymore Piko.app, or %LOCALAPPDATA%\Programs\Claymore Piko\Claymore Piko.exe
Cursor: ~/.cursor, /Applications/Cursor.app, ~/Applications/Cursor.app, or %LOCALAPPDATA%\Programs\cursor\Cursor.exe
Claude Code: ~/.claude, /Applications/Claude.app, ~/Applications/Claude.app, or %LOCALAPPDATA%\Programs\Claude\Claude.exe
```

Define the scanner in `agent-targets.ts`:

```ts
import { lstat } from "node:fs/promises";
import type { DesktopPaths } from "./paths.js";

export type DetectedAgentId = "codex" | "claymore-piko" | "cursor" | "claude-code";
export type AgentSkillTargetId = "portable" | "claude";
export type AgentScanResult = {
  readonly detectedAgents: readonly DetectedAgentId[];
  readonly targets: readonly AgentSkillTarget[];
};
export type AgentSkillTarget = {
  readonly id: AgentSkillTargetId;
  readonly label: "通用 Agent Skill" | "Claude Code Skill";
  readonly skillDirectory: string;
  readonly backupDirectory: string;
  readonly required: boolean;
  readonly detectedAgents: readonly DetectedAgentId[];
};

const pathExists = async (path: string): Promise<boolean> => {
  try { await lstat(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
};

export const targetSummary = (target: AgentSkillTarget) => ({
  id: target.id, label: target.label, path: target.skillDirectory, detectedAgents: [...target.detectedAgents],
});

export async function scanAgentTargets(options: {
  readonly paths: DesktopPaths;
  readonly exists?: (path: string) => Promise<boolean>;
}): Promise<AgentScanResult> {
  const has = options.exists ?? pathExists;
  const detectedAgents = (await Promise.all((Object.keys(options.paths.agentProbePaths) as DetectedAgentId[])
    .map(async (id) => [id, (await Promise.all(options.paths.agentProbePaths[id].map(has))).some(Boolean)] as const)))
    .filter(([, present]) => present).map(([id]) => id);
  const portableAgents = detectedAgents.filter((id) => id !== "claude-code");
  const targets: AgentSkillTarget[] = [{ id: "portable", label: "通用 Agent Skill",
    skillDirectory: options.paths.portableSkill, backupDirectory: options.paths.portableSkillBackup,
    required: true, detectedAgents: portableAgents }];
  if (detectedAgents.includes("claude-code")) {
    targets.push({ id: "claude", label: "Claude Code Skill", skillDirectory: options.paths.claudeSkill,
      backupDirectory: options.paths.claudeSkillBackup, required: false, detectedAgents: ["claude-code"] });
  }
  return { detectedAgents, targets };
}
```

The lifecycle/status layer later unions the scan with any still-valid managed compatibility target. Detection itself never claims ownership from path existence alone.

- [ ] **Step 4: Replace the public single Skill path contract**

In `contracts.ts`, define:

```ts
export type AgentSkillTargetSummary = {
  readonly id: AgentSkillTargetId;
  readonly label: "通用 Agent Skill" | "Claude Code Skill";
  readonly path: string;
  readonly detectedAgents: readonly DetectedAgentId[];
};

export type SetupResult = {
  readonly configured: boolean;
  readonly modelCount: number;
  readonly relayVerified: boolean;
  readonly profilePath: string;
  readonly skillTargets: readonly AgentSkillTargetSummary[];
  readonly launcherPath: string;
  readonly diagnostics: readonly DiagnosticItem[];
};
```

Change `DiagnosticLabel` from `"Codex Skill"` to `"Agent Skill" | "通用 Agent Skill" | "Claude Code Skill"`, and add optional `target?: AgentSkillTargetId` to `DiagnosticItem`.

- [ ] **Step 5: Run focused tests and commit**

```bash
pnpm exec tsx --test packages/desktop-setup/test/contracts.test.ts packages/desktop-setup/test/agent-targets.test.ts
pnpm check
git add packages/desktop-setup/src/paths.ts packages/desktop-setup/src/contracts.ts packages/desktop-setup/src/agent-targets.ts packages/desktop-setup/test/contracts.test.ts packages/desktop-setup/test/agent-targets.test.ts
git commit -m "feat(desktop): discover universal Agent Skill targets"
```

Expected: focused tests and TypeScript pass.

---

### Task 3: Make one Skill transaction target-aware and marker-v2 safe

**Files:**
- Modify: `packages/desktop-setup/src/skill-install.ts`
- Modify: `packages/desktop-setup/test/skill-install.test.ts`

**Interfaces:**
- Consumes: `AgentSkillTarget` from Task 2.
- Produces: `prepareSkillInstall()`, `isManagedSkillInstalled(target, current?)`, `canRefreshManagedSkill(target)`, and existing `PreparedRemoval` for one target.
- Produces: v2 marker validation; v1 is rejected by ordinary target functions.

- [ ] **Step 1: Write failing v2 ownership tests**

Cover exact target identity and backup location:

```ts
test("a v2 marker is owned only by its exact target", async (t) => {
  const f = await fixture(t);
  await installManagedSkill({ target: f.portable, sourceDirectory: f.sourceDirectory, installedVersion: "1" });
  assert.equal(await isManagedSkillInstalled(f.portable), true);
  assert.equal(await isManagedSkillInstalled({ ...f.portable, id: "claude" }), false);
});

test("unmanaged content is backed up independently for each target", async (t) => {
  const f = await fixture(t);
  for (const target of [f.portable, f.claude]) {
    await mkdir(target.skillDirectory, { recursive: true });
    await writeFile(join(target.skillDirectory, "SKILL.md"), target.id);
    await installManagedSkill({ target, sourceDirectory: f.sourceDirectory, installedVersion: "1" });
    assert.equal(await readFile(join(target.backupDirectory, "SKILL.md"), "utf8"), target.id);
  }
});
```

Also add tests rejecting a v2 marker whose target or backup path is changed, and treating a v1 marker as unmanaged in a new target.

- [ ] **Step 2: Run the tests and verify RED**

```bash
pnpm exec tsx --test packages/desktop-setup/test/skill-install.test.ts
```

Expected: FAIL because APIs still accept `DesktopPaths` and emit v1 markers.

- [ ] **Step 3: Implement marker v2 and target-scoped helpers**

Use these public shapes:

```ts
export type ManagedSkillMarker = {
  readonly format: "hypit.desktop-managed@2";
  readonly target: AgentSkillTargetId;
  readonly installedVersion: string;
  readonly sourceDigest: string;
  readonly backupDirectory?: string;
};

export type SkillInstallOptions = {
  readonly target: AgentSkillTarget;
  readonly sourceDirectory: string;
  readonly installedVersion: string;
  readonly preserveExisting?: boolean;
  readonly copyDirectory?: (source: string, destination: string) => Promise<void>;
};
```

`markerAt(target)` must return a marker only when:

```ts
marker.format === "hypit.desktop-managed@2"
  && marker.target === target.id
  && typeof marker.installedVersion === "string"
  && /^[a-f0-9]{64}$/u.test(marker.sourceDigest)
  && (marker.backupDirectory === undefined || marker.backupDirectory === target.backupDirectory)
```

Replace every `paths.skill` and `paths.skillBackup` operation with `target.skillDirectory` and `target.backupDirectory`. Keep the existing staging, byte-digest verification, symlink refusal, rollback, and cleanup semantics unchanged.

- [ ] **Step 4: Split preparation from immediate commit**

Add:

```ts
export type PreparedSkillInstall = PreparedRemoval & {
  readonly marker: ManagedSkillMarker;
};

export async function prepareSkillInstall(options: SkillInstallOptions): Promise<PreparedSkillInstall>;
```

Preparation performs source validation, staging and backup staging without replacing the live Skill. `commit()` renames the previous tree and stage into place. `rollback()` restores the previous tree and removes a newly committed tree. `dispose(committed)` deletes obsolete temporary/previous trees only after the outer transaction decides its result.

Keep `installManagedSkill()` as a small wrapper that calls prepare, commit, rollback, and dispose so focused unit tests and existing callers remain simple.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec tsx --test packages/desktop-setup/test/skill-install.test.ts
pnpm check
git add packages/desktop-setup/src/skill-install.ts packages/desktop-setup/test/skill-install.test.ts
git commit -m "refactor(desktop): transact Agent Skill targets independently"
```

Expected: all Skill installer tests pass with marker v2.

---

### Task 4: Install multiple targets and migrate the legacy Codex tree atomically

**Files:**
- Modify: `packages/desktop-setup/src/skill-install.ts`
- Modify: `packages/desktop-setup/src/lifecycle.ts`
- Modify: `packages/desktop-setup/test/lifecycle.test.ts`
- Modify: `packages/desktop-setup/test/integration-refresh-media.test.ts`
- Modify: `packages/desktop-setup/test/uninstall.test.ts`

**Interfaces:**
- Consumes: Task 3 target transactions.
- Produces: `prepareLegacyCodexMigration()`, and target-array `DesktopIntegrationOptions`.
- Produces: a single transaction covering launcher, active Skill targets, and optional legacy restoration.

- [ ] **Step 1: Write failing migration and rollback tests**

Add cases for:

```ts
test("v1 Codex install migrates after portable commit", async (t) => {
  const f = await fixture(t);
  await seedLegacyManagedSkill(f, { backup: "user Codex Skill" });
  await installDesktopIntegration({ ...f.integration, targets: [f.portable] });
  assert.equal(await readFile(join(f.portable.skillDirectory, "SKILL.md"), "utf8"), "# Hypit\n");
  assert.equal(await readFile(join(f.paths.legacyCodexSkill, "SKILL.md"), "utf8"), "user Codex Skill");
});

test("a later target commit failure restores every target and legacy tree", async (t) => {
  const f = await fixture(t);
  await seedLegacyManagedSkill(f);
  await assert.rejects(installDesktopIntegration({ ...f.integration, targets: [f.portable, f.claude],
    copyDirectory: failForTarget("claude") }), /INTEGRATION_INSTALL_FAILED/u);
  await assert.rejects(readFile(join(f.portable.skillDirectory, "SKILL.md")), { code: "ENOENT" });
  assert.equal(await isLegacyManaged(f.paths), true);
});
```

Also test that an unmanaged legacy `.codex` tree is untouched and that rescanning with only `portable` never removes an already managed Claude target.

- [ ] **Step 2: Run lifecycle tests and verify RED**

```bash
pnpm exec tsx --test packages/desktop-setup/test/lifecycle.test.ts packages/desktop-setup/test/integration-refresh-media.test.ts packages/desktop-setup/test/uninstall.test.ts
```

Expected: FAIL because lifecycle still handles one Skill path and no migration.

- [ ] **Step 3: Add narrowly scoped v1 parsing**

Implement a private legacy marker parser that receives no general Agent target and is callable only with exact legacy paths:

```ts
type LegacyCodexPaths = {
  readonly skillDirectory: string;
  readonly backupDirectory: string;
};

const legacyCodexPaths = (paths: DesktopPaths): LegacyCodexPaths => ({
  skillDirectory: paths.legacyCodexSkill,
  backupDirectory: paths.legacyCodexSkillBackup,
});
```

The legacy parser accepts only `format === "hypit.desktop-managed@1"`, a valid digest/version, and a backup path equal to `paths.legacyCodexSkillBackup`. It prepares removal/restoration using the existing rename transaction but never writes a v1 marker.

- [ ] **Step 4: Generalize the outer integration transaction**

Change the options and transaction order:

```ts
export type DesktopIntegrationOptions = LauncherOptions & {
  readonly targets: readonly AgentSkillTarget[];
  readonly sourceDirectory: string;
  readonly installedVersion: string;
  readonly preserveExisting?: boolean;
  readonly copyDirectory?: SkillInstallOptions["copyDirectory"];
};
```

`installDesktopIntegration()` must:

```text
1. snapshot launcher files/PATH
2. prepare every target in deterministic target-id order
3. prepare legacy migration only if the exact valid v1 tree exists
4. install launcher
5. commit prepared target installs in order
6. commit legacy removal/restoration last
7. on failure, rollback legacy, targets in reverse order, launcher/PATH
8. dispose all prepared operations with the final committed flag
```

`removeDesktopIntegration()` must enumerate all managed portable/Claude targets whether currently detected or not, then remove them in one transaction and restore their independent backups.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec tsx --test packages/desktop-setup/test/skill-install.test.ts packages/desktop-setup/test/lifecycle.test.ts packages/desktop-setup/test/integration-refresh-media.test.ts packages/desktop-setup/test/uninstall.test.ts
pnpm check
git add packages/desktop-setup/src/skill-install.ts packages/desktop-setup/src/lifecycle.ts packages/desktop-setup/test/skill-install.test.ts packages/desktop-setup/test/lifecycle.test.ts packages/desktop-setup/test/integration-refresh-media.test.ts packages/desktop-setup/test/uninstall.test.ts
git commit -m "feat(desktop): migrate and transact Agent Skill targets"
```

Expected: multi-target, migration, refresh, and uninstall tests pass.

---

### Task 5: Project multi-target status and diagnostics without exposing Agent data

**Files:**
- Modify: `packages/desktop-setup/src/setup-core.ts`
- Modify: `packages/desktop-setup/src/diagnostics.ts`
- Modify: `packages/desktop-setup/src/main.ts`
- Modify: `packages/desktop-setup/test/setup-core.test.ts`
- Modify: `packages/desktop-setup/test/diagnostics.test.ts`
- Modify: `packages/desktop-setup/test/status.test.ts`
- Modify: `packages/desktop-setup/test/main-security.test.ts`

**Interfaces:**
- Consumes: `scanAgentTargets()` and target-aware ownership checks.
- Produces: `readDesktopStatus(options, scan)` and one allowlisted diagnostic per expected target.
- Preserves: configuration readiness means profile + media + launcher + every active/retained managed target.

- [ ] **Step 1: Write failing status and diagnostic tests**

Add assertions for:

```ts
assert.deepEqual(result.skillTargets.map((target) => target.id), ["portable", "claude"]);
assert.deepEqual(result.diagnostics.filter((item) => item.code === "skill").map((item) => item.target), ["portable", "claude"]);
assert.equal(JSON.stringify(result).includes("SECRET"), false);
```

Add an unmanaged legacy test expecting a warning diagnostic with `target: "portable"` but no file deletion. Add an absolute launcher test that executes the bundled CLI entry with the diagnostic environment even when the caller's PATH omits `~/.local/bin`.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
pnpm exec tsx --test packages/desktop-setup/test/setup-core.test.ts packages/desktop-setup/test/diagnostics.test.ts packages/desktop-setup/test/status.test.ts packages/desktop-setup/test/main-security.test.ts
```

Expected: FAIL on `skillTargets`, dynamic labels, and multiple Skill diagnostics.

- [ ] **Step 3: Return summaries from setup and status**

Pass selected targets into `DesktopSetupDependencies` and replace `skillPath` with:

```ts
skillTargets: dependencies.targets.map(targetSummary)
```

In `readDesktopStatus()`, scan targets, append any still-managed compatibility target, and calculate:

```ts
const targetStates = await Promise.all(targets.map(async (target) => ({
  target,
  installed: await isManagedSkillInstalled(target, currentSource),
})));
const skillsReady = targetStates.every(({ installed }) => installed);
```

Create one diagnostic per target using its fixed label, path, target ID, and pass/fail status. Add a warning only when the old Codex path exists without a valid legacy marker.

- [ ] **Step 4: Make IPC projection target-aware**

Replace the fixed single Skill label map with code-specific validation plus a Skill target label map:

```ts
const skillLabels = { portable: "通用 Agent Skill", claude: "Claude Code Skill" } as const;
```

`publicDiagnostic()` must accept `code === "skill"` only when `target` is `portable` or `claude` and the label matches `skillLabels[target]`. `publicResult()` must rebuild every target summary from exact allowlisted fields (`id`, `label`, `path`, `detectedAgents`) and drop arbitrary properties.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec tsx --test packages/desktop-setup/test/setup-core.test.ts packages/desktop-setup/test/diagnostics.test.ts packages/desktop-setup/test/status.test.ts packages/desktop-setup/test/main-security.test.ts
pnpm check
git add packages/desktop-setup/src/setup-core.ts packages/desktop-setup/src/diagnostics.ts packages/desktop-setup/src/main.ts packages/desktop-setup/test/setup-core.test.ts packages/desktop-setup/test/diagnostics.test.ts packages/desktop-setup/test/status.test.ts packages/desktop-setup/test/main-security.test.ts
git commit -m "feat(desktop): diagnose every Agent Skill target"
```

Expected: status, diagnostics, security tests, and TypeScript pass.

---

### Task 6: Add explicit Agent rescan IPC and Agent-neutral UI

**Files:**
- Modify: `packages/desktop-setup/src/ipc.ts`
- Modify: `packages/desktop-setup/src/preload.ts`
- Modify: `packages/desktop-setup/src/main.ts`
- Modify: `packages/desktop-setup/src/renderer.ts`
- Modify: `packages/desktop-setup/src/launcher-install.ts`
- Modify: `packages/desktop-setup/test/main-security.test.ts`
- Modify: `packages/desktop-setup/test/renderer.test.ts`
- Modify: `packages/desktop-setup/test/launcher-install.test.ts`

**Interfaces:**
- Produces: IPC channel `setup:refresh-agents` and bridge method `refreshAgentIntegration()` with no arguments.
- Consumes: existing serialized controller queue so refresh cannot race submit, clear, diagnostics, or uninstall.

- [ ] **Step 1: Write failing IPC and renderer tests**

Extend exact channel and bridge assertions:

```ts
assert.ok(Object.values(IPC_CHANNELS).includes("setup:refresh-agents"));
assert.equal(validateIpcArguments(IPC_CHANNELS.refreshAgents, []), undefined);
assert.throws(() => validateIpcArguments(IPC_CHANNELS.refreshAgents, [{ apiKey: "SECRET" }]));
assert.ok(Object.keys(exposed).includes("refreshAgentIntegration"));
```

Render a result containing portable/Piko/Codex and Claude summaries, then assert the page contains:

```text
为你的 AI Agent 准备 Hypit
Codex
Claymore Piko
Claude Code
重新扫描 Agent
在你的 Agent 中试试
```

Also assert that `Codex Skill`, `让 Codex 开始制作视频`, and `请重启 Codex` no longer appear.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm exec tsx --test packages/desktop-setup/test/main-security.test.ts packages/desktop-setup/test/renderer.test.ts packages/desktop-setup/test/launcher-install.test.ts
```

Expected: FAIL because refresh IPC and neutral UI do not exist.

- [ ] **Step 3: Add the no-secret refresh operation**

Extend `IPC_CHANNELS`, `SetupBridge`, preload, and services:

```ts
refreshAgents: "setup:refresh-agents"
```

```ts
readonly refreshAgentIntegration: () => Promise<SetupReply<SetupResult>>;
```

The controller method must enqueue:

```ts
refreshAgentIntegration: () => enqueue(async () => {
  emit({ kind: "stage", stage: "installing-skill" });
  await services.refreshAgents();
  emit({ kind: "stage", stage: "diagnosing" });
  const result = publicResult(await services.getStatus());
  return { ...result, diagnostics: (await services.diagnose()).map(publicDiagnostic) };
})
```

The main-process service rescans and installs the selected/retained targets without `preserveExisting`, because the user explicitly requested this mutation and unmanaged target content must be backed up. Startup-only silent repair continues to use `preserveExisting: true`. Neither path touches `commitDesktopSetup`, the credential store, or the profile.

- [ ] **Step 4: Replace Codex-only copy and render detected targets**

Use these exact principal strings:

```ts
"为你的 AI Agent 准备 Hypit"
"连接你的 NewAPI 和 OSS，安装视频命令与 Agent Skill。完成后，可以在已支持的 Agent 中直接用中文描述想做的视频。"
"正在安装 Agent Skill"
"请重启正在使用的 Agent 和 Terminal，再测试 hypit 命令是否可用。"
"在你的 Agent 中试试"
```

Render target summaries as text nodes, not HTML. The refresh button dispatches a dedicated `refresh-agents` reducer action, disables all mutations while pending, calls the bridge method, and displays its allowlisted failure like existing operations.

- [ ] **Step 5: Verify and commit**

```bash
pnpm exec tsx --test packages/desktop-setup/test/main-security.test.ts packages/desktop-setup/test/renderer.test.ts packages/desktop-setup/test/launcher-install.test.ts
pnpm --filter @hypit/desktop-setup build
pnpm check
git add packages/desktop-setup/src/ipc.ts packages/desktop-setup/src/preload.ts packages/desktop-setup/src/main.ts packages/desktop-setup/src/renderer.ts packages/desktop-setup/src/launcher-install.ts packages/desktop-setup/test/main-security.test.ts packages/desktop-setup/test/renderer.test.ts packages/desktop-setup/test/launcher-install.test.ts
git commit -m "feat(desktop): refresh universal Agent integration"
```

Expected: focused tests, Electron build, and TypeScript pass.

---

### Task 7: Update recovery guidance, Skill instructions, and packaging evidence

**Files:**
- Modify: `packages/desktop-setup/build/installer.nsh`
- Modify: `packages/desktop-setup/src/cleanup-entry.ts`
- Modify: `packages/desktop-setup/test/uninstall.test.ts`
- Modify: `skills/hypit/references/environment/distribution.md`
- Modify: `docs/superpowers/specs/2026-09-29-desktop-installer-design.md`
- Modify: `docs/superpowers/plans/2026-09-29-desktop-installer.md`

**Interfaces:**
- Consumes: final target paths and launcher behavior.
- Produces: accurate user-facing recovery paths and Agent-neutral installation documentation.

- [ ] **Step 1: Write failing recovery and documentation assertions**

Add tests that build/read the cleanup entry and NSIS include, asserting they name:

```text
.agents\skills\hypit
.claude\skills\hypit
.codex\skills\hypit (only as a legacy/manual-recovery path)
```

Add a documentation assertion or focused text check that the Skill reference contains both absolute launchers and no longer says the desktop installer supplies a “managed Codex Skill”.

- [ ] **Step 2: Run tests and verify RED**

```bash
pnpm exec tsx --test packages/desktop-setup/test/uninstall.test.ts packages/desktop-setup/test/builder-config.test.ts
rg -n "managed Codex Skill|重启 Codex|Codex Skill" skills/hypit/references/environment/distribution.md packages/desktop-setup/src packages/desktop-setup/build
```

Expected: tests or text assertions fail on old Codex-only paths/copy.

- [ ] **Step 3: Update operational guidance**

Document:

```text
Hypit Setup installs the portable Skill at ~/.agents/skills/hypit.
Codex, Claymore Piko and Cursor use that portable copy.
When Claude Code is detected, Hypit Setup installs a managed compatibility copy at ~/.claude/skills/hypit.
If `hypit` is absent from a GUI Agent's PATH, invoke ~/.local/bin/hypit on macOS or %LOCALAPPDATA%\Hypit\bin\hypit.cmd on Windows.
Use “重新扫描 Agent” after installing another Agent; this does not request or rewrite model credentials.
```

Amend the original desktop design/plan with a dated note pointing to the universal-Agent design and plan; do not rewrite historical completed task descriptions.

- [ ] **Step 4: Run full verification**

```bash
git diff --check
pnpm check
pnpm test
pnpm --filter @hypit/desktop-setup build
node --import tsx --test packages/desktop-setup/test/*.test.ts
```

Expected: TypeScript exits 0; full suite has zero failures; desktop build and every desktop test pass.

- [ ] **Step 5: Build and inspect installers**

```bash
pnpm desktop:dist:mac
pnpm desktop:dist:win
```

Then run the repository's existing artifact checks against both outputs and inspect checksums. Expected:

```text
macOS arm64 DMG exists, mounts, contains Hypit Setup.app, and passes resource inspection.
Windows x64 NSIS EXE exists, unpacks, and passes static/resource inspection.
No claim of real Windows installation testing is made unless a Windows x64 machine was actually used.
```

- [ ] **Step 6: Run secret scanning when available and commit**

```bash
pre-commit run --all-files
git status --short
git add packages/desktop-setup/build/installer.nsh packages/desktop-setup/src/cleanup-entry.ts packages/desktop-setup/test/uninstall.test.ts skills/hypit/references/environment/distribution.md docs/superpowers/specs/2026-09-29-desktop-installer-design.md docs/superpowers/plans/2026-09-29-desktop-installer.md
git commit -m "docs(desktop): explain universal Agent integration"
```

Expected: hooks pass. If `pre-commit` or `gitleaks` is unavailable, record that exact limitation in the final verification report rather than claiming a scan passed.

---

## Final Review Checklist

- [ ] `git log --oneline origin/main..HEAD` contains the merge plus focused feature commits.
- [ ] `git status --short` is empty.
- [ ] No real API Key, OSS credential, signed URL, or generated media is tracked.
- [ ] `~/.agents/skills/hypit` is always selected.
- [ ] Codex, Claymore Piko, and Cursor do not receive redundant product-specific copies.
- [ ] Claude receives a compatibility copy only when detected or already managed.
- [ ] A removed Agent never causes automatic Skill deletion during scanning.
- [ ] Valid legacy Codex ownership migrates; invalid/unmanaged legacy content remains untouched.
- [ ] Every managed target has an independent backup and target-bound v2 marker.
- [ ] All install, refresh, migration, and uninstall mutations are transactional.
- [ ] UI, diagnostics, recovery copy, and Skill documentation are Agent-neutral.
- [ ] Full tests, desktop tests, type-check, builds, and artifact inspections have fresh evidence.
