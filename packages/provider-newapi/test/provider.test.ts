import assert from "node:assert/strict";
import test from "node:test";

import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import { gptImageEndpoints, sealGptImage2Request } from "@hypit/gpt-image";
import { minimaxH3Endpoints, sealMinimaxH3Request } from "@hypit/minimax-h3";
import type { CanonicalValue, Need } from "@hypit/protocol";
import { generationTypes } from "@hypit/generation";
import { sealSeedanceRequest, seedanceEndpointsByModel } from "@hypit/seedance";
import { credentialRef } from "@hypit/runtime";

import { createNewApiProvider } from "../src/provider.js";

const credentials = { apiKey: { secret: "test-newapi-key" } };

function need(capability: Need["capability"], returns: Need["returns"], constraints: unknown, id = "test"): Need {
  return { id: `need:${id}`, capability, returns, constraints: constraints as CanonicalValue, result: `record:${id}` };
}

type ProviderOptions = NonNullable<Parameters<typeof createNewApiProvider>[0]>;

async function resolved(request: Need, fetcher: typeof fetch, publish?: ProviderOptions["publish"]) {
  const registry = new EndpointRegistry();
  await createNewApiProvider({
    baseUrl: "https://newapi.example/v1",
    apiKey: credentialRef("platform", "newapi.key"),
    fetch: fetcher,
    pollIntervalMs: 1,
    ...(publish === undefined ? {} : { publish }),
  }).install(registry);
  const resolution = registry.resolve(request);
  assert.equal(resolution.status, "resolved");
  return resolution.registration;
}

test("registers four immediate image models and five asynchronous video models", () => {
  const provider = createNewApiProvider({
    baseUrl: "https://newapi.example/v1",
    apiKey: credentialRef("platform", "newapi.key"),
  });
  assert.equal(provider.offers.length, 9);
  assert.equal(provider.offers.filter((offer) => offer.returns.name === generationTypes.imageSet.name).length, 4);
  assert.equal(provider.offers.filter((offer) => offer.returns.name === generationTypes.videoSet.name).length, 5);
});

test("text-only image generation needs no OSS and stores base64 output", async () => {
  const request = need(gptImageEndpoints.image!.capability, generationTypes.imageSet, sealGptImage2Request({
    prompt: ["black coffee on a table"], aspectRatio: ["1:1"], resolution: ["1K"], background: ["opaque"],
  }), "image");
  let requested = "";
  const registration = await resolved(request, async (input, init) => {
    requested = String(input);
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    assert.equal(body.model, "LingShan-G2");
    assert.equal(body.prompt, "black coffee on a table");
    return Response.json({ data: [{ b64_json: Buffer.from([1, 2, 3]).toString("base64") }] });
  });
  assert.equal(registration.kind, "immediate");
  const resources = new MemoryResourceStore();
  const output = await registration.handler({
    command: { kind: "fulfill-need", id: "command:image", need: request },
    need: request, resources, credentials,
  });
  assert.equal(requested, "https://newapi.example/v1/images/generations");
  assert.equal(output.value.kind, "inline");
});

test("reference media without OSS fails before submitting a paid request", async () => {
  const resources = new MemoryResourceStore();
  const artifact = await resources.put(new Uint8Array([1, 2, 3]), "image/png");
  const request = need(gptImageEndpoints.image!.capability, generationTypes.imageSet, sealGptImage2Request({
    prompt: ["replace product"], images: [{ role: "image", artifact }], aspectRatio: ["1:1"], resolution: ["1K"], background: ["opaque"],
  }), "reference");
  let calls = 0;
  const registration = await resolved(request, async () => { calls += 1; return Response.json({}); });
  assert.equal(registration.kind, "immediate");
  await assert.rejects(async () => await registration.handler({
    command: { kind: "fulfill-need", id: "command:reference", need: request },
    need: request, resources, credentials,
  }), /reference media requires an OSS relay configuration/u);
  assert.equal(calls, 0);
});

