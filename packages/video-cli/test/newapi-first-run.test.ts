import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { newApiDefaultBindings, parseNewApiEndpointConfig } from "@dramaclaw/provider-newapi";
import { runCli } from "@hypit/cli";
import type { CliRuntimeProfileSetupContext } from "@hypit/cli";
import { videoCliDistribution } from "../src/distribution.js";
import { configureNewApiRuntimeBeforeUp } from "../src/newapi-setup.js";

type Profile = Record<string, any>;

function contextWithAnswers(answers: readonly string[]): CliRuntimeProfileSetupContext {
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

test("the video starter keeps HypiHub and defaults supported media to NewAPI", () => {
  const profile = videoCliDistribution.initialRuntimeProfile as Profile;
  assert.equal(profile.endpoints["hypihub.default"].use, "@hypit/provider-hypihub");
  assert.equal(profile.endpoints["newapi.personal"].use, "@dramaclaw/provider-newapi");
  assert.deepEqual(profile.bindings, newApiDefaultBindings);
  assert.equal(Object.keys(profile.bindings).length, 9);
});

test("first interactive up configures NewAPI without OSS", async () => {
  const result = await configureNewApiRuntimeBeforeUp(contextWithAnswers([
    "https://gateway.example/v1", "newapi-secret", "no",
  ]));
  assert.equal(result.changed, true);
  assert.deepEqual(result.credentials, [{ endpoint: "newapi.personal", slot: "apiKey", secret: "newapi-secret" }]);
  const profile = result.profile as Profile;
  assert.equal(profile.endpoints["newapi.personal"].config.baseUrl, "https://gateway.example/v1");
  assert.equal(profile.endpoints["newapi.personal"].config.relayEndpoint, undefined);
  assert.equal(profile.endpoints["hypihub.default"].use, "@hypit/provider-hypihub");
  assert.doesNotMatch(JSON.stringify(result.profile), /newapi-secret/u);
});

test("non-interactive up lists missing NewAPI configuration", async () => {
  await assert.rejects(
    () => configureNewApiRuntimeBeforeUp({ ...contextWithAnswers([]), interactive: false }),
    /NewAPI is the default.*baseUrl.*interactive terminal/u,
  );
});

test("invalid URL is retried before reading any secret and summary is safe", async () => {
  const prompts: string[] = [];
  const output: string[] = [];
  const urls = ["http://remote.example/private?token=url-secret", "https://gateway.example/v1"];
  let secretsRead = 0;
  const result = await configureNewApiRuntimeBeforeUp({ ...contextWithAnswers([]),
    readText: async (prompt) => {
      prompts.push(prompt);
      if (prompt.startsWith("NewAPI")) { assert.equal(secretsRead, 0); return urls.shift()!; }
      return "no";
    },
    readSecret: async () => { secretsRead += 1; return "private-api-secret"; },
    writeProgress: (value) => { output.push(value); },
  });
  assert.equal(result.changed, true);
  assert.equal(secretsRead, 1);
  assert.deepEqual(prompts, ["NewAPI address: ", "NewAPI address: ", "Configure OSS relay for generated media? [y/n]: "]);
  assert.match(output.join(""), /NewAPI.*OSS.*disabled/su);
  assert.doesNotMatch(output.join(""), /private-api-secret|url-secret/u);
});

test("summary redacts a credential even when it matches the gateway host", async () => {
  const progress: string[] = [];
  await configureNewApiRuntimeBeforeUp({ ...contextWithAnswers(["https://private-key.example/v1", "private-key", "no"]),
    writeProgress: (value) => { progress.push(value); },
  });
  assert.doesNotMatch(progress.join(""), /private-key/u);
});

test("stdout TTY with redirected stdin never reads answers or prepares runtime", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypit-newapi-pipe-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const profilePath = join(root, "runtime.json");
  await writeFile(profilePath, JSON.stringify(videoCliDistribution.initialRuntimeProfile));
  let reads = 0;
  let opened = 0;
  const io = { write() {}, inputIsTTY: false,
    readText: async () => { reads += 1; throw new Error("must not read redirected stdin"); },
    readSecret: async () => { reads += 1; throw new Error("must not read redirected stdin"); },
    terminal: { isTTY: true, color: false, unicode: true, columns: 100 },
  };
  const distribution = { ...videoCliDistribution,
    async openRuntimeHost() { opened += 1; throw new Error("must not open runtime"); },
  };
  await assert.rejects(() => runCli(["runtime", "up", profilePath, "--workspace", root], io, distribution), /baseUrl.*missing/u);
  assert.equal(reads, 0); assert.equal(opened, 0);
});

