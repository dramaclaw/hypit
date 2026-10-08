import type { EndpointActionLimits } from "@hypit/endpoint-kit";
import type { CanonicalValue } from "@hypit/protocol";
import type { CredentialRef } from "@hypit/runtime";
import {
  runtimeConfigActionLimits,
  runtimeConfigCredentialRef,
  runtimeConfigExact,
  runtimeConfigObject,
  runtimeConfigPositiveInteger,
  runtimeConfigString,
} from "@hypit/runtime-kit";

export type NewApiRelayConfig = {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: CredentialRef;
  readonly accessKeySecret: CredentialRef;
  readonly ttlSeconds: number;
};

export type NewApiEndpointConfig = {
  readonly baseUrl: string;
  readonly audioAssetOrigins?: readonly string[];
  readonly apiKey: CredentialRef;
  readonly relay?: NewApiRelayConfig;
  readonly defaultConcurrency?: number;
  readonly actionLimits?: EndpointActionLimits;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
};

export function parseNewApiEndpointConfig(value: CanonicalValue): NewApiEndpointConfig {
  const config = runtimeConfigObject(value, "DramaClaw NewAPI");
  runtimeConfigExact(config, [
    "baseUrl", "apiKey", "audioAssetOrigins",
    "relayEndpoint", "relayBucket", "relayAccessKeyId", "relayAccessKeySecret", "relayTtlSeconds",
    "defaultConcurrency", "actionLimits", "pollIntervalMs", "requestTimeoutMs", "operationTimeoutMs",
  ], "DramaClaw NewAPI");
  const baseUrl = runtimeConfigString(config.baseUrl, "DramaClaw NewAPI baseUrl");
  const apiKey = runtimeConfigCredentialRef(config.apiKey, "DramaClaw NewAPI apiKey");
  const audioAssetOrigins = config.audioAssetOrigins;
  if (audioAssetOrigins !== undefined && (!Array.isArray(audioAssetOrigins)
    || audioAssetOrigins.some((origin) => typeof origin !== "string"))) {
    throw new Error("DramaClaw NewAPI audioAssetOrigins must be an array of strings");
  }
  if (baseUrl === undefined || apiKey === undefined) {
    throw new Error("DramaClaw NewAPI requires baseUrl and apiKey CredentialRef");
  }
  const relayEndpoint = runtimeConfigString(config.relayEndpoint, "DramaClaw NewAPI relayEndpoint");
  const relayBucket = runtimeConfigString(config.relayBucket, "DramaClaw NewAPI relayBucket");
  const relayAccessKeyId = runtimeConfigCredentialRef(config.relayAccessKeyId, "DramaClaw NewAPI relayAccessKeyId");
  const relayAccessKeySecret = runtimeConfigCredentialRef(config.relayAccessKeySecret, "DramaClaw NewAPI relayAccessKeySecret");
  const relayParts = [relayEndpoint, relayBucket, relayAccessKeyId, relayAccessKeySecret];
  if (relayParts.some((part) => part !== undefined) && relayParts.some((part) => part === undefined)) {
    throw new Error("DramaClaw NewAPI relayEndpoint, relayBucket, relayAccessKeyId and relayAccessKeySecret must be configured together");
  }
  const relayTtlSeconds = runtimeConfigPositiveInteger(config.relayTtlSeconds, "DramaClaw NewAPI relayTtlSeconds") ?? 3_600;
  const relay = relayEndpoint === undefined ? undefined : {
    endpoint: relayEndpoint,
    bucket: relayBucket!,
    accessKeyId: relayAccessKeyId!,
    accessKeySecret: relayAccessKeySecret!,
    ttlSeconds: relayTtlSeconds,
  };
  const defaultConcurrency = runtimeConfigPositiveInteger(config.defaultConcurrency, "DramaClaw NewAPI defaultConcurrency");
  const actionLimits = runtimeConfigActionLimits(config.actionLimits);
  const pollIntervalMs = runtimeConfigPositiveInteger(config.pollIntervalMs, "DramaClaw NewAPI pollIntervalMs");
  const requestTimeoutMs = runtimeConfigPositiveInteger(config.requestTimeoutMs, "DramaClaw NewAPI requestTimeoutMs");
  const operationTimeoutMs = runtimeConfigPositiveInteger(config.operationTimeoutMs, "DramaClaw NewAPI operationTimeoutMs");
  return {
    baseUrl,
    apiKey,
    ...(audioAssetOrigins === undefined ? {} : { audioAssetOrigins: audioAssetOrigins as string[] }),
    ...(relay === undefined ? {} : { relay }),
    ...(defaultConcurrency === undefined ? {} : { defaultConcurrency }),
    ...(actionLimits === undefined ? {} : { actionLimits }),
    ...(pollIntervalMs === undefined ? {} : { pollIntervalMs }),
    ...(requestTimeoutMs === undefined ? {} : { requestTimeoutMs }),
    ...(operationTimeoutMs === undefined ? {} : { operationTimeoutMs }),
  };
}
