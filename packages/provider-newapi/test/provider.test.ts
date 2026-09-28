import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import { gptImageEndpoints, sealGptImage2Request } from "@hypit/gpt-image";
import { minimaxH3Endpoints, sealMinimaxH3Request } from "@hypit/minimax-h3";
import type { CanonicalValue, Need } from "@hypit/protocol";
import { generationTypes } from "@hypit/generation";
import { sealSeedanceRequest, seedanceEndpointsByModel } from "@hypit/seedance";
import { credentialRef } from "@hypit/runtime";
import { nanoBananaEndpoints, sealNanoBananaRequest } from "@hypit/nano-banana";
import { sealSeedreamRequest, seedreamEndpoints } from "@hypit/seedream";

import { createNewApiProvider } from "../src/provider.js";
import { newApiRoutes } from "../src/routes.js";

const credentials = { apiKey: { secret: "test-newapi-key" } };
const png = Buffer.from("89504e470d0a1a0a", "hex");

const imageCases = [
  { model: "LingShan-G2", capability: "gpt-image-2", ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "4:5", "5:4", "21:9"] },
  { model: "LingShan-NB-2", capability: "nano-banana-2", ratios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "21:9", "5:4", "4:5", "1:4", "4:1", "1:8", "8:1"] },
  { model: "LingShan-NB-Pro", capability: "nano-banana-pro", ratios: ["1:1", "9:16", "16:9", "4:3", "3:4", "2:3", "3:2", "5:4", "4:5", "21:9"] },
  { model: "seedream-5.0-lite", capability: "seedream-5-lite", ratios: ["1:1", "16:9", "9:16", "3:2", "3:4", "21:9", "2:3", "4:3"] },
] as const;

for (const item of imageCases) for (const ratio of item.ratios) {
  for (const quality of item.capability === "seedream-5-lite" ? ["basic", "high"] : ["1K", "2K", "4K"]) {
    test(`${item.model} ${ratio} ${quality} submits geometry within catalog constraints`, async () => {
      const route = newApiRoutes.find((route) => route.capability.name === item.capability)!;
      const base = { prompt: ["coffee"], aspectRatio: [ratio] };
      const constraints = item.capability === "seedream-5-lite" ? sealSeedreamRequest({ ...base, quality: [quality], outputFormat: ["png"], nsfwCheck: [true] })
        : item.capability === "gpt-image-2" ? sealGptImage2Request({ ...base, resolution: [quality], background: ["opaque"] })
          : sealNanoBananaRequest(item.capability, { ...base, resolution: [quality], outputFormat: ["png"] });
      const request = need(route.capability, route.returns, constraints);
      let calls = 0;
      const registration = await resolved(request, async (_url, init) => {
        calls += 1;
        const body = JSON.parse(String(init?.body));
        const { width, height } = body;
        assert.equal(body.model, item.model);
        assert.ok(width * height >= (item.capability === "seedream-5-lite" ? 3_686_400 : 655_360), `${width}x${height} below minimum`);
        assert.ok(width * height <= 8_294_400, `${width}x${height} above maximum`);
        assert.ok(Math.max(width, height) <= 3840);
        assert.equal(width % 16, 0); assert.equal(height % 16, 0);
        const [rw, rh] = ratio.split(":").map(Number);
        assert.ok(Math.abs(width / height / (rw! / rh!) - 1) < 0.06, "must preserve ratio");
        return Response.json({ data: [{ b64_json: png.toString("base64") }] });
      });
      assert.equal(registration.kind, "immediate");
      await registration.handler({ command: { kind: "fulfill-need", id: "command:test", need: request },
        need: request, resources: new MemoryResourceStore(), credentials });
      assert.equal(calls, 1);
    });
  }
}

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
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
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

const allCredentials = { ...credentials, relayAccessKeyId: { secret: "test-oss-ak" }, relayAccessKeySecret: { secret: "test-oss-sk" } };
const reflected = "upload test-newapi-key test-oss-ak test-oss-sk https://private.example/file?signature=hidden";
function assertRedacted(value: unknown) {
  const printed = inspect(value, { depth: 20 });
  assert.doesNotMatch(printed, /test-newapi-key|test-oss-ak|test-oss-sk|private\.example|signature=hidden/u);
  assert.match(printed, /redacted/u);
}

