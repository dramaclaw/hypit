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
  readonly timeout: number;
};

export type OssSetupTestClient = {
  readonly put: (name: string, bytes: Buffer, options: { readonly headers: { readonly "content-type": string } }) => Promise<unknown>;
  readonly signatureUrl: (name: string, options: { readonly expires: number }) => string;
  readonly delete: (name: string, options?: { readonly timeout: number }) => Promise<unknown>;
};

export type NewApiConnectionTestDependencies = {
  readonly fetch: typeof globalThis.fetch;
  readonly createOssClient: (options: OssSetupTestClientOptions) => OssSetupTestClient;
  readonly randomUUID: () => string;
  readonly timeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
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

export function readNewApiCleanupObjectKey(value: unknown): string | undefined {
  try {
    const key: unknown = value !== null && (typeof value === "object" || typeof value === "function") ? Reflect.get(value, "cleanupObjectKey") : undefined;
    return typeof key === "string" && key.length <= 128 && /^relay\/hypit\/setup-test\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.txt$/u.test(key) ? key : undefined;
  } catch { return undefined; }
}

function failure(message: string, cleanupObjectKey?: string): Error {
  // Never attach an SDK, HTTP, or fetch cause: these can contain credentials or signed URLs.
  return Object.assign(new Error(message), cleanupObjectKey ? { cleanupObjectKey } : {});
}

const boundedTimeout = (value: number | undefined, maximum: number) => value !== undefined && Number.isFinite(value) && value > 0 ? Math.min(Math.ceil(value), maximum) : maximum;
function deadline(timeoutMs: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  return {
    signal: controller.signal,
    dispose: () => { clearTimeout(timer); controller.abort(); },
    run<T>(operation: () => Promise<T>): Promise<T> {
      if (controller.signal.aborted) return Promise.reject(failure("Connection test timed out"));
      return new Promise<T>((resolve, reject) => {
        const abort = () => reject(failure("Connection test timed out"));
        controller.signal.addEventListener("abort", abort, { once: true });
        Promise.resolve().then(() => { controller.signal.throwIfAborted(); return operation(); }).then(
          value => { controller.signal.removeEventListener("abort", abort); resolve(value); },
          error => { controller.signal.removeEventListener("abort", abort); reject(error); },
        );
      });
    },
  };
}
type ProbeDeadline = ReturnType<typeof deadline>;

async function modelCount(baseUrl: string, apiKey: string, fetcher: typeof globalThis.fetch, probe: ProbeDeadline): Promise<number> {
  let response: Response;
  try {
    response = await probe.run(() => fetcher(`${baseUrl}/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: probe.signal,
    }));
  } catch {
    throw failure("NewAPI models request failed");
  }
  if (!response.ok) throw failure("NewAPI models request failed");

  let payload: unknown;
  try {
    payload = await probe.run(() => response.json());
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

async function verifyDownload(url: string, fetcher: typeof globalThis.fetch, probe: ProbeDeadline): Promise<void> {
  let response: Response;
  try {
    response = await probe.run(() => fetcher(url, { method: "GET", signal: probe.signal }));
  } catch {
    throw failure("OSS probe download failed");
  }
  if (!response.ok) throw failure("OSS probe download failed");

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await probe.run(() => response.arrayBuffer()));
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

  const timeoutMs = boundedTimeout(dependencies.timeoutMs, 30_000);
  const cleanupTimeoutMs = boundedTimeout(dependencies.cleanupTimeoutMs, 5_000);
  const probe = deadline(timeoutMs);
  try {
    const baseUrl = (setup.config as { readonly baseUrl: string }).baseUrl;
    const count = await modelCount(baseUrl, input.apiKey, dependencies.fetch, probe);
    let objectKey: string;
    let client: OssSetupTestClient;
    try {
      const uuid = dependencies.randomUUID();
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(uuid)) throw failure("OSS probe upload failed");
      objectKey = `relay/hypit/setup-test/${uuid}.txt`;
      client = dependencies.createOssClient({ endpoint: input.relay.endpoint.trim(), bucket: input.relay.bucket.trim(),
        accessKeyId: input.relay.accessKeyId, accessKeySecret: input.relay.accessKeySecret, secure: true, timeout: timeoutMs });
    } catch {
      throw failure("OSS probe upload failed");
    }

    let uploaded = false;
    let uploadUncertain = false;
    let primary: Error | undefined;
    let cleanupObjectKey: string | undefined;
    try {
      try {
        await probe.run(() => client.put(objectKey, PROBE_BYTES, { headers: { "content-type": PROBE_CONTENT_TYPE } }));
        uploaded = true;
      } catch {
        uploadUncertain = probe.signal.aborted;
        throw failure("OSS probe upload failed");
      }
      let signedUrl: string;
      try { signedUrl = client.signatureUrl(objectKey, { expires: PROBE_TTL_SECONDS }); }
      catch { throw failure("OSS probe signing failed"); }
      await verifyDownload(signedUrl, dependencies.fetch, probe);
    } catch (error) {
      primary = error as Error; // All failures above have already been sanitized.
    } finally {
      probe.dispose();
      if (uploaded || uploadUncertain) {
        const cleanup = deadline(cleanupTimeoutMs);
        try { await cleanup.run(() => client.delete(objectKey, { timeout: cleanupTimeoutMs })); }
        catch { cleanupObjectKey = objectKey; }
        finally { cleanup.dispose(); }
        // A timed-out SDK upload may finish after deletion; report the unique key for later cleanup.
        if (uploadUncertain) cleanupObjectKey = objectKey;
      }
    }
    if (primary) throw failure(primary.message, cleanupObjectKey);
    return { modelCount: count, relayVerified: true, ...(cleanupObjectKey ? { cleanupObjectKey } : {}) };
  } finally {
    probe.dispose();
  }
}
