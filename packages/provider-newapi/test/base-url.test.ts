import assert from "node:assert/strict";
import test from "node:test";

import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import { generationTypes } from "@hypit/generation";
import { gptImageEndpoints, sealGptImage2Request } from "@hypit/gpt-image";
import { minimaxH3Endpoints, sealMinimaxH3Request } from "@hypit/minimax-h3";
import type { CanonicalValue, Need } from "@hypit/protocol";

import { testNewApiSetupConnection } from "../src/connection-test.js";
import { createNewApiProvider } from "../src/provider.js";
import { completeNewApiSetup, validateNewApiSetupUrl } from "../src/setup.js";

const cases = [
  ["https://gateway.example", "https://gateway.example/v1"],
  [" https://gateway.example/// ", "https://gateway.example/v1"],
  ["https://gateway.example/v1///", "https://gateway.example/v1"],
  ["https://gateway.example/custom/api/", "https://gateway.example/custom/api"],
  ["http://localhost:8780/", "http://localhost:8780/v1"],
  ["http://127.0.0.1:8780", "http://127.0.0.1:8780/v1"],
  ["http://[::1]:8780/", "http://[::1]:8780/v1"],
] as const;

for (const [baseUrl, expected] of cases) {
  test(`setup and model discovery normalize ${baseUrl}`, async () => {
    const input = { baseUrl, apiKey: "test-key", relay: { enabled: true as const,
      endpoint: "oss.example", bucket: "test-bucket", accessKeyId: "test-id", accessKeySecret: "test-secret" } };
    const setup = completeNewApiSetup(input);
    assert.equal((setup.config as Record<string, unknown>).baseUrl, expected);
    let requested = "";
    await testNewApiSetupConnection(input, {
      fetch: async (url) => {
        if (String(url) === "https://oss.example/probe") return new Response("HY");
        requested = String(url); return Response.json({ data: [{ id: "model" }] });
      },
      createOssClient: () => ({ put: async () => {}, signatureUrl: () => "https://oss.example/probe", delete: async () => {} }),
      randomUUID: () => "00000000-0000-4000-8000-000000000001",
    });
    assert.equal(requested, `${expected}/models`);
    assert.equal(validateNewApiSetupUrl(expected), expected);
  });

  test(`image generation and video polling normalize ${baseUrl}`, async () => {
    const urls: string[] = [];
    const registry = new EndpointRegistry();
    await createNewApiProvider({ baseUrl, fetch: async (url, init) => {
      urls.push(String(url));
      if (String(url).endsWith("/images/generations")) {
        return Response.json({ data: [{ b64_json: Buffer.from("89504e470d0a1a0a", "hex").toString("base64") }] });
      }
      return Response.json(init?.method === "POST" ? { id: "task-1" } : { status: "processing" });
    } }).install(registry);
    const image: Need = { id: "need:image", result: "record:image", capability: gptImageEndpoints.image!.capability,
      returns: generationTypes.imageSet, constraints: sealGptImage2Request({ prompt: ["coffee"], aspectRatio: ["1:1"],
        resolution: ["1K"], background: ["opaque"] }) as CanonicalValue };
    const video: Need = { id: "need:video", result: "record:video", capability: minimaxH3Endpoints.video!.capability,
      returns: generationTypes.videoSet, constraints: sealMinimaxH3Request({ prompt: ["coffee"], duration: [6] }) as CanonicalValue };
    const resources = new MemoryResourceStore();
    const credentials = { apiKey: { secret: "test-key" } };
    const imageResolution = registry.resolve(image);
    assert.equal(imageResolution.status, "resolved");
    const imageRegistration = imageResolution.registration;
    assert.equal(imageRegistration.kind, "immediate");
    await imageRegistration.handler({ command: { kind: "fulfill-need", id: "command:image", need: image }, need: image, resources, credentials });
    const videoResolution = registry.resolve(video);
    assert.equal(videoResolution.status, "resolved");
    const videoRegistration = videoResolution.registration;
    assert.equal(videoRegistration.kind, "asynchronous");
    const context = { command: { kind: "fulfill-need", id: "command:video", need: video } as const,
      need: video, resources, credentials, operation: "operation:video" };
    const started = await videoRegistration.endpoint.start(context);
    assert.equal(started.status, "pending");
    if (started.status === "pending") await videoRegistration.endpoint.poll({ ...context, handle: started.handle! });
    assert.deepEqual(urls, [`${expected}/images/generations`, `${expected}/video/generations`, `${expected}/video/generations/task-1`]);
  });
}

test("setup and provider reject credentials in base URLs", () => {
  const baseUrl = "https://user:secret@gateway.example";
  assert.throws(() => validateNewApiSetupUrl(baseUrl), /must not contain credentials/u);
  assert.throws(() => createNewApiProvider({ baseUrl }), /must not contain credentials/u);
});

test("setup and provider reject query parameters and fragments, including empty ones", () => {
  for (const baseUrl of ["https://gateway.example?key=secret", "https://gateway.example/v1#secret",
    "https://gateway.example?", "https://gateway.example/v1#"]) {
    assert.throws(() => validateNewApiSetupUrl(baseUrl), /must not contain a query or fragment/u);
    assert.throws(() => createNewApiProvider({ baseUrl }), /must not contain a query or fragment/u);
  }
});
