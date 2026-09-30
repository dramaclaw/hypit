import assert from "node:assert/strict";
import test from "node:test";

import { newApiRoutes } from "../src/routes.js";
import { completeNewApiSetup, inspectNewApiSetup, newApiDefaultBindings } from "../src/setup.js";

test("the setup core owns exactly the ten NewAPI default bindings", () => {
  assert.equal(Object.keys(newApiDefaultBindings).length, 10);
  assert.deepEqual(new Set(Object.keys(newApiDefaultBindings)), new Set(newApiRoutes.map((route) => route.key)));
  assert.deepEqual(new Set(Object.values(newApiDefaultBindings)), new Set(["newapi.personal"]));
  assert.equal(
    newApiDefaultBindings["@hypit/mimo-speech@1#mimo-v2.5-tts-voiceclone"],
    "newapi.personal",
  );
});

test("setup inspection requires a nonblank baseUrl", () => {
  assert.deepEqual(inspectNewApiSetup(null), { configured: false, missing: ["baseUrl"] });
  assert.deepEqual(inspectNewApiSetup({ baseUrl: "  " }), { configured: false, missing: ["baseUrl"] });
  assert.deepEqual(inspectNewApiSetup({ baseUrl: " https://gateway.example/v1 " }), { configured: true, missing: [] });
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
  assert.deepEqual(result.config, {
    baseUrl: "https://gateway.example/v1",
    apiKey: { store: "platform", key: "newapi.personal.api-key" },
    relayEndpoint: "oss-cn-chengdu.aliyuncs.com",
    relayBucket: "team-relay",
    relayAccessKeyId: { store: "platform", key: "newapi.personal.oss-ak" },
    relayAccessKeySecret: { store: "platform", key: "newapi.personal.oss-sk" },
    relayTtlSeconds: 3600,
  });
  assert.deepEqual(result.credentials, [
    { slot: "apiKey", secret: "newapi-key" },
    { slot: "relayAccessKeyId", secret: "ak" },
    { slot: "relayAccessKeySecret", secret: "sk" },
  ]);
  assert.doesNotMatch(JSON.stringify(result.config), /newapi-key|"ak"|"sk"/u);
});

test("setup accepts HTTPS and loopback HTTP, trimming outer whitespace and trailing slashes", () => {
  const base = { apiKey: "key", relay: { enabled: false as const } };
  assert.equal((completeNewApiSetup({ ...base, baseUrl: " https://gateway.example/v1/// " }).config as Record<string, unknown>).baseUrl,
    "https://gateway.example/v1");
  for (const host of ["localhost", "127.0.0.1", "[::1]"]) {
    assert.equal((completeNewApiSetup({ ...base, baseUrl: `http://${host}:8780/v1` }).config as Record<string, unknown>).baseUrl,
      `http://${host}:8780/v1`);
  }
});

test("setup rejects credentials embedded in the NewAPI URL", () => {
  const base = { apiKey: "key", relay: { enabled: false as const } };
  for (const baseUrl of [
    "https://user@gateway.example/v1",
    "https://user:password@gateway.example/v1",
  ]) {
    assert.throws(() => completeNewApiSetup({ ...base, baseUrl }), /must not contain credentials/u);
  }
});

test("setup rejects query parameters and fragments in the NewAPI URL", () => {
  const base = { apiKey: "key", relay: { enabled: false as const } };
  for (const baseUrl of [
    "https://gateway.example/v1?token=secret",
    "https://gateway.example/v1#secret",
  ]) {
    assert.throws(() => completeNewApiSetup({ ...base, baseUrl }), /must not contain a query or fragment/u);
  }
});

test("setup rejects insecure remote URLs and blank secrets", () => {
  const base = { baseUrl: "https://gateway.example/v1", apiKey: "key" };
  assert.throws(() => completeNewApiSetup({ ...base, baseUrl: "http://gateway.example/v1", relay: { enabled: false } }), /HTTPS or loopback HTTP/u);
  assert.throws(() => completeNewApiSetup({ ...base, apiKey: " ", relay: { enabled: false } }), /NewAPI API Key/u);
  assert.throws(() => completeNewApiSetup({ ...base, relay: {
    enabled: true, endpoint: "oss-cn-chengdu.aliyuncs.com", bucket: "team-relay", accessKeyId: "", accessKeySecret: "sk",
  } }), /OSS AccessKey ID/u);
  assert.throws(() => completeNewApiSetup({ ...base, relay: {
    enabled: true, endpoint: "oss-cn-chengdu.aliyuncs.com", bucket: "team-relay", accessKeyId: "ak", accessKeySecret: " ",
  } }), /OSS AccessKey Secret/u);
});

test("relay setup rejects missing endpoint or bucket", () => {
  const base = { baseUrl: "https://gateway.example/v1", apiKey: "key" };
  assert.throws(() => completeNewApiSetup({ ...base, relay: {
    enabled: true, endpoint: " ", bucket: "team-relay", accessKeyId: "ak", accessKeySecret: "sk",
  } }), /OSS Endpoint/u);
  assert.throws(() => completeNewApiSetup({ ...base, relay: {
    enabled: true, endpoint: "oss-cn-chengdu.aliyuncs.com", bucket: " ", accessKeyId: "ak", accessKeySecret: "sk",
  } }), /OSS Bucket/u);
});
