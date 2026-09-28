import assert from "node:assert/strict";
import test from "node:test";
import OSS from "ali-oss";

import { createOssPublisher } from "../src/relay.js";

test("ResourceStore Uint8Array passes the real ali-oss put validation", async () => {
  let requests = 0;
  const publish = createOssPublisher({
    endpoint: "oss-cn-chengdu.aliyuncs.com", bucket: "team-relay",
    accessKeyId: { store: "platform", key: "ak" }, accessKeySecret: { store: "platform", key: "sk" }, ttlSeconds: 900,
  }, (options) => {
    const client = new OSS(options);
    // Stub only the network boundary, after the SDK has validated and built the request.
    Object.defineProperty(client, "request", { value: async (params: { content: unknown }) => {
      requests += 1;
      assert.ok(Buffer.isBuffer(params.content));
      assert.deepEqual([...params.content], [1, 2, 3]);
      return { res: { status: 200, headers: {} } };
    } });
    return client;
  });
  await publish({ bytes: new Uint8Array([1, 2, 3]), mediaType: "image/png",
    credentials: { relayAccessKeyId: { secret: "test-ak" }, relayAccessKeySecret: { secret: "test-sk" } } });
  assert.equal(requests, 1);
});

test("OSS publisher uploads one artifact and returns a temporary signed URL", async () => {
  const calls: unknown[] = [];
  const publish = createOssPublisher({
    endpoint: "oss-cn-chengdu.aliyuncs.com",
    bucket: "team-relay",
    accessKeyId: { store: "platform", key: "oss-ak" },
    accessKeySecret: { store: "platform", key: "oss-sk" },
    ttlSeconds: 900,
  }, (options) => ({
    async put(name, bytes, putOptions) { calls.push(["put", options, name, [...bytes], putOptions]); },
    signatureUrl(name, options) { calls.push(["sign", name, options]); return `https://relay.example/${name}`; },
  }));

  const url = await publish({
    bytes: new Uint8Array([1, 2, 3]),
    mediaType: "image/png",
    credentials: {
      relayAccessKeyId: { secret: "test-ak" },
      relayAccessKeySecret: { secret: "test-sk" },
    },
  });

  assert.match(url, /^https:\/\/relay\.example\/relay\/hypit\/\d{8}\/[0-9a-f-]+\.png$/);
  assert.equal(calls.length, 2);
  assert.deepEqual((calls[0] as unknown[]).slice(0, 2), ["put", {
    endpoint: "oss-cn-chengdu.aliyuncs.com",
    bucket: "team-relay",
    accessKeyId: "test-ak",
    accessKeySecret: "test-sk",
    secure: true,
  }]);
  assert.deepEqual((calls[1] as unknown[]).slice(-1), [{ expires: 900 }]);
});
