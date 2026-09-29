import assert from "node:assert/strict";
import test from "node:test";

import { testNewApiSetupConnection } from "../src/index.js";
import type { NewApiSetupInput } from "../src/setup.js";

const objectKey = "relay/hypit/setup-test/00000000-0000-4000-8000-000000000000.txt";
const signedUrl = "https://signed.invalid/probe?Signature=signed-secret";
const validInput: NewApiSetupInput = {
  baseUrl: " https://gateway.example/v1/// ",
  apiKey: "api-secret",
  relay: {
    enabled: true,
    endpoint: "oss-cn-chengdu.aliyuncs.com",
    bucket: "team-relay",
    accessKeyId: "oss-id-secret",
    accessKeySecret: "oss-key-secret",
  },
};

function assertSafeError(error: unknown, expected: RegExp): true {
  assert.ok(error instanceof Error);
  assert.match(error.message, expected);
  assert.doesNotMatch(error.message, /api-secret|oss-id-secret|oss-key-secret|signed-secret|https:\/\/signed\.invalid|nested-secret|Authorization/u);
  assert.equal(error.cause, undefined);
  return true;
}

test("verifies models, uploads, downloads and removes one OSS probe", async () => {
  const events: string[] = [];
  const result = await testNewApiSetupConnection(validInput, {
    fetch: async (url, init) => {
      if (String(url) === signedUrl) {
        events.push("GET signed");
        assert.equal(init?.method, "GET");
        return new Response(Uint8Array.of(0x48, 0x59));
      }
      events.push("GET models");
      assert.equal(url, "https://gateway.example/v1/models");
      assert.equal(init?.method, "GET");
      assert.equal(new Headers(init.headers).get("Authorization"), "Bearer api-secret");
      return Response.json({ data: [{ id: "seedance-2.5" }] });
    },
    createOssClient: (options) => {
      assert.deepEqual(options, {
        endpoint: "oss-cn-chengdu.aliyuncs.com",
        bucket: "team-relay",
        accessKeyId: "oss-id-secret",
        accessKeySecret: "oss-key-secret",
        secure: true,
      });
      return {
        put: async (name, bytes, putOptions) => {
          events.push("put");
          assert.equal(name, objectKey);
          assert.deepEqual([...bytes], [0x48, 0x59]);
          assert.deepEqual(putOptions, { headers: { "content-type": "text/plain" } });
        },
        signatureUrl: (name, options) => {
          assert.equal(name, objectKey);
          assert.deepEqual(options, { expires: 60 });
          return signedUrl;
        },
        delete: async (name) => { events.push("delete"); assert.equal(name, objectKey); },
      };
    },
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
  });
  assert.deepEqual(result, { modelCount: 1, relayVerified: true });
  assert.deepEqual(events, ["GET models", "put", "GET signed", "delete"]);
});

test("rejects model request failures without exposing nested network errors", async () => {
  const fetchCases = [
    { name: "network", fetch: async () => { throw new Error("Authorization Bearer api-secret nested-secret"); } },
    { name: "http", fetch: async () => new Response("api-secret", { status: 401 }) },
  ];
  for (const item of fetchCases) {
    await assert.rejects(
      testNewApiSetupConnection(validInput, {
        fetch: item.fetch,
        createOssClient: () => { throw new Error("OSS should not start"); },
        randomUUID: () => "unused",
      }),
      (error) => assertSafeError(error, /NewAPI models request failed/u),
      item.name,
    );
  }
});

test("rejects malformed or empty model catalogs", async () => {
  const cases = [
    { response: new Response("not json"), expected: /NewAPI models response is invalid/u },
    { response: Response.json({ data: {} }), expected: /NewAPI models response is invalid/u },
    { response: Response.json({ data: [] }), expected: /NewAPI returned no models/u },
  ];
  for (const item of cases) {
    await assert.rejects(testNewApiSetupConnection(validInput, {
      fetch: async () => item.response,
      createOssClient: () => { throw new Error("OSS should not start"); },
      randomUUID: () => "unused",
    }), (error) => assertSafeError(error, item.expected));
  }
});

test("does not attempt deletion when upload fails", async () => {
  const events: string[] = [];
  await assert.rejects(testNewApiSetupConnection(validInput, {
    fetch: async () => Response.json({ data: [{ id: "model" }] }),
    createOssClient: () => ({
      put: async () => { events.push("put"); throw new Error("nested-secret"); },
      signatureUrl: () => { throw new Error("signature should not run"); },
      delete: async () => { events.push("delete"); },
    }),
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
  }), (error) => assertSafeError(error, /OSS probe upload failed/u));
  assert.deepEqual(events, ["put"]);
});

