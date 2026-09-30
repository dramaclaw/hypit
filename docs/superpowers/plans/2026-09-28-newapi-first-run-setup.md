# NewAPI First-Run Setup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the standard Hypit Runtime default its nine supported image/video capabilities to DramaClaw NewAPI and securely configure a missing NewAPI account during the first interactive `runtime up`.

**Architecture:** `@dramaclaw/provider-newapi` owns pure setup inspection and config assembly. The generic CLI exposes a narrowly typed pre-start configuration hook and credential handoff, while the video Distribution implements the NewAPI-specific prompts. The same pure setup API is reusable by a future desktop installer; terminal, filesystem and CredentialStore concerns stay outside it.

**Tech Stack:** TypeScript, Node.js CLI I/O, Hypit Runtime Profile and CredentialStore APIs, `node:test`, pnpm.

## Global Constraints

- Keep `hypihub.default`; bind only the nine capabilities already mapped by `@dramaclaw/provider-newapi` to `newapi.personal`.
- Never inject NewAPI into an existing Profile that does not already select `@dramaclaw/provider-newapi`.
- Store NewAPI Key and OSS AK/SK only in a selected CredentialStore; never serialize them into the Profile, output or errors.
- OSS stays optional. A user who declines it can start and use text-only image/video generation.
- Interactive prompts run only for human, non-JSON `runtime up`; non-interactive and JSON commands fail with stable missing-field guidance.
- Profile replacement must be atomic.
- No installer, updater, Node/FFmpeg bundling, Chrome download change or WhisperX packaging belongs to this plan.

---

## File Structure

- `packages/provider-newapi/src/setup.ts`: pure NewAPI setup state, validation, config assembly and default binding constants.
- `packages/provider-newapi/test/setup.test.ts`: pure setup behavior and secret-exclusion tests.
- `packages/cli/src/distribution.ts`: generic first-run hook request/result contracts.
- `packages/cli/src/output.ts`: ordinary text prompt capability beside existing secure secret input.
- `packages/cli/src/commands/environment.ts`: call the hook before Runtime preparation, atomically replace a changed Profile, and persist only returned credentials.
- `packages/cli/package.json`: add the existing workspace atomic file helper dependency.
- `packages/video-cli/src/newapi-setup.ts`: terminal adapter for the pure setup core.
- `packages/video-cli/src/distribution.ts`: starter Endpoint/bindings and hook registration.
- `packages/video-cli/src/cli.ts`: concrete line-oriented text input.
- `packages/video-cli/package.json`: declare the setup core's workspace package dependency.
- `packages/video-cli/test/newapi-first-run.test.ts`: CLI integration tests for prompts, persistence, repeat startup and non-interactive failure.
- `packages/provider-newapi/README.md`: document the new default and first-run flow.

---

### Task 1: Pure NewAPI setup core

**Files:**
- Create: `packages/provider-newapi/src/setup.ts`
- Create: `packages/provider-newapi/test/setup.test.ts`
- Modify: `packages/provider-newapi/src/index.ts`

**Interfaces:**
- Produces: `newApiDefaultBindings: Readonly<Record<string, "newapi.personal">>`.
- Produces: `inspectNewApiSetup(config: CanonicalValue): NewApiSetupInspection`.
- Produces: `completeNewApiSetup(input: NewApiSetupInput): { config: CanonicalValue; credentials: readonly NewApiSetupCredential[] }`.
- `NewApiSetupCredential` is `{ slot: "apiKey" | "relayAccessKeyId" | "relayAccessKeySecret"; secret: string }`.

- [ ] **Step 1: Write failing setup tests**

```ts
test("the setup core owns exactly the nine NewAPI default bindings", () => {
  assert.equal(Object.keys(newApiDefaultBindings).length, 9);
  assert.deepEqual(new Set(Object.values(newApiDefaultBindings)), new Set(["newapi.personal"]));
});

test("text-only setup emits no relay fields or secrets", () => {
  const result = completeNewApiSetup({
    baseUrl: "https://gateway.example/v1",
    apiKey: "key-value",
    relay: { enabled: false },
  });
  assert.deepEqual(result.config, {
    baseUrl: "https://gateway.example/v1",
    apiKey: { store: "platform", key: "newapi.personal.api-key" },
  });
  assert.deepEqual(result.credentials, [{ slot: "apiKey", secret: "key-value" }]);
  assert.doesNotMatch(JSON.stringify(result.config), /key-value/u);
});

test("relay setup is all-or-none and returns three credential writes", () => {
  const result = completeNewApiSetup({
    baseUrl: "https://gateway.example/v1", apiKey: "newapi-key",
    relay: { enabled: true, endpoint: "oss-cn-chengdu.aliyuncs.com", bucket: "team-relay", accessKeyId: "ak", accessKeySecret: "sk" },
  });
  assert.equal(result.credentials.length, 3);
  assert.equal((result.config as Record<string, unknown>).relayBucket, "team-relay");
  assert.doesNotMatch(JSON.stringify(result.config), /newapi-key|\"ak\"|\"sk\"/u);
});
```

