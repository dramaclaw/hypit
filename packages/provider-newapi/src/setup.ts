import type { CanonicalValue } from "@hypit/protocol";

import { newApiRoutes } from "./routes.js";

export type NewApiSetupInspection = {
  readonly configured: boolean;
  readonly missing: readonly "baseUrl"[];
};

export type NewApiSetupInput = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly relay: { readonly enabled: false } | {
    readonly enabled: true;
    readonly endpoint: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly accessKeySecret: string;
  };
};

export type NewApiSetupCredential = {
  readonly slot: "apiKey" | "relayAccessKeyId" | "relayAccessKeySecret";
  readonly secret: string;
};

export const newApiDefaultBindings: Readonly<Record<string, "newapi.personal">> = Object.freeze(Object.fromEntries(
  newApiRoutes.map((route) => [route.key, "newapi.personal"] as const),
));

export function inspectNewApiSetup(config: CanonicalValue): NewApiSetupInspection {
  const item = config !== null && typeof config === "object" && !Array.isArray(config)
    ? config as Record<string, CanonicalValue> : {};
  const baseUrl = typeof item.baseUrl === "string" ? item.baseUrl.trim() : "";
  return { configured: baseUrl.length > 0, missing: baseUrl.length > 0 ? [] : ["baseUrl"] };
}

export function validateNewApiSetupUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/u, "");
  let url: URL;
  try { url = new URL(trimmed); }
  catch { throw new Error("DramaClaw NewAPI baseUrl must be a valid HTTPS or loopback HTTP URL"); }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error("DramaClaw NewAPI baseUrl must use HTTPS or loopback HTTP");
  }
  return trimmed;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function requiredSecret(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} is required`);
  }
  return value;
}

export function completeNewApiSetup(input: NewApiSetupInput): {
  config: CanonicalValue;
  credentials: readonly NewApiSetupCredential[];
} {
  const baseUrl = validateNewApiSetupUrl(input.baseUrl);
  const credentials: NewApiSetupCredential[] = [{ slot: "apiKey", secret: requiredSecret(input.apiKey, "NewAPI API Key") }];
  const config: Record<string, CanonicalValue> = {
    baseUrl,
    apiKey: { store: "platform", key: "newapi.personal.api-key" },
  };
  if (input.relay.enabled) {
    config.relayEndpoint = requiredText(input.relay.endpoint, "OSS Endpoint");
    config.relayBucket = requiredText(input.relay.bucket, "OSS Bucket");
    config.relayAccessKeyId = { store: "platform", key: "newapi.personal.oss-ak" };
    config.relayAccessKeySecret = { store: "platform", key: "newapi.personal.oss-sk" };
    config.relayTtlSeconds = 3600;
    credentials.push(
      { slot: "relayAccessKeyId", secret: requiredSecret(input.relay.accessKeyId, "OSS AccessKey ID") },
      { slot: "relayAccessKeySecret", secret: requiredSecret(input.relay.accessKeySecret, "OSS AccessKey Secret") },
    );
  }
  return { config, credentials };
}