for (const stage of ["upload", "download", "upstream"] as const) {
  test(`image ${stage} errors redact credentials, URLs and nested causes`, async () => {
    const resources = new MemoryResourceStore();
    const artifact = await resources.put(png, "image/png");
    const request = need(gptImageEndpoints.image!.capability, generationTypes.imageSet, sealGptImage2Request({
      prompt: ["coffee"], aspectRatio: ["1:1"], resolution: ["1K"], background: ["opaque"],
      ...(stage === "upload" ? { images: [{ role: "image", artifact }] } : {}),
    }));
    const registration = await resolved(request, async (url) => {
      if (stage === "upstream") return Response.json({ error: { message: reflected } }, { status: 400 });
      if (String(url).includes("/images/")) return Response.json({ data: [{ url: "https://asset.example/result" }] });
      throw new Error(reflected, { cause: new Error(reflected) });
    }, async () => { throw new Error(reflected, { cause: new Error(reflected) }); });
    assert.equal(registration.kind, "immediate");
    await assert.rejects(async () => await registration.handler({ command: { kind: "fulfill-need", id: "command:test", need: request },
      need: request, resources, credentials: allCredentials }), (error: Error) => {
      assertRedacted(error); assert.equal(error.cause, undefined); return true;
    });
  });
}

for (const status of [429, 503]) for (const json of [true, false]) {
  test(`video poll retries ${status} ${json ? "JSON" : "text"} with Retry-After then succeeds`, async () => {
    const request = need(minimaxH3Endpoints.video!.capability, generationTypes.videoSet, sealMinimaxH3Request({ prompt: ["coffee"], duration: [6] }));
    let polls = 0;
    const registration = await resolved(request, async (_url, init) => {
      if (init?.method === "POST") return Response.json({ id: "retry" });
      if (++polls === 1) return new Response(json ? JSON.stringify({ error: { message: reflected } }) : "unavailable", { status, headers: { "retry-after": "2" } });
      return Response.json({ status: "completed", result_url: "https://asset.example/video.mp4" });
    });
    assert.equal(registration.kind, "asynchronous");
    const context = { command: { kind: "fulfill-need", id: "command:test", need: request } as const, need: request,
      resources: new MemoryResourceStore(), credentials: allCredentials, operation: "operation:test" };
    const started = await registration.endpoint.start(context);
    assert.equal(started.status, "pending"); if (started.status !== "pending") return;
    const before = Date.now();
    const retry = await registration.endpoint.poll({ ...context, handle: started.handle! });
    assert.equal(retry.status, "pending"); if (retry.status !== "pending") return;
    assert.ok(retry.wakeAt! >= before + 2000);
    const ready = await registration.endpoint.poll({ ...context, handle: retry.handle! });
    assert.equal(ready.status, "ready");
  });
}

for (const phase of ["start", "poll", "collect"] as const) {
  test(`video ${phase} redacts reflected credentials and URLs`, async () => {
    const request = need(minimaxH3Endpoints.video!.capability, generationTypes.videoSet, sealMinimaxH3Request({ prompt: ["coffee"], duration: [6] }));
    const registration = await resolved(request, async (_url, init) => {
      if (init?.method === "POST") return phase === "start" ? Response.json({ error: reflected }, { status: 400 }) : Response.json({ id: "safe-task" });
      if (String(_url).includes("/video/generations/")) return phase === "poll"
        ? Response.json({ status: "failed", fail_reason: reflected })
        : Response.json({ status: "completed", result_url: "https://asset.example/video.mp4" });
      throw new Error(reflected, { cause: new Error(reflected) });
    });
    assert.equal(registration.kind, "asynchronous");
    const context = { command: { kind: "fulfill-need", id: "command:test", need: request } as const, need: request,
      resources: new MemoryResourceStore(), credentials: allCredentials, operation: "operation:test" };
    let outcome = await registration.endpoint.start(context);
    if (phase !== "start") {
      assert.equal(outcome.status, "pending"); if (outcome.status !== "pending") return;
      outcome = await registration.endpoint.poll({ ...context, handle: outcome.handle! });
      if (phase === "collect") {
        assert.equal(outcome.status, "ready"); if (outcome.status !== "ready") return;
        outcome = await registration.endpoint.collect!({ ...context, handle: outcome.handle });
      }
    }
    assert.equal(outcome.status, "failed"); assertRedacted(outcome);
  });
}

