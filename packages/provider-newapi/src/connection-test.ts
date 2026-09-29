import crypto from "node:crypto";

import OSS from "ali-oss";

import { completeNewApiSetup } from "./setup.js";
import type { NewApiSetupInput } from "./setup.js";

const PROBE_BYTES = Buffer.from([0x48, 0x59]);
const PROBE_CONTENT_TYPE = "text/plain";
const PROBE_TTL_SECONDS = 60;

type OssSetupTestClientOptions = {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly secure: true;
};

export type OssSetupTestClient = {
  readonly put: (name: string, bytes: Buffer, options: { readonly headers: { readonly "content-type": string } }) => Promise<unknown>;
  readonly signatureUrl: (name: string, options: { readonly expires: number }) => string;
  readonly delete: (name: string) => Promise<unknown>;
};

export type NewApiConnectionTestDependencies = {
  readonly fetch: typeof globalThis.fetch;
  readonly createOssClient: (options: OssSetupTestClientOptions) => OssSetupTestClient;
  readonly randomUUID: () => string;
};

export type NewApiConnectionTestResult = {
  readonly modelCount: number;
  readonly relayVerified: true;
  readonly cleanupObjectKey?: string;
};

const defaultDependencies: NewApiConnectionTestDependencies = {
  fetch: globalThis.fetch,
  createOssClient: (options) => new OSS(options),
  randomUUID: () => crypto.randomUUID(),
};

function failure(message: string): Error {
  // Never attach an SDK, HTTP, or fetch cause: these can contain credentials or signed URLs.
  return new Error(message);
}

async function modelCount(baseUrl: string, apiKey: string, fetcher: typeof globalThis.fetch): Promise<number> {
  let response: Response;
  try {
    response = await fetcher(`${baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
    });
  } catch {
    throw failure("NewAPI models request failed");
  }
  if (!response.ok) throw failure("NewAPI models request failed");

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw failure("NewAPI models response is invalid");
  }
  if (payload === null || typeof payload !== "object" || !Object.hasOwn(payload, "data")) {
    throw failure("NewAPI models response is invalid");
  }
  const data = (payload as { readonly data: unknown }).data;
  if (!Array.isArray(data)) throw failure("NewAPI models response is invalid");
  if (data.length === 0) throw failure("NewAPI returned no models");
  return data.length;
}

async function verifyDownload(url: string, fetcher: typeof globalThis.fetch): Promise<void> {
  let response: Response;
  try {
    response = await fetcher(url, { method: "GET" });
  } catch {
    throw failure("OSS probe download failed");
  }
  if (!response.ok) throw failure("OSS probe download failed");

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    throw failure("OSS probe download failed");
  }
  if (!Buffer.from(bytes).equals(PROBE_BYTES)) throw failure("OSS probe content mismatch");
}

export async function testNewApiSetupConnection(
  input: NewApiSetupInput,
  dependencies: NewApiConnectionTestDependencies = defaultDependencies,
): Promise<NewApiConnectionTestResult> {
  let setup: ReturnType<typeof completeNewApiSetup>;
  try {
    setup = completeNewApiSetup(input);
  } catch {
    throw failure("NewAPI setup input is invalid");
  }
  if (!input.relay.enabled) throw failure("OSS relay is required for connection test");

  const baseUrl = (setup.config as { readonly baseUrl: string }).baseUrl;
  const count = await modelCount(baseUrl, input.apiKey, dependencies.fetch);
  let objectKey: string;
  let client: OssSetupTestClient;
  try {
    const uuid = dependencies.randomUUID();
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(uuid)) {
      throw failure("OSS probe upload failed");
    }
    objectKey = `relay/hypit/setup-test/${uuid}.txt`;
    client = dependencies.createOssClient({
      endpoint: input.relay.endpoint.trim(),
      bucket: input.relay.bucket.trim(),
      accessKeyId: input.relay.accessKeyId,
      accessKeySecret: input.relay.accessKeySecret,
      secure: true,
    });
  } catch {
    throw failure("OSS probe upload failed");
  }

  let uploaded = false;
  let cleanupObjectKey: string | undefined;
  try {
    try {
      await client.put(objectKey, PROBE_BYTES, { headers: { "content-type": PROBE_CONTENT_TYPE } });
      uploaded = true;
    } catch {
      throw failure("OSS probe upload failed");
    }

    let signedUrl: string;
    try {
      signedUrl = client.signatureUrl(objectKey, { expires: PROBE_TTL_SECONDS });
    } catch {
      throw failure("OSS probe signing failed");
    }
    await verifyDownload(signedUrl, dependencies.fetch);
  } finally {
    if (uploaded) {
      try {
        await client.delete(objectKey);
      } catch {
        cleanupObjectKey = objectKey;
      }
    }
  }

  return { modelCount: count, relayVerified: true, ...(cleanupObjectKey ? { cleanupObjectKey } : {}) };
}