- [ ] **Step 2: Run the setup tests and verify RED**

Run: `pnpm exec tsx --test packages/provider-newapi/test/setup.test.ts`

Expected: FAIL because `../src/setup.js` does not exist.

- [ ] **Step 3: Implement the pure setup module**

```ts
export const newApiDefaultBindings = Object.freeze(Object.fromEntries(
  newApiRoutes.map((route) => [route.key, "newapi.personal"]),
));

export function inspectNewApiSetup(config: CanonicalValue): NewApiSetupInspection {
  const item = config !== null && typeof config === "object" && !Array.isArray(config)
    ? config as Record<string, CanonicalValue> : {};
  const baseUrl = typeof item.baseUrl === "string" ? item.baseUrl.trim() : "";
  return { configured: baseUrl.length > 0, missing: baseUrl.length > 0 ? [] : ["baseUrl"] };
}

export function completeNewApiSetup(input: NewApiSetupInput) {
  const baseUrl = validateNewApiSetupUrl(input.baseUrl);
  const credentials: NewApiSetupCredential[] = [{ slot: "apiKey", secret: requiredSecret(input.apiKey, "NewAPI API Key") }];
  const config: Record<string, CanonicalValue> = {
    baseUrl,
    apiKey: { store: "platform", key: "newapi.personal.api-key" },
  };
  if (input.relay.enabled) {
    config.relayEndpoint = requiredText(input.relay.endpoint, "OSS Endpoint");
    config.relayBucket = requiredText(input.relay.bucket, "OSS Bucket");
    config.relayAccessKeyId = { store: "platform", key: "newapi.personal.oss-ak" };
    config.relayAccessKeySecret = { store: "platform", key: "newapi.personal.oss-sk" };
    config.relayTtlSeconds = 3600;
    credentials.push(
      { slot: "relayAccessKeyId", secret: requiredSecret(input.relay.accessKeyId, "OSS AccessKey ID") },
      { slot: "relayAccessKeySecret", secret: requiredSecret(input.relay.accessKeySecret, "OSS AccessKey Secret") },
    );
  }
  return { config, credentials };
}
```

Validate HTTPS and loopback HTTP using the same rule as `createNewApiProvider`; reject empty secrets before returning.

- [ ] **Step 4: Export the setup API and verify GREEN**

Run: `pnpm exec tsx --test packages/provider-newapi/test/setup.test.ts && pnpm check`

Expected: setup tests PASS and TypeScript exits 0.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/provider-newapi/src/setup.ts packages/provider-newapi/src/index.ts packages/provider-newapi/test/setup.test.ts
git commit -m "feat(newapi): add reusable first-run setup core"
```

---

### Task 2: Generic CLI pre-start setup contract

**Files:**
- Modify: `packages/cli/src/distribution.ts`
- Modify: `packages/cli/src/output.ts`
- Modify: `packages/cli/src/commands/environment.ts`
- Modify: `packages/cli/package.json`
- Test: `packages/cli/test/control-commands.test.ts`

**Interfaces:**
- Consumes: the existing `NodeRuntimeHost.openCredentials(endpoint)` control.
- Produces: `CliIo.readText?: (prompt: string) => Promise<string>`.
- Produces: `CliDistribution.configureRuntimeProfileBeforeUp?(context): Promise<CliRuntimeProfileSetupResult>`.
- Result contains `profile: CanonicalValue`, `changed: boolean`, and credential writes `{ endpoint, slot, secret }[]`.

- [ ] **Step 1: Write a failing generic hook test**

Add a test Distribution whose hook changes `{ format: "hypit.runtime-local@1" }` to include `configured: true` and returns one credential write. Assert, before `host.prepare` is observed, that the Profile file already contains the new value and the fake credential control received the secret. Assert CLI output and file text do not contain the secret.

```ts
assert.equal(events[0], "configure");
assert.equal(events[1], "credential:apiKey");
assert.equal(events[2], "prepare");
assert.equal(JSON.parse(await readFile(profile, "utf8")).configured, true);
assert.doesNotMatch(await readFile(profile, "utf8"), /private-test-key/u);
assert.doesNotMatch(output.join(""), /private-test-key/u);
```

- [ ] **Step 2: Run the focused CLI test and verify RED**

Run: `pnpm exec tsx --test packages/cli/test/control-commands.test.ts --test-name-pattern="configures a selected Runtime before up"`

Expected: FAIL because `configureRuntimeProfileBeforeUp` is not part of `CliDistribution` and is never called.

- [ ] **Step 3: Add the hook and prompt contracts**

```ts
export type CliRuntimeCredentialWrite = {
  readonly endpoint: string;
  readonly slot: string;
  readonly secret: string;
};