test("an existing Profile without NewAPI is left untouched", async () => {
  const profile = { format: "hypit.runtime-local@1", endpoints: { "hypihub.default": { use: "@hypit/provider-hypihub" } } };
  const result = await configureNewApiRuntimeBeforeUp({
    ...contextWithAnswers([]), profile, interactive: false,
  });
  assert.equal(result.profile, profile);
  assert.equal(result.changed, false);
  assert.deepEqual(result.credentials, []);
});

test("an already configured NewAPI endpoint needs no prompt", async () => {
  const starter = videoCliDistribution.initialRuntimeProfile as Profile;
  const profile = {
    ...starter,
    endpoints: {
      ...starter.endpoints,
      "newapi.personal": {
        ...starter.endpoints["newapi.personal"],
        config: { ...starter.endpoints["newapi.personal"].config, baseUrl: "https://configured.example/v1" },
      },
    },
  };
  const result = await configureNewApiRuntimeBeforeUp({ ...contextWithAnswers([]), profile, interactive: false });
  assert.equal(result.profile, profile);
  assert.equal(result.changed, false);
  assert.deepEqual(result.credentials, []);
});

test("configured NewAPI always requires apiKey and requires OSS slots only for complete relay config", async () => {
  const starter = videoCliDistribution.initialRuntimeProfile as Profile;
  const base = { ...starter, endpoints: { ...starter.endpoints, "newapi.personal": {
    ...starter.endpoints["newapi.personal"], config: { baseUrl: "https://configured.example/v1" },
  } } };
  const withoutRelay = await configureNewApiRuntimeBeforeUp({ ...contextWithAnswers([]), profile: base, interactive: false });
  assert.deepEqual(withoutRelay.requiredCredentials, [{ endpoint: "newapi.personal", slots: ["apiKey"] }]);
  const incompleteRelay = { ...base, endpoints: { ...base.endpoints, "newapi.personal": {
    ...base.endpoints["newapi.personal"], config: { ...base.endpoints["newapi.personal"].config,
      relayEndpoint: "https://oss.example", relayBucket: "bucket" },
  } } };
  const incomplete = await configureNewApiRuntimeBeforeUp({
    ...contextWithAnswers([]), profile: incompleteRelay, interactive: false,
  });
  assert.deepEqual(incomplete.requiredCredentials, [{ endpoint: "newapi.personal", slots: ["apiKey"] }]);
});

test("OSS setup reprompts invalid choice and returns three credential writes", async () => {
  const progress: string[] = [];
  const result = await configureNewApiRuntimeBeforeUp({
    ...contextWithAnswers([
      "https://gateway.example/v1", "newapi-secret", "maybe", "是",
      "https://oss.example", "bucket", "oss-ak-secret", "oss-sk-secret",
    ]),
    writeProgress: (value) => { progress.push(value); },
  });
  assert.equal(result.changed, true);
  assert.deepEqual(result.credentials.map(({ endpoint, slot }) => [endpoint, slot]), [
    ["newapi.personal", "apiKey"],
    ["newapi.personal", "relayAccessKeyId"],
    ["newapi.personal", "relayAccessKeySecret"],
  ]);
  const config = (result.profile as Profile).endpoints["newapi.personal"].config;
  assert.equal(config.relayEndpoint, "https://oss.example");
  assert.equal(config.relayBucket, "bucket");
  assert.doesNotMatch(JSON.stringify(result.profile) + progress.join(""), /newapi-secret|oss-ak-secret|oss-sk-secret/u);
  assert.match(progress.join(""), /NewAPI.*OSS.*enabled/su);
});