test("does not expose nested errors from OSS client creation or probe key generation", async () => {
  for (const failAt of ["uuid", "client"] as const) {
    await assert.rejects(testNewApiSetupConnection(validInput, {
      fetch: async () => Response.json({ data: [{ id: "model" }] }),
      randomUUID: () => {
        if (failAt === "uuid") throw new Error("api-secret nested-secret");
        return "00000000-0000-4000-8000-000000000000";
      },
      createOssClient: () => { throw new Error("oss-key-secret nested-secret"); },
    }), (error) => assertSafeError(error, /OSS probe upload failed/u), failAt);
  }
});

test("rejects malformed probe identifiers before they can appear in an object key", async () => {
  await assert.rejects(testNewApiSetupConnection(validInput, {
    fetch: async (url) => String(url) === signedUrl
      ? new Response(Uint8Array.of(0x48, 0x59))
      : Response.json({ data: [{ id: "model" }] }),
    randomUUID: () => "api-secret",
    createOssClient: () => ({
      put: async () => {},
      signatureUrl: () => signedUrl,
      delete: async () => { throw new Error("nested-secret"); },
    }),
  }), (error) => assertSafeError(error, /OSS probe upload failed/u));
});

test("deletes the probe after signing, download, status, or byte verification failure", async () => {
  const cases = [
    { name: "signing", signatureUrl: () => { throw new Error("nested-secret"); }, fetchSigned: async () => new Response(Uint8Array.of(0x48, 0x59)), expected: /OSS probe signing failed/u },
    { name: "network", signatureUrl: () => signedUrl, fetchSigned: async () => { throw new Error("nested-secret"); }, expected: /OSS probe download failed/u },
    { name: "status", signatureUrl: () => signedUrl, fetchSigned: async () => new Response("nested-secret", { status: 403 }), expected: /OSS probe download failed/u },
    { name: "bytes", signatureUrl: () => signedUrl, fetchSigned: async () => new Response(Uint8Array.of(0x48, 0x00)), expected: /OSS probe content mismatch/u },
  ];
  for (const item of cases) {
    const events: string[] = [];
    await assert.rejects(testNewApiSetupConnection(validInput, {
      fetch: async (url) => String(url) === signedUrl
        ? item.fetchSigned()
        : Response.json({ data: [{ id: "model" }] }),
      createOssClient: () => ({
        put: async () => { events.push("put"); },
        signatureUrl: item.signatureUrl,
        delete: async () => { events.push("delete"); },
      }),
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
    }), (error) => assertSafeError(error, item.expected), item.name);
    assert.deepEqual(events, ["put", "delete"], item.name);
  }
});

test("cleanup failure returns a safe object key after successful verification", async () => {
  let deleteAttempts = 0;
  const result = await testNewApiSetupConnection(validInput, {
    fetch: async (url) => String(url) === signedUrl
      ? new Response(Uint8Array.of(0x48, 0x59))
      : Response.json({ data: [{ id: "model" }] }),
    createOssClient: () => ({
      put: async () => {},
      signatureUrl: () => signedUrl,
      delete: async () => { deleteAttempts++; throw new Error("oss-key-secret nested-secret"); },
    }),
    randomUUID: () => "00000000-0000-4000-8000-000000000000",
  });
  assert.deepEqual(result, { modelCount: 1, relayVerified: true, cleanupObjectKey: objectKey });
  assert.equal(deleteAttempts, 1);
});

test("mandatory verification error remains primary when cleanup also fails", async () => {
  const cases = [
    { name: "signing", sign: () => { throw new Error("nested-secret"); }, download: async () => new Response(Uint8Array.of(0x48, 0x59)), expected: /OSS probe signing failed/u },
    { name: "download", sign: () => signedUrl, download: async () => new Response("nested-secret", { status: 403 }), expected: /OSS probe download failed/u },
    { name: "content", sign: () => signedUrl, download: async () => new Response(Uint8Array.of(0x00)), expected: /OSS probe content mismatch/u },
  ];
  for (const item of cases) {
    let deleteAttempts = 0;
    await assert.rejects(testNewApiSetupConnection(validInput, {
      fetch: async (url) => String(url) === signedUrl ? item.download() : Response.json({ data: [{ id: "model" }] }),
      createOssClient: () => ({
        put: async () => {},
        signatureUrl: item.sign,
        delete: async () => { deleteAttempts++; throw new Error("oss-key-secret nested-secret"); },
      }),
      randomUUID: () => "00000000-0000-4000-8000-000000000000",
    }), (error) => assertSafeError(error, item.expected), item.name);
    assert.equal(deleteAttempts, 1, item.name);
  }
});
