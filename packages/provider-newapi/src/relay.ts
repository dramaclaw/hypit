import crypto from "node:crypto";

import OSS from "ali-oss";
import type { EndpointCredential } from "@hypit/endpoint-kit";

import type { NewApiRelayConfig } from "./config.js";

type Credentials = Readonly<Record<string, EndpointCredential>>;

type OssClientOptions = {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly accessKeySecret: string;
  readonly secure: true;
};

type OssClient = {
  readonly put: (name: string, bytes: Buffer, options: { readonly headers: { readonly "content-type": string } }) => Promise<unknown>;
  readonly signatureUrl: (name: string, options: { readonly expires: number }) => string;
};

export type OssClientFactory = (options: OssClientOptions) => OssClient;

export type PublishInput = {
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly credentials: Credentials;
};

export type AssetPublisher = (input: PublishInput) => Promise<string>;

function credential(credentials: Credentials, slot: string): string {
  const secret = credentials[slot]?.secret;
  if (typeof secret !== "string" || secret.length === 0) {
    throw new Error(`DramaClaw NewAPI ${slot} credential is unavailable`);
  }
  return secret;
}

function extension(mediaType: string): string {
  return ({
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp",
    "video/mp4": "mp4", "video/webm": "webm",
    "audio/mpeg": "mp3", "audio/wav": "wav",
  } as Readonly<Record<string, string>>)[mediaType] ?? "bin";
}

const defaultClientFactory: OssClientFactory = (options) => new OSS(options);

export function createOssPublisher(
  config: NewApiRelayConfig,
  clientFactory: OssClientFactory = defaultClientFactory,
): AssetPublisher {
  return async ({ bytes, mediaType, credentials }) => {
    const client = clientFactory({
      endpoint: config.endpoint,
      bucket: config.bucket,
      accessKeyId: credential(credentials, "relayAccessKeyId"),
      accessKeySecret: credential(credentials, "relayAccessKeySecret"),
      secure: true,
    });
    const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
    const objectName = `relay/hypit/${day}/${crypto.randomUUID()}.${extension(mediaType)}`;
    await client.put(objectName, Buffer.from(bytes), { headers: { "content-type": mediaType } });
    return client.signatureUrl(objectName, { expires: config.ttlSeconds });
  };
}