test("a custom writable store keeps its API and OSS credential refs", async () => {
  const starter = videoCliDistribution.initialRuntimeProfile as Profile;
  const apiKey = { store: "file", key: "my.newapi.key" };
  const relayAccessKeyId = { store: "file", key: "my.oss.ak" };
  const relayAccessKeySecret = { store: "file", key: "my.oss.sk" };
  const profile = {
    ...starter,
    credentials: { file: { use: "@hypit/credential-store-file", config: { path: "./private" } } },
    endpoints: { ...starter.endpoints, "newapi.personal": {
      ...starter.endpoints["newapi.personal"],
      config: { baseUrl: "", apiKey, relayAccessKeyId, relayAccessKeySecret },
    } },
  };
  const result = await configureNewApiRuntimeBeforeUp({ ...contextWithAnswers([
    "https://gateway.example/v1", "api-secret", "yes", "https://oss.example", "bucket", "ak-secret", "sk-secret",
  ]), profile });
  const config = (result.profile as Profile).endpoints["newapi.personal"].config;
  assert.deepEqual(config.apiKey, apiKey);
  assert.deepEqual(config.relayAccessKeyId, relayAccessKeyId);
  assert.deepEqual(config.relayAccessKeySecret, relayAccessKeySecret);
  assert.deepEqual((result.profile as Profile).credentials, profile.credentials);
});

test("a Profile selecting only file credentials creates its missing ref in that store", async () => {
  const starter = videoCliDistribution.initialRuntimeProfile as Profile;
  const profile = { ...starter,
    credentials: { file: { use: "@hypit/credential-store-file", config: { path: "./private" } } },
    endpoints: { ...starter.endpoints, "newapi.personal": {
      ...starter.endpoints["newapi.personal"], config: { baseUrl: "" },
    } },
  };
  const result = await configureNewApiRuntimeBeforeUp({
    ...contextWithAnswers(["https://gateway.example/v1", "api-secret", "no"]), profile,
  });
  assert.deepEqual((result.profile as Profile).endpoints["newapi.personal"].config.apiKey,
    { store: "file", key: "newapi.personal.api-key" });
});

test("declining OSS removes stale relay config while preserving unrelated NewAPI choices", async () => {
  const starter = videoCliDistribution.initialRuntimeProfile as Profile;
  const apiKey = { store: "file", key: "my.newapi.key" };
  const profile = { ...starter,
    credentials: { file: { use: "@hypit/credential-store-file", config: { path: "./private" } } },
    endpoints: { ...starter.endpoints, "newapi.personal": {
      ...starter.endpoints["newapi.personal"],
      config: {
        baseUrl: "", apiKey, pollIntervalMs: 2500, defaultConcurrency: 2,
        relayEndpoint: "https://old-oss.example", relayBucket: "old-bucket",
        relayAccessKeyId: { store: "file", key: "old.ak" },
        relayAccessKeySecret: { store: "file", key: "old.sk" }, relayTtlSeconds: 7200,
      },
    } },
  };
  const progress: string[] = [];
  const result = await configureNewApiRuntimeBeforeUp({
    ...contextWithAnswers(["https://gateway.example/v1", "api-secret", "no"]), profile,
    writeProgress: (value) => { progress.push(value); },
  });
  const config = (result.profile as Profile).endpoints["newapi.personal"].config;
  assert.deepEqual(config.apiKey, apiKey);
  assert.equal(config.pollIntervalMs, 2500);
  assert.equal(config.defaultConcurrency, 2);
  for (const field of ["relayEndpoint", "relayBucket", "relayAccessKeyId", "relayAccessKeySecret", "relayTtlSeconds"]) {
    assert.equal(Object.hasOwn(config, field), false, `${field} must be removed`);
  }
  assert.equal(parseNewApiEndpointConfig(config).relay, undefined);
  assert.deepEqual(result.requiredCredentials, [{ endpoint: "newapi.personal", slots: ["apiKey"] }]);
  assert.deepEqual(result.credentials.map(({ slot }) => slot), ["apiKey"]);
  assert.doesNotMatch(JSON.stringify(result.profile) + progress.join(""), /api-secret/u);
});