for (const format of ["jpg", "jpeg", "png"] as const) {
  test(`base64 ${format} response retains its detected image media type`, async () => {
    const jpeg = Buffer.from("ffd8ffe000104a464946", "hex");
    const seedream = format === "jpeg";
    const constraints = seedream ? sealSeedreamRequest({ prompt: ["coffee"], aspectRatio: ["1:1"], quality: ["basic"], outputFormat: [format], nsfwCheck: [true] })
      : sealNanoBananaRequest("nano-banana-2", { prompt: ["coffee"], aspectRatio: ["1:1"], resolution: ["1K"], outputFormat: [format] });
    const request = need(seedream ? seedreamEndpoints.image!.capability : nanoBananaEndpoints.v2!.capability, generationTypes.imageSet, constraints);
    const registration = await resolved(request, async (_url, init) => {
      assert.equal(JSON.parse(String(init?.body)).output_format, format);
      return Response.json({ data: [{ b64_json: (format === "png" ? png : jpeg).toString("base64") }] });
    });
    assert.equal(registration.kind, "immediate");
    const result = await registration.handler({ command: { kind: "fulfill-need", id: "command:test", need: request },
      need: request, resources: new MemoryResourceStore(), credentials });
    assert.match(JSON.stringify(result), new RegExp(format === "png" ? "image/png" : "image/jpeg"));
  });
}

test("Seedream fixed safety accepts true without inventing HTTP fields and rejects false before upload", async () => {
  let calls = 0;
  const registry = new EndpointRegistry();
  await createNewApiProvider({ baseUrl: "https://newapi.example/v1", fetch: async (_url, init) => {
    calls += 1;
    const body = JSON.parse(String(init?.body));
    assert.equal(body.model, "seedream-5.0-lite");
    assert.equal(body.prompt, "coffee");
    assert.equal(body.output_format, "png");
    assert.equal(body.metadata.resolution, "2k");
    assert.equal(Object.hasOwn(body, "nsfw_check"), false);
    assert.equal(Object.hasOwn(body.metadata, "nsfw_check"), false);
    return Response.json({ data: [{ b64_json: png.toString("base64") }] });
  }, publish: async () => { throw new Error("must not upload"); } }).install(registry);
  const route = newApiRoutes.find((item) => item.capability.name === "seedream-5-lite")!;
  for (const nsfwCheck of [true, false]) {
    const constraints = sealSeedreamRequest({ prompt: ["coffee"], aspectRatio: ["16:9"], quality: ["basic"], outputFormat: ["png"], nsfwCheck: [nsfwCheck] });
    const request = need(route.capability, route.returns, constraints);
    if (!nsfwCheck) {
      const support = route.supports({ capability: route.capability, returns: route.returns, constraints: request.constraints });
      assert.equal(support.status, "unsupported");
      assert.match(JSON.stringify(support), /safety.*cannot be disabled/u);
      assert.throws(() => route.prepare(request.constraints), /safety.*cannot be disabled/u);
      assert.notEqual(registry.resolve(request).status, "resolved");
    } else {
      const resolution = registry.resolve(request);
      assert.equal(resolution.status, "resolved");
      assert.equal(resolution.registration.kind, "immediate");
      await resolution.registration.handler({ command: { kind: "fulfill-need", id: "command:test", need: request },
        need: request, resources: new MemoryResourceStore(), credentials });
    }
  }
  assert.equal(calls, 1);
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