export type CliRuntimeProfileSetupResult = {
  readonly profile: CanonicalValue;
  readonly changed: boolean;
  readonly credentials: readonly CliRuntimeCredentialWrite[];
};
```

The hook context includes `profilePath`, parsed `profile`, `interactive`, `readText`, `readSecret`, and `writeProgress`. Add `readText` to `CliIo` without changing callers that omit it.

- [ ] **Step 4: Invoke the hook and atomically persist its result**

In the `runtime up` branch, before `host.prepare`:

```ts
const setup = distribution.configureRuntimeProfileBeforeUp === undefined
  ? undefined
  : await distribution.configureRuntimeProfileBeforeUp({
      profilePath: profile,
      profile: JSON.parse(await readFile(profile, "utf8")) as CanonicalValue,
      interactive: !args.presentation.json && io.terminal?.isTTY === true,
      readText: io.readText,
      readSecret: io.readSecret,
      writeProgress: io.writeProgress ?? io.write,
    });
if (setup?.changed === true) await replaceJsonFile(profile, setup.profile);
const host = await runtimeHost(profile, packageRoot);
for (const item of setup?.credentials ?? []) {
  const control = await host.openCredentials(item.endpoint);
  try { await control.putCredential(item.endpoint, item.slot, item.secret); }
  finally { await control.close?.(); }
}
```

Implement `replaceJsonFile` using a sibling temporary path, `writeFile`, and `replaceFile` from `@hypit/file-io-node`. Add the workspace dependency to `packages/cli/package.json`.

- [ ] **Step 5: Run focused and package tests**

Run: `pnpm exec tsx --test packages/cli/test/control-commands.test.ts && pnpm check`

Expected: PASS with the event order `configure`, credential write, `prepare`; TypeScript exits 0.

- [ ] **Step 6: Commit Task 2**

```bash
git add packages/cli/src/distribution.ts packages/cli/src/output.ts packages/cli/src/commands/environment.ts packages/cli/package.json pnpm-lock.yaml packages/cli/test/control-commands.test.ts
git commit -m "feat(cli): configure Runtime before first startup"
```

---

### Task 3: Video Distribution NewAPI wizard and defaults

**Files:**
- Create: `packages/video-cli/src/newapi-setup.ts`
- Modify: `packages/video-cli/src/distribution.ts`
- Modify: `packages/video-cli/src/cli.ts`
- Modify: `packages/video-cli/package.json`
- Create: `packages/video-cli/test/newapi-first-run.test.ts`

**Interfaces:**
- Consumes: `inspectNewApiSetup`, `completeNewApiSetup`, and `newApiDefaultBindings` from Task 1.
- Consumes: `CliDistribution.configureRuntimeProfileBeforeUp` from Task 2.
- Produces: `configureNewApiRuntimeBeforeUp(context): Promise<CliRuntimeProfileSetupResult>`.

- [ ] **Step 1: Write failing starter and wizard tests**

```ts
test("the video starter keeps HypiHub and defaults supported media to NewAPI", () => {
  const profile = videoCliDistribution.initialRuntimeProfile as RuntimeProfile;
  assert.equal(profile.endpoints["hypihub.default"].use, "@hypit/provider-hypihub");
  assert.equal(profile.endpoints["newapi.personal"].use, "@dramaclaw/provider-newapi");
  assert.deepEqual(profile.bindings, newApiDefaultBindings);
});

function contextWithAnswers(answers: readonly string[]) {
  const queue = [...answers];
  return {
    profilePath: "/project/hypit.runtime.json",
    profile: videoCliDistribution.initialRuntimeProfile!,
    interactive: true,
    readText: async () => queue.shift() ?? "",
    readSecret: async () => queue.shift() ?? "",
    writeProgress: () => undefined,
  };
}