test("a failed second credential write resumes only missing secrets on the next up", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypit-newapi-retry-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const profilePath = join(root, "runtime.json");
  await writeFile(profilePath, `${JSON.stringify(videoCliDistribution.initialRuntimeProfile)}\n`);
  const stored = new Map<string, string>();
  const prompted: string[] = [];
  const output: string[] = [];
  let failSecondWrite = true;
  let prepared = 0;
  const slots = ["apiKey", "relayAccessKeyId", "relayAccessKeySecret"];
  const distribution = {
    ...videoCliDistribution,
    async openRuntimeHost() { return {
      async openCredentials() { return {
        async describeCredentials() { return slots.map((slot) => ({
          endpoint: "newapi.personal", slot, label: slot, kind: "secret" as const,
          ref: { store: "platform", key: slot }, writable: true,
        })); },
        async credentials() { return slots.map((slot) => ({
          endpoint: "newapi.personal", slot, label: slot, kind: "secret" as const,
          ref: { store: "platform", key: slot }, writable: true, configured: stored.has(slot),
        })); },
        async putCredential(_endpoint: string, slot: string, secret: string) {
          if (slot === "relayAccessKeyId" && failSecondWrite) {
            failSecondWrite = false;
            throw new Error(`store failed for ${secret}`);
          }
          stored.set(slot, secret);
        },
        async close() {},
      }; },
      async prepare() { prepared += 1; assert.equal(stored.size, 3); return []; },
      async createRuntime() { return { async close() {} }; },
      async controller() { return {
        programs: { async up() { return { programs: [] }; } },
        worker: { async up() { return { state: "running" }; } },
      }; },
    }; },
  } as unknown as typeof videoCliDistribution;
  const answers = ["https://gateway.example/v1", "first-api-secret", "yes", "https://oss.example", "bucket", "first-ak-secret", "first-sk-secret"];
  const io = {
    write: (value: string) => { output.push(value); },
    readText: async (prompt: string) => { prompted.push(prompt); return answers.shift() ?? ""; },
    readSecret: async (prompt: string) => { prompted.push(prompt); return answers.shift() ?? ""; },
    inputIsTTY: true,
    terminal: { isTTY: true, color: false, unicode: true, columns: 100 },
  };
  await assert.rejects(
    () => runCli(["runtime", "up", profilePath, "--workspace", root], io, distribution),
    (error: Error) => { assert.doesNotMatch(error.message, /first-ak-secret/u); return true; },
  );
  assert.equal(prepared, 0);
  assert.deepEqual([...stored.keys()], ["apiKey"]);
  const saved = await readFile(profilePath, "utf8");
  assert.match(saved, /gateway\.example/u);
  assert.doesNotMatch(saved, /first-api-secret|first-ak-secret|first-sk-secret/u);
  answers.push("second-ak-secret", "second-sk-secret");
  prompted.length = 0;
  await runCli(["runtime", "up", profilePath, "--workspace", root], io, distribution);
  assert.equal(prepared, 1);
  assert.deepEqual(prompted, ["relayAccessKeyId: ", "relayAccessKeySecret: "]);
  assert.equal(stored.get("apiKey"), "first-api-secret");
  assert.equal(stored.get("relayAccessKeyId"), "second-ak-secret");
  assert.equal(stored.get("relayAccessKeySecret"), "second-sk-secret");
  assert.doesNotMatch(output.join(""), /first-api-secret|first-ak-secret|first-sk-secret|second-ak-secret|second-sk-secret/u);
});

