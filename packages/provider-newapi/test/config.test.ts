import assert from "node:assert/strict";
import test from "node:test";

import { parseNewApiEndpointConfig } from "../src/config.js";

const apiKey = { store: "platform", key: "newapi.team.api-key" };

test("NewAPI endpoint configuration does not require OSS", () => {
  assert.deepEqual(parseNewApiEndpointConfig({ baseUrl: "https://gateway.example/v1", apiKey }), {
    baseUrl: "https://gateway.example/v1",
    apiKey,
  });
});

test("NewAPI endpoint rejects a partial OSS relay group", () => {
  assert.throws(() => parseNewApiEndpointConfig({
    baseUrl: "https://gateway.example/v1",
    apiKey,
    relayEndpoint: "oss-cn-chengdu.aliyuncs.com",
  }), /relayEndpoint, relayBucket, relayAccessKeyId and relayAccessKeySecret must be configured together/);
});

test("NewAPI endpoint preserves a complete OSS relay group", () => {
  const relayAccessKeyId = { store: "platform", key: "newapi.team.oss-ak" };
  const relayAccessKeySecret = { store: "platform", key: "newapi.team.oss-sk" };
  assert.deepEqual(parseNewApiEndpointConfig({
    baseUrl: "https://gateway.example/v1",
    apiKey,
    relayEndpoint: "oss-cn-chengdu.aliyuncs.com",
    relayBucket: "team-relay",
    relayAccessKeyId,
    relayAccessKeySecret,
    relayTtlSeconds: 900,
  }), {
    baseUrl: "https://gateway.example/v1",
    apiKey,
    relay: {
      endpoint: "oss-cn-chengdu.aliyuncs.com",
      bucket: "team-relay",
      accessKeyId: relayAccessKeyId,
      accessKeySecret: relayAccessKeySecret,
      ttlSeconds: 900,
    },
  });
});