test("first interactive up configures NewAPI without OSS", async () => {
  const result = await configureNewApiRuntimeBeforeUp(contextWithAnswers([
    "https://gateway.example/v1", "newapi-secret", "no",
  ]));
  assert.equal(result.changed, true);
  assert.equal(result.credentials.length, 1);
  assert.doesNotMatch(JSON.stringify(result.profile), /newapi-secret/u);
});

test("non-interactive up lists missing NewAPI configuration", async () => {
  await assert.rejects(
    () => configureNewApiRuntimeBeforeUp({ ...context, interactive: false }),
    /NewAPI is the default.*baseUrl.*interactive terminal/u,
  );
});
```

- [ ] **Step 2: Run the new tests and verify RED**

Run: `pnpm exec tsx --test packages/video-cli/test/newapi-first-run.test.ts`

Expected: FAIL because `newapi.personal` and `configureNewApiRuntimeBeforeUp` do not exist.

- [ ] **Step 3: Add the starter Endpoint and bindings**

```ts
"newapi.personal": {
  use: "@dramaclaw/provider-newapi",
  pool: "newapi.personal",
  config: {
    baseUrl: "",
    apiKey: { store: "platform", key: "newapi.personal.api-key" },
  },
},
```

Set `bindings: newApiDefaultBindings` and retain the existing HypiHub, media and HyperFrames endpoints unchanged.

- [ ] **Step 4: Implement the terminal adapter**

Read and validate ordinary fields through `readText`; read secrets only through `readSecret`. Accept `y`, `yes`, `是` as enabling OSS and `n`, `no`, `否` as declining. Reprompt invalid yes/no answers without writing anything. Return the pure core's Profile config and credential writes addressed to `newapi.personal`.

```ts
const completed = completeNewApiSetup({
  baseUrl: await requiredLine(context, "NewAPI address: "),
  apiKey: await requiredSecret(context, "NewAPI API key: "),
  relay: await relayAnswers(context),
});
return {
  profile: replaceEndpointConfig(context.profile, "newapi.personal", completed.config),
  changed: true,
  credentials: completed.credentials.map((item) => ({ endpoint: "newapi.personal", ...item })),
};
```

- [ ] **Step 5: Add concrete text input to the Node CLI**

Use `node:readline/promises` with stderr as the prompt output:

```ts
async function readText(prompt: string): Promise<string> {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  try { return await terminal.question(prompt); }
  finally { terminal.close(); }
}
```

Register `readText` in the concrete `CliIo`; leave `readSecret` unchanged. Add `@dramaclaw/provider-newapi: "workspace:*"` to `packages/video-cli/package.json` and refresh `pnpm-lock.yaml`.

- [ ] **Step 6: Verify wizard tests and existing credential tests**

Run: `pnpm exec tsx --test packages/video-cli/test/newapi-first-run.test.ts packages/video-cli/test/platform-credentials.test.ts packages/video-cli/test/file-credentials.test.ts && pnpm check`

Expected: all selected tests PASS; TypeScript exits 0.

- [ ] **Step 7: Commit Task 3**

```bash
git add packages/video-cli/src/newapi-setup.ts packages/video-cli/src/distribution.ts packages/video-cli/src/cli.ts packages/video-cli/package.json pnpm-lock.yaml packages/video-cli/test/newapi-first-run.test.ts
git commit -m "feat(runtime): default first startup to NewAPI"
```

---

### Task 4: Missing credential recovery and secret safety

**Files:**
- Modify: `packages/cli/src/commands/environment.ts`
- Modify: `packages/cli/src/distribution.ts`
- Modify: `packages/video-cli/src/newapi-setup.ts`
- Modify: `packages/video-cli/test/newapi-first-run.test.ts`

**Interfaces:**
- Extends the setup result with `requiredCredentials: readonly { endpoint: string; slots: readonly string[] }[]`.
- Reuses `describeCredentials`, `putCredential`, `writable`, and CredentialRef metadata from the existing auth flow.

- [ ] **Step 1: Write failing recovery tests**

Add tests proving:

```ts
assert.deepEqual(promptedSlots, ["relayAccessKeySecret"]);
assert.doesNotMatch(allOutput, /replacement-secret/u);
assert.equal(workerStarts, 1);
```

for a configured Profile missing only the OSS secret. Add a read-only environment-store case asserting:

```ts
await assert.rejects(() => up(), /set NEWAPI_API_KEY in the environment/u);
assert.equal(workerStarts, 0);
```

- [ ] **Step 2: Run recovery tests and verify RED**

Run: `pnpm exec tsx --test packages/video-cli/test/newapi-first-run.test.ts --test-name-pattern="missing credential|read-only credential"`

Expected: FAIL because configured Profiles skip setup and no credential audit runs.

- [ ] **Step 3: Return required credential slots from the video hook**

Always return `apiKey`; include `relayAccessKeyId` and `relayAccessKeySecret` only when the Profile contains a complete relay config. Do not request HypiHub or unrelated Endpoint credentials.

- [ ] **Step 4: Audit and acquire only missing credentials before prepare**

For every required slot, call `describeCredentials`, select the exact slot, and:

- continue when `configured` is true;
- securely prompt and `putCredential` when missing and writable;
- throw `set <key> in the environment` when the CredentialRef store is `env` and not writable;
- throw a stable missing-credential error for any other read-only store.

Never place the secret in an error, progress event or setup result after storage.

```ts
for (const requirement of setup.requiredCredentials) {
  const control = await host.openCredentials(requirement.endpoint);
  try {
    const declared = await control.describeCredentials(requirement.endpoint);
    for (const slot of requirement.slots) {
      const item = declared.find((candidate) => candidate.slot === slot);
      if (item === undefined) throw new Error(`Endpoint ${requirement.endpoint} does not declare ${slot}`);
      if ((await control.credentials(requirement.endpoint)).some((state) => state.slot === slot && state.configured)) continue;
      if (!item.writable) {
        if (item.ref.store === "env") throw new Error(`set ${item.ref.key} in the environment`);
        throw new Error(`${item.label} is missing from its read-only credential source`);
      }
      const secret = (await io.readSecret?.(`${item.label}: `))?.trim();
      if (!secret) throw new Error(`${item.label} input was cancelled or empty`);
      await control.putCredential(requirement.endpoint, slot, secret);
    }
  } finally {
    await control.close?.();
  }
}
```

- [ ] **Step 5: Verify recovery, cancellation and no-secret output**

Run: `pnpm exec tsx --test packages/video-cli/test/newapi-first-run.test.ts packages/video-cli/test/platform-credentials.test.ts packages/video-cli/test/file-credentials.test.ts && pnpm check`

Expected: all selected tests PASS; cancelled input and missing read-only values prevent `prepare` and Worker startup.

- [ ] **Step 6: Commit Task 4**

```bash
git add packages/cli/src/commands/environment.ts packages/cli/src/distribution.ts packages/video-cli/src/newapi-setup.ts packages/video-cli/test/newapi-first-run.test.ts
git commit -m "feat(runtime): recover missing NewAPI credentials"
```

---

### Task 5: Documentation and full verification

**Files:**
- Modify: `packages/provider-newapi/README.md`
- Modify: `docs/zh/guide/runtime.md`

**Interfaces:**
- Documents the completed CLI and setup-core behavior; introduces no runtime API.

- [ ] **Step 1: Update user documentation**

Document this exact flow:

```bash
hypit runtime init
hypit runtime up
```

Explain that the first `up` asks for NewAPI, OSS is optional, HypiHub remains present, nine bindings default to NewAPI, and secrets go to the platform CredentialStore. Include the non-interactive error behavior and how to add OSS later by editing the non-secret relay fields followed by `hypit auth login newapi.personal --slot ...`.

- [ ] **Step 2: Run focused NewAPI and CLI tests**

Run:

```bash
pnpm exec tsx --test \
  packages/provider-newapi/test/*.test.ts \
  packages/video-cli/test/newapi-first-run.test.ts \
  packages/video-cli/test/platform-credentials.test.ts \
  packages/video-cli/test/file-credentials.test.ts
```

Expected: all selected tests PASS, 0 failures.

- [ ] **Step 3: Run repository checks**

Run:

```bash
pnpm check
pnpm test
git diff --check
```

Expected: TypeScript exits 0; full test suite reports 0 failures; diff check emits no output.

- [ ] **Step 4: Verify the packed Distribution**

Run:

```bash
npm run pack:distribution
npm run check:distribution -- "$PWD/dist/release/hypit-hypit-0.2.16.tgz"
```

Expected: packed inventory contains `packages/provider-newapi/src/setup.ts`; installed Distribution completes component build, Runtime startup, render and export.

- [ ] **Step 5: Commit Task 5**

```bash
git add packages/provider-newapi/README.md docs/zh/guide/runtime.md
git commit -m "docs: explain default NewAPI first-run setup"
```