test("a missing read-only env key stops before prepare with stable guidance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypit-newapi-env-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const profilePath = join(root, "runtime.json");
  const starter = videoCliDistribution.initialRuntimeProfile as Profile;
  const profile = { ...starter,
    credentials: { env: { use: "@hypit/credential-store-env" } },
    endpoints: { ...starter.endpoints, "newapi.personal": {
      ...starter.endpoints["newapi.personal"],
      config: { baseUrl: "https://gateway.example/v1", apiKey: { store: "env", key: "MY_NEWAPI_KEY" } },
    } },
  };
  await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
  let prepared = false;
  let writes = 0;
  const distribution = { ...videoCliDistribution,
    async openRuntimeHost() { return {
      async openCredentials() { return {
        async describeCredentials() { return [{ endpoint: "newapi.personal", slot: "apiKey", label: "API key", kind: "secret" as const,
          ref: { store: "env", key: "MY_NEWAPI_KEY" }, writable: false }]; },
        async credentials() { return [{ endpoint: "newapi.personal", slot: "apiKey", label: "API key", kind: "secret" as const,
          ref: { store: "env", key: "MY_NEWAPI_KEY" }, writable: false, configured: false }]; },
        async putCredential() { writes += 1; throw new Error("must not write env"); },
        async close() {},
      }; },
      async prepare() { prepared = true; return []; },
      async controller() { throw new Error("controller opened before credential audit"); },
    }; },
  } as unknown as typeof videoCliDistribution;
  await assert.rejects(
    () => runCli(["runtime", "up", profilePath, "--workspace", root], { write() {} }, distribution),
    /set MY_NEWAPI_KEY in the environment/u,
  );
  assert.equal(prepared, false);
  assert.equal(writes, 0);
  assert.deepEqual(JSON.parse(await readFile(profilePath, "utf8")), profile);
});

test("missing credential recovery asks only for a configured Profile's missing OSS secret", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypit-newapi-missing-oss-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const profilePath = join(root, "runtime.json");
  const starter = videoCliDistribution.initialRuntimeProfile as Profile;
  const profile = { ...starter, endpoints: { ...starter.endpoints, "newapi.personal": {
    ...starter.endpoints["newapi.personal"], config: {
      baseUrl: "https://gateway.example/v1", apiKey: { store: "platform", key: "api" },
      relayEndpoint: "https://oss.example", relayBucket: "bucket",
      relayAccessKeyId: { store: "platform", key: "ak" },
      relayAccessKeySecret: { store: "platform", key: "sk" },
    },
  } } };
  await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
  const stored = new Map([["apiKey", "existing-api-secret"], ["relayAccessKeyId", "existing-ak-secret"]]);
  const slots = ["apiKey", "relayAccessKeyId", "relayAccessKeySecret"];
  const promptedSlots: string[] = [];
  const output: string[] = [];
  const openedEndpoints: string[] = [];
  const describedEndpoints: string[] = [];
  let prepared = 0;
  let workerStarts = 0;
  const distribution = { ...videoCliDistribution,
    async openRuntimeHost() { return {
      async openCredentials(endpoint: string) {
        openedEndpoints.push(endpoint);
        return {
          async describeCredentials() { describedEndpoints.push(endpoint); return slots.map((slot) => ({ endpoint, slot, label: slot,
            kind: "secret" as const, ref: { store: "platform", key: slot }, writable: true })); },
          async credentials() { return slots.map((slot) => ({ endpoint, slot, label: slot,
            kind: "secret" as const, ref: { store: "platform", key: slot }, writable: true, configured: stored.has(slot) })); },
          async putCredential(_endpoint: string, slot: string, secret: string) { stored.set(slot, secret); },
          async close() {},
        };
      },
      async prepare() { prepared += 1; assert.equal(stored.get("relayAccessKeySecret"), "replacement-secret"); return []; },
      async createRuntime() { return { async close() {} }; },
      async controller() { return {
        programs: { async up() { return { programs: [] }; } },
        worker: { async up() { workerStarts += 1; return { state: "running" }; } },
      }; },
    }; },
  } as unknown as typeof videoCliDistribution;
  await runCli(["runtime", "up", profilePath, "--workspace", root], {
    write: (value: string) => { output.push(value); },
    writeProgress: (value: string) => { output.push(value); },
    readSecret: async (prompt: string) => { promptedSlots.push(prompt.slice(0, -2)); return "replacement-secret"; },
    inputIsTTY: true,
    terminal: { isTTY: true, color: false, unicode: true, columns: 100 },
  }, distribution);
  assert.deepEqual(promptedSlots, ["relayAccessKeySecret"]);
  assert.deepEqual([...new Set(openedEndpoints)], ["newapi.personal"]);
  assert.deepEqual(describedEndpoints, ["newapi.personal"]);
  assert.equal(prepared, 1);
  assert.equal(workerStarts, 1);
  assert.doesNotMatch(output.join("") + await readFile(profilePath, "utf8"), /replacement-secret/u);
});