test("video request publishes references, sets human review, polls and collects", async () => {
  const resources = new MemoryResourceStore();
  const artifact = await resources.put(new Uint8Array([7, 8]), "image/png");
  const request = need(seedanceEndpointsByModel["seedance-2-mini"].capability, generationTypes.videoSet, sealSeedanceRequest("seedance-2-mini", {
    prompt: ["slow camera move"],
    referenceImage: [{ role: "image", artifact, fields: { personReference: true } }],
    resolution: ["720p"], aspectRatio: ["16:9"], duration: [6], generateAudio: [false], webSearch: [false],
  }), "video");
  const calls: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input); calls.push(url);
    if (url.endsWith("/video/generations")) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.model, "seedance-2.0-mini");
      assert.equal((body.metadata as Record<string, unknown>).human_review, true);
      return Response.json({ data: { task_id: "video-1" } });
    }
    if (url.endsWith("/video/generations/video-1")) return Response.json({ data: { status: "completed", result_url: "https://assets.example/result.mp4" } });
    if (url === "https://assets.example/result.mp4") return new Response(new Uint8Array([9, 9]), { headers: { "content-type": "video/mp4" } });
    throw new Error(`unexpected ${url}`);
  };
  const registration = await resolved(request, fetcher, async () => "https://relay.example/reference.png");
  assert.equal(registration.kind, "asynchronous");
  const context = { command: { kind: "fulfill-need", id: "command:video", need: request } as const, need: request, resources, credentials, operation: "operation:video" };
  const started = await registration.endpoint.start(context);
  assert.equal(started.status, "pending");
  if (started.status !== "pending") return;
  const ready = await registration.endpoint.poll({ ...context, handle: started.handle! });
  assert.equal(ready.status, "ready");
  if (ready.status !== "ready") return;
  const completed = await registration.endpoint.collect!({ ...context, handle: ready.handle });
  assert.equal(completed.status, "completed");
  assert.deepEqual(calls, [
    "https://newapi.example/v1/video/generations",
    "https://newapi.example/v1/video/generations/video-1",
    "https://assets.example/result.mp4",
  ]);
});

test("video failure redacts URLs returned by NewAPI", async () => {
  const request = need(seedanceEndpointsByModel["seedance-2-mini"].capability, generationTypes.videoSet, sealSeedanceRequest("seedance-2-mini", {
    prompt: ["coffee steam"], resolution: ["720p"], aspectRatio: ["16:9"], duration: [6], generateAudio: [false], webSearch: [false],
  }), "failure");
  const registration = await resolved(request, async (input) => String(input).endsWith("/video/generations")
    ? Response.json({ id: "video-fail" })
    : Response.json({ status: "failed", fail_reason: "bad source https://private.example/signed?token=secret" }));
  assert.equal(registration.kind, "asynchronous");
  const context = { command: { kind: "fulfill-need", id: "command:failure", need: request } as const, need: request, resources: new MemoryResourceStore(), credentials, operation: "operation:failure" };
  const started = await registration.endpoint.start(context);
  assert.equal(started.status, "pending");
  if (started.status !== "pending") return;
  const failed = await registration.endpoint.poll({ ...context, handle: started.handle! });
  assert.equal(failed.status, "failed");
  const message = failed.status === "failed" ? failed.failure.message : "";
  assert.match(message, /\[redacted-url\]/u);
  assert.doesNotMatch(message, /private\.example|token=secret/u);
});

test("MiniMax H3 leaves optional resolution and ratio absent instead of inventing dimensions", async () => {
  const request = need(minimaxH3Endpoints.video!.capability, generationTypes.videoSet, sealMinimaxH3Request({
    prompt: ["coffee beans falling in slow motion"], duration: [6],
  }), "minimax");
  let submitted: Record<string, unknown> | undefined;
  const registration = await resolved(request, async (_input, init) => {
    submitted = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return Response.json({ id: "minimax-1" });
  });
  assert.equal(registration.kind, "asynchronous");
  const outcome = await registration.endpoint.start({
    command: { kind: "fulfill-need", id: "command:minimax", need: request }, need: request,
    resources: new MemoryResourceStore(), credentials, operation: "operation:minimax",
  });
  assert.equal(outcome.status, "pending");
  assert.equal(submitted?.model, "MiniMax-H3");
  assert.equal("width" in (submitted ?? {}), false);
  assert.equal("height" in (submitted ?? {}), false);
  assert.equal("resolution" in ((submitted?.metadata ?? {}) as Record<string, unknown>), false);
  assert.equal("ratio" in ((submitted?.metadata ?? {}) as Record<string, unknown>), false);
});
