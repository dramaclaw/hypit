import assert from "node:assert/strict";
import test from "node:test";

import { newApiDefaultBindings } from "@dramaclaw/provider-newapi";
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
  assert.deepEqual(progress, []);
});