test("missing credential cancellation or empty input prevents prepare and Worker startup", async (t) => {
  for (const answer of [undefined, "   "]) {
    const root = await mkdtemp(join(tmpdir(), "hypit-newapi-cancel-"));
    t.after(async () => await rm(root, { recursive: true, force: true }));
    const profilePath = join(root, "runtime.json");
    const starter = videoCliDistribution.initialRuntimeProfile as Profile;
    const profile = { ...starter, endpoints: { ...starter.endpoints, "newapi.personal": {
      ...starter.endpoints["newapi.personal"], config: { baseUrl: "https://gateway.example/v1",
        apiKey: { store: "platform", key: "api" } },
    } } };
    await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
    let prepared = 0;
    let workerStarts = 0;
    const distribution = { ...videoCliDistribution,
      async openRuntimeHost() { return {
        async openCredentials() { return {
          async describeCredentials() { return [{ endpoint: "newapi.personal", slot: "apiKey", label: "API key",
            kind: "secret" as const, ref: { store: "platform", key: "api" }, writable: true }]; },
          async credentials() { return [{ endpoint: "newapi.personal", slot: "apiKey", label: "API key",
            kind: "secret" as const, ref: { store: "platform", key: "api" }, writable: true, configured: false }]; },
          async putCredential() { throw new Error("cancelled input must not be written"); },
          async close() {},
        }; },
        async prepare() { prepared += 1; return []; },
        async controller() { return { programs: { async up() { return { programs: [] }; } },
          worker: { async up() { workerStarts += 1; return { state: "running" }; } } }; },
      }; },
    } as unknown as typeof videoCliDistribution;
    await assert.rejects(() => runCli(["runtime", "up", profilePath, "--workspace", root], {
      write() {}, readSecret: async () => answer as string,
      inputIsTTY: true,
      terminal: { isTTY: true, color: false, unicode: true, columns: 100 },
    }, distribution), /API key.*(?:cancelled|empty)/u);
    assert.equal(prepared, 0);
    assert.equal(workerStarts, 0);
    assert.deepEqual(JSON.parse(await readFile(profilePath, "utf8")), profile);
  }
});

test("a missing read-only non-env credential has stable source guidance", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypit-newapi-read-only-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const profilePath = join(root, "runtime.json");
  const starter = videoCliDistribution.initialRuntimeProfile as Profile;
  const profile = { ...starter, endpoints: { ...starter.endpoints, "newapi.personal": {
    ...starter.endpoints["newapi.personal"], config: { baseUrl: "https://gateway.example/v1",
      apiKey: { store: "vault", key: "private-key" } },
  } } };
  await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
  let prepared = 0;
  let workerStarts = 0;
  const distribution = { ...videoCliDistribution,
    async openRuntimeHost() { return {
      async openCredentials() { return {
        async describeCredentials() { return [{ endpoint: "newapi.personal", slot: "apiKey", label: "API key",
          kind: "secret" as const, ref: { store: "vault", key: "private-key" }, writable: false }]; },
        async credentials() { return [{ endpoint: "newapi.personal", slot: "apiKey", label: "API key",
          kind: "secret" as const, ref: { store: "vault", key: "private-key" }, writable: false, configured: false }]; },
        async putCredential() { throw new Error("read-only credential must not be written"); },
        async close() { throw new Error("store close failed"); },
      }; },
      async prepare() { prepared += 1; return []; },
      async controller() { return { programs: { async up() { return { programs: [] }; } },
        worker: { async up() { workerStarts += 1; return { state: "running" }; } } }; },
    }; },
  } as unknown as typeof videoCliDistribution;
  await assert.rejects(() => runCli(["runtime", "up", profilePath, "--workspace", root], {
    write() {},
  }, distribution), /API key is missing from its read-only credential source/u);
  assert.equal(prepared, 0);
  assert.equal(workerStarts, 0);
});

