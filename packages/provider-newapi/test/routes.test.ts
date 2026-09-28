import assert from "node:assert/strict";
import test from "node:test";

import { assertMappingCoversPorts } from "@hypit/generation";
import type { CanonicalValue } from "@hypit/protocol";
import { gptImage2Ports, sealGptImage2Request } from "@hypit/gpt-image";
import { minimaxH3Ports } from "@hypit/minimax-h3";
import { nanoBananaPorts } from "@hypit/nano-banana";
import { sealSeedanceRequest, seedancePorts } from "@hypit/seedance";
import { seedream5LitePorts } from "@hypit/seedream";

import { newApiMappings } from "../src/mapping.js";
import { newApiRouteForCapability } from "../src/routes.js";

const expectedModels = new Map([
  ["@hypit/gpt-image@1#gpt-image-2", "LingShan-G2"],
  ["@hypit/nano-banana@1#nano-banana-2", "LingShan-NB-2"],
  ["@hypit/nano-banana@1#nano-banana-pro", "LingShan-NB-Pro"],
  ["@hypit/seedream@1#seedream-5-lite", "seedream-5.0-lite"],
  ["@hypit/seedance@1#seedance-2", "seedance-2.0"],
  ["@hypit/seedance@1#seedance-2-fast", "seedance-2.0-fast"],
  ["@hypit/seedance@1#seedance-2-mini", "seedance-2.0-mini"],
  ["@hypit/seedance@1#seedance-2.5", "seedance-2.5"],
  ["@hypit/minimax-h3@1#minimax-h3", "MiniMax-H3"],
]);

const tables = {
  "gpt-image-2": gptImage2Ports,
  ...nanoBananaPorts,
  "seedream-5-lite": seedream5LitePorts,
  ...seedancePorts,
  "minimax-h3": minimaxH3Ports,
};

test("NewAPI maps every Hypit model supported by DramaClaw", () => {
  assert.equal(newApiMappings.length, expectedModels.size);
  for (const mapping of newApiMappings) {
    const key = `${mapping.capability.module.name}@${mapping.capability.module.version}#${mapping.capability.name}`;
    assert.equal(mapping.routes[0]?.model, expectedModels.get(key), key);
    assertMappingCoversPorts(tables[mapping.capability.name as keyof typeof tables], mapping);
  }
  assert.deepEqual(new Set(newApiMappings.map((mapping) =>
    `${mapping.capability.module.name}@${mapping.capability.module.version}#${mapping.capability.name}`)), new Set(expectedModels.keys()));
});

const constraints = (value: unknown) => value as CanonicalValue;

test("NewAPI rejects GPT Image ratios outside the DramaClaw model catalog", () => {
  const route = newApiRouteForCapability({ module: { name: "@hypit/gpt-image", version: "1" }, name: "gpt-image-2" });
  assert.ok(route);
  const request = sealGptImage2Request({ prompt: ["coffee"], aspectRatio: ["auto"], resolution: ["1K"], background: ["opaque"] });
  assert.equal(route.supports({ capability: route.capability, returns: route.returns, constraints: constraints(request) }).status, "unsupported");
});

test("NewAPI translates Seedance 2.5 adaptive framing to the gateway auto ratio", async () => {
  const route = newApiRouteForCapability({ module: { name: "@hypit/seedance", version: "1" }, name: "seedance-2.5" });
  assert.ok(route);
  const request = sealSeedanceRequest("seedance-2.5", {
    prompt: ["slow push in"],
    resolution: ["1080p"],
    aspectRatio: ["adaptive"],
    duration: [8],
    generateAudio: [true],
    webSearch: [false],
  });
  assert.deepEqual(await route.prepare(constraints(request)).compile(async () => "https://example.test/reference"), {
    prompt: "slow push in",
    resolution: "1080p",
    aspect_ratio: "auto",
    seconds: 8,
    generate_audio: true,
    web_search: false,
  });
});