test("an incomplete env Profile never attempts to write its read-only key", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypit-newapi-env-first-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const profilePath = join(root, "runtime.json");
  const starter = videoCliDistribution.initialRuntimeProfile as Profile;
  const profile = { ...starter,
    credentials: { env: { use: "@hypit/credential-store-env" } },
    endpoints: { ...starter.endpoints, "newapi.personal": {
      ...starter.endpoints["newapi.personal"],
      config: { baseUrl: "", apiKey: { store: "env", key: "MY_NEWAPI_KEY" } },
    } },
  };
  await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
  let writes = 0;
  let prepared = false;
  const distribution = { ...videoCliDistribution,
    async openRuntimeHost() { return {
      async openCredentials() { return {
        async describeCredentials() { return [{ endpoint: "newapi.personal", slot: "apiKey", label: "API key", kind: "secret" as const,
          ref: { store: "env", key: "MY_NEWAPI_KEY" }, writable: false }]; },
        async credentials() { return [{ endpoint: "newapi.personal", slot: "apiKey", label: "API key", kind: "secret" as const,
          ref: { store: "env", key: "MY_NEWAPI_KEY" }, writable: false, configured: false }]; },
        async putCredential() { writes += 1; throw new Error("read-only credential"); },
        async close() {},
      }; },
      async prepare() { prepared = true; return []; },
      async controller() { throw new Error("controller opened before credential audit"); },
    }; },
  } as unknown as typeof videoCliDistribution;
  const answers = ["https://gateway.example/v1", "never-written-secret", "no"];
  await assert.rejects(
    () => runCli(["runtime", "up", profilePath, "--workspace", root], {
      write() {},
      readText: async () => answers.shift() ?? "",
      readSecret: async () => answers.shift() ?? "",
      inputIsTTY: true,
      terminal: { isTTY: true, color: false, unicode: true, columns: 100 },
    }, distribution),
    (error: Error) => {
      assert.match(error.message, /set MY_NEWAPI_KEY in the environment/u);
      assert.doesNotMatch(error.message, /never-written-secret/u);
      return true;
    },
  );
  assert.equal(writes, 0);
  assert.equal(prepared, false);
  const saved = await readFile(profilePath, "utf8");
  assert.match(saved, /gateway\.example/u);
  assert.doesNotMatch(saved, /never-written-secret/u);
});

test("up does not prepare until a credential write is observable", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypit-newapi-audit-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const profilePath = join(root, "runtime.json");
  const starter = videoCliDistribution.initialRuntimeProfile as Profile;
  const profile = { ...starter, endpoints: { ...starter.endpoints, "newapi.personal": {
    ...starter.endpoints["newapi.personal"],
    config: { ...starter.endpoints["newapi.personal"].config, baseUrl: "https://gateway.example/v1" },
  } } };
  await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
  let prepared = false;
  const distribution = { ...videoCliDistribution,
    async openRuntimeHost() { return {
      async openCredentials() { return {
        async describeCredentials() { return [{ endpoint: "newapi.personal", slot: "apiKey", label: "API key", kind: "secret" as const,
          ref: { store: "platform", key: "newapi.personal.api-key" }, writable: true }]; },
        async credentials() { return [{ endpoint: "newapi.personal", slot: "apiKey", label: "API key", kind: "secret" as const,
          ref: { store: "platform", key: "newapi.personal.api-key" }, writable: true, configured: false }]; },
        async putCredential() { return; },
        async close() {},
      }; },
      async prepare() { prepared = true; return []; },
      async controller() { throw new Error("controller opened before credential audit"); },
    }; },
  } as unknown as typeof videoCliDistribution;
  await assert.rejects(
    () => runCli(["runtime", "up", profilePath, "--workspace", root], {
      write() {}, readSecret: async () => "private-test-key",
      inputIsTTY: true,
      terminal: { isTTY: true, color: false, unicode: true, columns: 100 },
    }, distribution),
    (error: Error) => {
      assert.match(error.message, /credential.*not configured/u);
      assert.doesNotMatch(error.message, /private-test-key/u);
      return true;
    },
  );
  assert.equal(prepared, false);
});

test("credential status errors after storage never reveal the supplied secret", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypit-newapi-status-error-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const profilePath = join(root, "runtime.json");
  const starter = videoCliDistribution.initialRuntimeProfile as Profile;
  const profile = { ...starter, endpoints: { ...starter.endpoints, "newapi.personal": {
    ...starter.endpoints["newapi.personal"], config: { baseUrl: "https://gateway.example/v1",
      apiKey: { store: "platform", key: "api" } },
  } } };
  await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
  let stored = "";
  let prepared = 0;
  const distribution = { ...videoCliDistribution,
    async openRuntimeHost() { return {
      async openCredentials() { return {
        async describeCredentials() { return [{ endpoint: "newapi.personal", slot: "apiKey", label: "API key",
          kind: "secret" as const, ref: { store: "platform", key: "api" }, writable: true }]; },
        async credentials() {
          if (stored) throw new Error(`store status failed for ${stored}`);
          return [{ endpoint: "newapi.personal", slot: "apiKey", label: "API key",
            kind: "secret" as const, ref: { store: "platform", key: "api" }, writable: true, configured: false }];
        },
        async putCredential(_endpoint: string, _slot: string, secret: string) { stored = secret; },
        async close() {},
      }; },
      async prepare() { prepared += 1; return []; },
      async controller() { throw new Error("controller opened before credential audit"); },
    }; },
  } as unknown as typeof videoCliDistribution;
  await assert.rejects(() => runCli(["runtime", "up", profilePath, "--workspace", root], {
    write() {}, readSecret: async () => "replacement-secret",
    inputIsTTY: true,
    terminal: { isTTY: true, color: false, unicode: true, columns: 100 },
  }, distribution), (error: Error) => {
    assert.doesNotMatch(error.message, /replacement-secret/u);
    return true;
  });
  assert.equal(prepared, 0);
  assert.doesNotMatch(await readFile(profilePath, "utf8"), /replacement-secret/u);
});

test("credential control close errors after storage never reveal the supplied secret", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "hypit-newapi-close-error-"));
  t.after(async () => await rm(root, { recursive: true, force: true }));
  const profilePath = join(root, "runtime.json");
  const starter = videoCliDistribution.initialRuntimeProfile as Profile;
  const profile = { ...starter, endpoints: { ...starter.endpoints, "newapi.personal": {
    ...starter.endpoints["newapi.personal"], config: { baseUrl: "https://gateway.example/v1",
      apiKey: { store: "platform", key: "api" } },
  } } };
  await writeFile(profilePath, `${JSON.stringify(profile)}\n`);
  let stored = "";
  let prepared = 0;
  const distribution = { ...videoCliDistribution,
    async openRuntimeHost() { return {
      async openCredentials() { return {
        async describeCredentials() { return [{ endpoint: "newapi.personal", slot: "apiKey", label: "API key",
          kind: "secret" as const, ref: { store: "platform", key: "api" }, writable: true }]; },
        async credentials() { return [{ endpoint: "newapi.personal", slot: "apiKey", label: "API key",
          kind: "secret" as const, ref: { store: "platform", key: "api" }, writable: true, configured: !!stored }]; },
        async putCredential(_endpoint: string, _slot: string, secret: string) { stored = secret; },
        async close() { if (stored) throw new Error(`store close failed for ${stored}`); },
      }; },
      async prepare() { prepared += 1; return []; },
      async controller() { throw new Error("controller opened before credential audit"); },
    }; },
  } as unknown as typeof videoCliDistribution;
  await assert.rejects(() => runCli(["runtime", "up", profilePath, "--workspace", root], {
    write() {}, readSecret: async () => "replacement-secret",
    inputIsTTY: true,
    terminal: { isTTY: true, color: false, unicode: true, columns: 100 },
  }, distribution), (error: Error) => {
    assert.doesNotMatch(error.message, /replacement-secret/u);
    return true;
  });
  assert.equal(prepared, 0);
  assert.doesNotMatch(await readFile(profilePath, "utf8"), /replacement-secret/u);
});
