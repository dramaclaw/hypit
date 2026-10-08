import { requestDeadline } from "@hypit/runtime-kit";
import { artifactTypes } from "@hypit/artifact";
import {
  EndpointResponseError,
  EndpointHttpError,
  EndpointServiceError,
  EndpointTransportError,
  defineEndpointPackage,
  pollAgainOrFail,
  retryAfterMs,
  transport,
  wakeAfter,
} from "@hypit/endpoint-kit";
import type {
  AsyncEndpoint,
  EndpointCredential,
  EndpointInvocationContext,
  EndpointOutcome,
  ImmediateEndpointHandler,
} from "@hypit/endpoint-kit";
import type { GenerationArtifactUrlResolver } from "@hypit/generation";
import { canonicalize } from "@hypit/protocol";
import type { BlobRef } from "@hypit/protocol";
import {
  cosyVoiceCapabilities,
  cosyVoiceTypes,
  verifyCosyVoiceDesignRequest,
  verifyCosyVoiceSpeechRequest,
} from "@hypit/cosyvoice";
import { credentialRef } from "@hypit/runtime";
import type { CredentialRef } from "@hypit/runtime";
import { sealAlignedTranscriptEvidence, speechEvidenceTypes } from "@hypit/speech-evidence";
import {
  assertWhisperXEvidenceWav,
  interpretWhisperXTranscript,
  verifyWhisperXAlignmentRequest,
  whisperXCapabilities,
} from "@hypit/whisperx";
import type { WhisperXTranscriptResponse } from "@hypit/whisperx";

import { assertTrustedAudioAssetUrl } from "./audio-url.js";
import { normalizeNewApiBaseUrl } from "./base-url.js";
import type { NewApiRelayConfig } from "./config.js";
import { createOssPublisher } from "./relay.js";
import type { AssetPublisher } from "./relay.js";
import { newApiRouteForCapability, newApiRoutes } from "./routes.js";
import type { NewApiPreparedRequest, NewApiRoute } from "./routes.js";

export const newApiProviderModuleRef = { name: "@dramaclaw/provider-newapi", version: "1" } as const;

export type CreateNewApiProviderOptions = {
  readonly instance?: string;
  readonly pool?: string;
  readonly baseUrl?: string;
  readonly audioAssetOrigins?: readonly string[];
  readonly apiKey?: CredentialRef;
  readonly relay?: NewApiRelayConfig;
  readonly publish?: AssetPublisher;
  readonly defaultConcurrency?: number;
  readonly actionLimits?: import("@hypit/endpoint-kit").EndpointActionLimits;
  readonly pollIntervalMs?: number;
  readonly requestTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly fetch?: typeof globalThis.fetch;
};

type Credentials = Readonly<Record<string, EndpointCredential>>;

type VideoHandle = {
  readonly contract: "hypit.dramaclaw-newapi-operation@1";
  readonly taskId: string;
  readonly route: string;
  readonly startedAt: number;
  readonly url?: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function object(value: unknown, subject: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${subject} must be an object`);
  return value as Record<string, unknown>;
}

function credential(credentials: Credentials, slot: string): string {
  const secret = credentials[slot]?.secret;
  assert(typeof secret === "string" && secret.length > 0, `DramaClaw NewAPI ${slot} credential is unavailable`);
  return secret;
}

function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function publicText(value: string, credentials: Credentials = {}, sensitive: readonly string[] = []): string {
  for (const secret of [...Object.values(credentials).map((item) => item.secret), ...sensitive]
    .filter((secret): secret is string => typeof secret === "string" && secret.length > 0)
    .sort((a, b) => b.length - a.length)) {
    value = value.replaceAll(secret, "[redacted]");
  }
  return value.replace(/https?:\/\/\S+/giu, "[redacted-url]").slice(0, 500);
}

function publicError(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  const direct = item.message ?? item.detail ?? item.fail_reason ?? (typeof item.error === "string" ? item.error : undefined);
  if (typeof direct === "string" && direct.length > 0) return direct;
  return item.error === undefined ? undefined : publicError(item.error);
}

function hasSpokenTranscriptText(response: Record<string, unknown>): boolean {
  const segmentTexts = Array.isArray(response.segments) ? response.segments.map((segment: unknown) =>
    segment !== null && typeof segment === "object" && !Array.isArray(segment)
      ? (segment as Record<string, unknown>).text : undefined) : [];
  return [response.text, ...segmentTexts].some((value) => typeof value === "string" && value.trim().length > 0);
}

function safeError(error: unknown, credentials: Credentials, sensitive: readonly string[] = []): EndpointServiceError {
  return new EndpointServiceError(error instanceof EndpointServiceError ? error.code : "DRAMACLAW_NEWAPI_ERROR",
    publicText(failureMessage(error), credentials, sensitive));
}

function failure(error: unknown, credentials: Credentials): EndpointOutcome {
  const sanitized = safeError(error, credentials);
  return {
    status: "failed",
    failure: {
      code: sanitized.code,
      message: sanitized.message,
    },
  };
}

function unwrap(value: Record<string, unknown>): Record<string, unknown> {
  return value.data !== null && typeof value.data === "object" && !Array.isArray(value.data)
    ? value.data as Record<string, unknown>
    : value;
}

function taskId(value: Record<string, unknown>): string {
  const body = unwrap(value);
  const id = body.id ?? body.task_id ?? body.request_id;
  assert(typeof id === "string" && id.length > 0, "DramaClaw NewAPI response has no task id");
  return id;
}

function resultUrl(value: Record<string, unknown>): string | undefined {
  const body = unwrap(value);
  const video = body.video !== null && typeof body.video === "object" && !Array.isArray(body.video)
    ? body.video as Record<string, unknown> : undefined;
  const output = Array.isArray(body.output) ? body.output[0] : undefined;
  const outputObject = output !== null && typeof output === "object" && !Array.isArray(output)
    ? output as Record<string, unknown> : undefined;
  const url = body.url ?? body.video_url ?? body.result_url ?? video?.url ?? outputObject?.url ?? output;
  return typeof url === "string" && url.length > 0 ? url : undefined;
}

function videoDimensions(resolution: string, ratio: string): { readonly width: number; readonly height: number } | undefined {
  if (ratio === "auto" || ratio === "adaptive") return undefined;
  const match = /^(\d+):(\d+)$/u.exec(ratio);
  const resolutionMatch = /^(\d+)[pP]$/u.exec(resolution);
  if (match === null || resolutionMatch === null) return undefined;
  const shortEdge = Number(resolutionMatch[1]);
  const rw = Number(match[1]);
  const rh = Number(match[2]);
  const even = (value: number) => Math.round(value / 2) * 2;
  return rw >= rh
    ? { width: even(shortEdge * rw / rh), height: shortEdge }
    : { width: shortEdge, height: even(shortEdge * rh / rw) };
}

function dataUrl(value: string): { readonly bytes: Uint8Array; readonly mediaType: string } | undefined {
  const match = /^data:([^;,]+);base64,(.+)$/u.exec(value);
  return match === null ? undefined : { bytes: new Uint8Array(Buffer.from(match[2]!, "base64")), mediaType: match[1]! };
}

class NewApiClient {
  constructor(readonly baseUrl: string, readonly timeout: number, readonly fetcher: typeof globalThis.fetch,
    readonly audioAssetOrigins: readonly string[]) {}

  async json(path: string, credentials: Credentials, init: RequestInit = {}): Promise<Record<string, unknown>> {
    const deadline = requestDeadline(this.timeout, () => new EndpointTransportError("DramaClaw NewAPI request timed out"));
    try {
      const response = await transport(deadline.wait(this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        signal: deadline.signal,
        headers: {
          authorization: `Bearer ${credential(credentials, "apiKey")}`,
          ...(typeof init.body === "string" ? { "content-type": "application/json" } : {}),
          ...(init.headers ?? {}),
        },
      })));
      const responseText = await transport(deadline.wait(response.text()));
      let body: unknown;
      try { body = responseText.length === 0 ? {} : JSON.parse(responseText); }
      catch {
        if (response.ok) throw new EndpointResponseError(`DramaClaw NewAPI returned invalid JSON (${response.status})`);
      }
      if (!response.ok) {
        const detail = publicError(body) ?? `HTTP ${response.status}`;
        throw new EndpointHttpError("DRAMACLAW_NEWAPI_HTTP_ERROR",
          `DramaClaw NewAPI ${init.method ?? "GET"} ${path} failed: ${detail}`, response.status, retryAfterMs(response.headers));
      }
      return object(body, "DramaClaw NewAPI response");
    } finally {
      deadline.finish();
    }
  }

  async asset(url: string, fallbackType: string, redirect?: RequestRedirect): Promise<{ readonly bytes: Uint8Array; readonly mediaType: string }> {
    const inline = dataUrl(url);
    if (inline !== undefined) return inline;
    const deadline = requestDeadline(this.timeout, () => new EndpointTransportError("DramaClaw NewAPI asset download timed out"));
    try {
      const response = await transport(deadline.wait(this.fetcher(url, {
        signal: deadline.signal,
        ...(redirect === undefined ? {} : { redirect }),
      })));
      if (!response.ok) throw new EndpointServiceError("DRAMACLAW_NEWAPI_ASSET_ERROR", `DramaClaw NewAPI asset returned HTTP ${response.status}`);
      return {
        bytes: new Uint8Array(await transport(deadline.wait(response.arrayBuffer()))),
        mediaType: response.headers.get("content-type")?.split(";", 1)[0] ?? fallbackType,
      };
    } finally {
      deadline.finish();
    }
  }

  async audio(path: string, credentials: Credentials, init: RequestInit, allowUrl = false): Promise<{
    readonly bytes: Uint8Array;
    readonly mediaType: string;
  }> {
    const deadline = requestDeadline(this.timeout,
      () => new EndpointTransportError("DramaClaw NewAPI speech request timed out"));
    try {
      const response = await transport(deadline.wait(this.fetcher(`${this.baseUrl}${path}`, {
        ...init,
        signal: deadline.signal,
        headers: {
          authorization: `Bearer ${credential(credentials, "apiKey")}`,
          "content-type": "application/json",
          ...(init.headers ?? {}),
        },
      })));
      if (!response.ok) {
        const text = await transport(deadline.wait(response.text()));
        let body: unknown = text;
        try { body = text.length === 0 ? {} : JSON.parse(text); }
        catch { /* Retain the public text when the service does not return JSON. */ }
        throw new EndpointHttpError(
          "DRAMACLAW_NEWAPI_HTTP_ERROR",
          `DramaClaw NewAPI ${init.method ?? "GET"} ${path} failed: ${publicError(body) ?? `HTTP ${response.status}`}`,
          response.status,
          retryAfterMs(response.headers),
        );
      }
      const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
      if (allowUrl && mediaType === "application/json") {
        let body: Record<string, unknown>;
        try { body = object(await transport(deadline.wait(response.json())), "DramaClaw NewAPI speech response"); }
        catch { throw new EndpointResponseError("DramaClaw NewAPI speech response contains invalid JSON"); }
        const audio = body.audio;
        const url = audio !== null && typeof audio === "object" && !Array.isArray(audio)
          ? (audio as Record<string, unknown>).url : undefined;
        assert(typeof url === "string" && url.length > 0, "DramaClaw NewAPI speech response has no audio URL");
        assertTrustedAudioAssetUrl(url, this.baseUrl, this.audioAssetOrigins);
        const asset = await this.asset(url, "audio/wav", "error");
        assert(asset.mediaType.startsWith("audio/"), "DramaClaw NewAPI speech download is not audio");
        assert(asset.bytes.byteLength > 0, "DramaClaw NewAPI speech download is empty");
        return asset;
      }
      assert(mediaType.startsWith("audio/"), "DramaClaw NewAPI speech response is not audio");
      const bytes = new Uint8Array(await transport(deadline.wait(response.arrayBuffer())));
      assert(bytes.byteLength > 0, "DramaClaw NewAPI speech response contains empty audio");
      return { bytes, mediaType };
    } finally {
      deadline.finish();
    }
  }
}

function resolverFor(context: EndpointInvocationContext, publish: AssetPublisher | undefined, personReference: { value: boolean }): GenerationArtifactUrlResolver {
  const resolved = new Map<string, Promise<string>>();
  return (artifact, fields) => {
    if (fields?.personReference === true) personReference.value = true;
    const existing = resolved.get(artifact.resource);
    if (existing !== undefined) return existing;
    assert(publish !== undefined, "DramaClaw NewAPI reference media requires an OSS relay configuration");
    const promise = (async () => {
      const bytes = await context.resources.get(artifact.resource);
      assert(bytes !== undefined && bytes.byteLength === artifact.size,
        `DramaClaw NewAPI reference Resource ${artifact.resource} is unavailable or has changed`);
      return await publish({ bytes, mediaType: artifact.mediaType, credentials: context.credentials });
    })();
    resolved.set(artifact.resource, promise);
    return promise;
  };
}

async function prepare(route: NewApiRoute, context: EndpointInvocationContext, publish: AssetPublisher | undefined) {
  const request = route.prepare(context.need.constraints);
  const personReference = { value: false };
  const input = await request.compile(resolverFor(context, publish, personReference));
  return { request, input, humanReview: personReference.value };
}

function imageBody(request: NewApiPreparedRequest, input: Record<string, unknown>) {
  const ratio = String(input.aspect_ratio);
  const resolution = String(input.resolution);
  return {
    model: request.model,
    prompt: input.prompt,
    n: 1,
    response_format: "b64_json",
    watermark: false,
    width: input.width,
    height: input.height,
    metadata: { ratio, resolution: resolution.toLowerCase() },
    ...(input.image === undefined ? {} : { image: input.image }),
    ...(input.output_format === undefined ? {} : { output_format: input.output_format }),
    ...(input.background === undefined ? {} : { background: input.background }),
  };
}

function videoBody(request: NewApiPreparedRequest, input: Record<string, unknown>, humanReview: boolean) {
  const ratio = typeof input.aspect_ratio === "string" ? input.aspect_ratio : undefined;
  const resolution = typeof input.resolution === "string" ? input.resolution : undefined;
  const dimensions = ratio === undefined || resolution === undefined ? undefined : videoDimensions(resolution, ratio);
  return {
    model: request.model,
    prompt: input.prompt,
    duration: input.seconds,
    ...(dimensions ?? {}),
    ...(input.first_frame === undefined ? {} : { image: input.first_frame }),
    n: 1,
    response_format: "url",
    metadata: {
      ...(resolution === undefined ? {} : { resolution: resolution.toLowerCase() }),
      ...(ratio === undefined ? {} : { ratio }),
      generate_audio: input.generate_audio === true,
      human_review: humanReview,
      return_last_frame: false,
      ...(input.reference_images === undefined ? {} : { reference_images: input.reference_images }),
      ...(input.reference_videos === undefined ? {} : { reference_videos: input.reference_videos }),
      ...(input.reference_audios === undefined ? {} : { reference_audios: input.reference_audios }),
      ...(input.last_frame === undefined ? {} : { last_frame_image: input.last_frame }),
      ...(input.web_search === undefined ? {} : { web_search: input.web_search }),
    },
  };
}

function speechBody(request: NewApiPreparedRequest, input: Record<string, unknown>) {
  const instruction = typeof input.emotion_prompt === "string" ? input.emotion_prompt : undefined;
  return {
    model: request.model,
    input: input.input,
    metadata: {
      audio_url: input.audio_url,
      ...(instruction === undefined ? {} : {
        emotion_prompt: instruction,
        should_use_prompt_for_emotion: true,
      }),
    },
  };
}

async function storeImageResults(client: NewApiClient, response: Record<string, unknown>, context: EndpointInvocationContext): Promise<readonly BlobRef[]> {
  const entries = Array.isArray(response.data) ? response.data : [unwrap(response)];
  assert(entries.length > 0, "DramaClaw NewAPI image response has no data");
  const blobs: BlobRef[] = [];
  for (const [index, value] of entries.entries()) {
    const item = object(value, `DramaClaw NewAPI image result ${index + 1}`);
    const asset = typeof item.b64_json === "string" && item.b64_json.length > 0
      ? decodedImage(item.b64_json)
      : await client.asset(String(item.url), "image/png");
    assert(asset.mediaType.startsWith("image/"), "DramaClaw NewAPI image result is not an image");
    blobs.push(await context.resources.put(asset.bytes, asset.mediaType));
  }
  return blobs;
}

function decodedImage(base64: string): { bytes: Uint8Array; mediaType: string } {
  const bytes = Buffer.from(base64, "base64");
  const mediaType = bytes.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex")) ? "image/png"
    : bytes.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex")) ? "image/jpeg" : undefined;
  assert(mediaType !== undefined, "DramaClaw NewAPI base64 image has an unsupported signature");
  return { bytes, mediaType };
}

function decodedWav(value: unknown): Uint8Array {
  assert(typeof value === "string" && value.length > 0 && /^[A-Za-z0-9+/]+={0,2}$/u.test(value)
    && value.length % 4 === 0, "DramaClaw NewAPI voice design has no valid Base64 WAV preview");
  const bytes = Buffer.from(value, "base64");
  assert(bytes.toString("base64") === value && bytes.byteLength >= 44
    && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WAVE",
  "DramaClaw NewAPI voice design preview is not WAV audio");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const end = view.getUint32(4, true) + 8;
  assert(end >= 44 && end <= bytes.byteLength, "DramaClaw NewAPI voice design preview has an invalid WAV size");
  let offset = 12;
  let blockAlign: number | undefined;
  let dataBytes = 0;
  while (offset + 8 <= end) {
    const name = bytes.toString("ascii", offset, offset + 4);
    const size = view.getUint32(offset + 4, true);
    const body = offset + 8;
    assert(body + size <= end, "DramaClaw NewAPI voice design preview has a truncated WAV chunk");
    if (name === "fmt ") {
      assert(size >= 16, "DramaClaw NewAPI voice design preview has an invalid WAV format");
      const codec = view.getUint16(body, true);
      const channels = view.getUint16(body + 2, true);
      const sampleRate = view.getUint32(body + 4, true);
      const byteRate = view.getUint32(body + 8, true);
      const align = view.getUint16(body + 12, true);
      const bits = view.getUint16(body + 14, true);
      assert((codec === 1 && [8, 16, 24, 32].includes(bits)) || (codec === 3 && [32, 64].includes(bits)),
        "DramaClaw NewAPI voice design preview has an unsupported WAV codec");
      assert(channels > 0 && sampleRate > 0 && align === channels * bits / 8 && byteRate === sampleRate * align,
        "DramaClaw NewAPI voice design preview has an invalid WAV format");
      blockAlign = align;
    } else if (name === "data") {
      dataBytes += size;
    }
    offset = body + size + (size % 2);
  }
  assert(offset === end && blockAlign !== undefined && dataBytes > 0 && dataBytes % blockAlign === 0,
    "DramaClaw NewAPI voice design preview has no decodable WAV samples");
  return bytes;
}

function videoEndpoint(client: NewApiClient, publish: AssetPublisher | undefined, pollIntervalMs: number, operationTimeoutMs: number): AsyncEndpoint {
  return {
    async start(context) {
      try {
        const route = newApiRouteForCapability(context.need.capability);
        assert(route !== undefined && route.result === "video", "DramaClaw NewAPI does not implement this exact video capability");
        const { request, input, humanReview } = await prepare(route, context, publish);
        const response = await client.json("/video/generations", context.credentials, {
          method: "POST",
          headers: { "idempotency-key": context.operation },
          body: JSON.stringify(videoBody(request, input, humanReview)),
        });
        const id = taskId(response);
        const handle: VideoHandle = { contract: "hypit.dramaclaw-newapi-operation@1", taskId: id, route: route.key, startedAt: Date.now() };
        const receipt = { id };
        await context.checkpoint?.({ handle: canonicalize(handle), receipt });
        return { ...wakeAfter(canonicalize(handle), pollIntervalMs, Date.now(), { phase: "submitted" }), receipt };
      } catch (error) {
        return failure(error, context.credentials);
      }
    },
    async poll(context) {
      try {
        const handle = object(context.handle, "DramaClaw NewAPI handle") as unknown as VideoHandle;
        const route = newApiRouteForCapability(context.need.capability);
        assert(route !== undefined && handle.contract === "hypit.dramaclaw-newapi-operation@1" && handle.route === route.key,
          "DramaClaw NewAPI handle is invalid");
        const receipt = { id: handle.taskId };
        if (Date.now() - handle.startedAt > operationTimeoutMs) {
          return { status: "failed", receipt, failure: { code: "DRAMACLAW_NEWAPI_OPERATION_TIMEOUT", message: `DramaClaw NewAPI task ${handle.taskId} exceeded operationTimeoutMs (${operationTimeoutMs}); remote outcome is unknown` } };
        }
        const response = await client.json(`/video/generations/${encodeURIComponent(handle.taskId)}`, context.credentials);
        const body = unwrap(response);
        const status = String(body.status ?? "").toLowerCase();
        if (["queued", "pending", "processing", "running", "submitted", "not_start", "in_progress"].includes(status)) {
          return { ...wakeAfter(canonicalize(handle), pollIntervalMs, Date.now(), { phase: status || "processing" }), receipt };
        }
        if (["failed", "failure", "error", "expired", "cancelled", "canceled"].includes(status)) {
          const detail = publicError(body);
          return { status: "failed", receipt, failure: { code: "DRAMACLAW_NEWAPI_VIDEO_FAILED", message: publicText(`DramaClaw NewAPI task ${handle.taskId} failed${detail === undefined ? "" : `: ${detail}`}`, context.credentials) } };
        }
        assert(["completed", "succeeded", "success", "done"].includes(status),
          `DramaClaw NewAPI task ${handle.taskId} returned unknown status ${status || "(empty)"}`);
        const url = resultUrl(response);
        assert(url !== undefined, "DramaClaw NewAPI completed video response has no result URL");
        return { status: "ready", handle: canonicalize({ ...handle, url }), receipt };
      } catch (error) {
        return pollAgainOrFail(error, { handle: context.handle, pollIntervalMs, failure: (error) => failure(error, context.credentials) });
      }
    },
    async collect(context) {
      try {
        const handle = object(context.handle, "DramaClaw NewAPI handle") as unknown as VideoHandle;
        const route = newApiRouteForCapability(context.need.capability);
        assert(route !== undefined && handle.route === route.key && typeof handle.url === "string", "DramaClaw NewAPI collection handle is invalid");
        const asset = await client.asset(handle.url, "video/mp4");
        assert(asset.mediaType.startsWith("video/"), "DramaClaw NewAPI video result is not a video");
        const artifact = await context.resources.put(asset.bytes, asset.mediaType);
        return { status: "completed", result: { value: route.packageResult([artifact]) }, receipt: { id: handle.taskId } };
      } catch (error) {
        return failure(error, context.credentials);
      }
    },
  };
}

export function createNewApiProvider(options: CreateNewApiProviderOptions = {}) {
  const requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  const operationTimeoutMs = options.operationTimeoutMs ?? 30 * 60_000;
  for (const [name, value] of Object.entries({ requestTimeoutMs, operationTimeoutMs })) {
    assert(Number.isSafeInteger(value) && value > 0, `DramaClaw NewAPI ${name} must be a positive integer`);
  }
  const client = new NewApiClient(normalizeNewApiBaseUrl(options.baseUrl ?? "https://newapi.example/v1"), requestTimeoutMs,
    options.fetch ?? globalThis.fetch, options.audioAssetOrigins ?? []);
  const publish = options.publish ?? (options.relay === undefined ? undefined : createOssPublisher(options.relay));
  const asyncEndpoint = videoEndpoint(client, publish, options.pollIntervalMs ?? 10_000, operationTimeoutMs);
  const imageEndpoint: ImmediateEndpointHandler = async (context) => {
    try {
      const route = newApiRouteForCapability(context.need.capability);
      assert(route !== undefined && route.result === "image", "DramaClaw NewAPI does not implement this exact image capability");
      const { request, input } = await prepare(route, context, publish);
      const response = await client.json(input.image === undefined ? "/images/generations" : "/images/edits", context.credentials, {
        method: "POST",
        body: JSON.stringify(imageBody(request, input)),
      });
      return { value: route.packageResult(await storeImageResults(client, response, context)) };
    } catch (error) {
      throw safeError(error, context.credentials);
    }
  };
  const audioEndpoint: ImmediateEndpointHandler = async (context) => {
    try {
      const route = newApiRouteForCapability(context.need.capability);
      assert(route !== undefined && route.result === "audio",
        "DramaClaw NewAPI does not implement this exact audio capability");
      const { request, input } = await prepare(route, context, publish);
      const asset = await client.audio("/audio/speech", context.credentials, {
        method: "POST",
        body: JSON.stringify(speechBody(request, input)),
      });
      const artifact = await context.resources.put(asset.bytes, asset.mediaType);
      return { value: route.packageResult([artifact]) };
    } catch (error) {
      throw safeError(error, context.credentials);
    }
  };
  const voiceDesignEndpoint: ImmediateEndpointHandler = async (context) => {
    try {
      const request = context.need.constraints;
      verifyCosyVoiceDesignRequest(request);
      const response = await client.json("/audio/voice-designs", context.credentials, {
        method: "POST",
        body: JSON.stringify({
          model: "voice-enrollment",
          target_model: "cosyvoice-v3.5-flash",
          preferred_name: request.preferredName,
          voice_prompt: request.voicePrompt,
          preview_text: request.previewText,
          language: request.language,
          sample_rate: 24_000,
          response_format: "wav",
        }),
      });
      assert(typeof response.voice === "string" && response.voice.trim().length > 0,
        "DramaClaw NewAPI voice design response has no voice identifier");
      assert(response.target_model === "cosyvoice-v3.5-flash",
        "DramaClaw NewAPI voice design response has the wrong target model");
      const preview = object(response.preview_audio, "DramaClaw NewAPI voice design preview");
      const bytes = decodedWav(preview.data);
      const artifact = await context.resources.put(bytes, "audio/wav");
      return { value: { kind: "inline", value: canonicalize({
        voice: response.voice, targetModel: "cosyvoice-v3.5-flash", preview: artifact,
      }) } };
    } catch (error) {
      throw safeError(error, context.credentials);
    }
  };
  const cosySpeechEndpoint: ImmediateEndpointHandler = async (context) => {
    let voiceHandle: string | undefined;
    try {
      const request = context.need.constraints;
      verifyCosyVoiceSpeechRequest(request);
      voiceHandle = request.voice.voice;
      const asset = await client.audio("/audio/speech", context.credentials, {
        method: "POST",
        body: JSON.stringify({
          model: "cosyvoice-v3.5-flash",
          input: request.text,
          voice: voiceHandle,
          response_format: "wav",
        }),
      }, true);
      return { value: await context.resources.put(asset.bytes, asset.mediaType) };
    } catch (error) {
      throw safeError(error, context.credentials, voiceHandle === undefined ? [] : [voiceHandle]);
    }
  };
  const transcriptionEndpoint: ImmediateEndpointHandler = async (context) => {
    try {
      const request = verifyWhisperXAlignmentRequest(context.need.constraints);
      const bytes = await context.resources.get(request.audio.resource);
      assert(bytes !== undefined && bytes.byteLength === request.audio.size,
        `DramaClaw NewAPI evidence Resource ${request.audio.resource} is unavailable or has changed`);
      assertWhisperXEvidenceWav(bytes, request.sampleFrames);
      const form = new FormData();
      form.append("file", new Blob([new Uint8Array(bytes)], { type: "audio/wav" }), "evidence.wav");
      form.append("model", "audio-transcribe");
      form.append("response_format", "verbose_json");
      form.append("language", request.language);
      form.append("timestamp_granularities[]", "segment");
      form.append("timestamp_granularities[]", "word");
      const response = await client.json("/audio/transcriptions", context.credentials, { method: "POST", body: form });
      const passages = interpretWhisperXTranscript(response as WhisperXTranscriptResponse, request.sampleFrames);
      assert(!hasSpokenTranscriptText(response) || passages.some((passage) => passage.words.length > 0),
        "DramaClaw NewAPI transcription response has no timed words");
      const segments = Array.isArray(response.segments) ? response.segments : [];
      const usesSegmentWords = passages.length === segments.length
        && passages.some((passage) => passage.words.length > 0);
      if (usesSegmentWords) {
        for (let index = 0; index < passages.length; index += 1) {
          const segment = segments[index] as Record<string, unknown>;
          assert(typeof segment.text !== "string" || segment.text.trim().length === 0
            || passages[index]!.words.length > 0,
          "DramaClaw NewAPI transcription segment has no timed words");
        }
      }
      for (const passage of passages) for (const word of passage.words) {
        assert(word.startSample !== undefined && word.endSampleExclusive !== undefined,
          "DramaClaw NewAPI transcription word is missing a timestamp");
      }
      const evidence = sealAlignedTranscriptEvidence({
        passages,
      });
      return { value: { kind: "inline", value: canonicalize(evidence) } };
    } catch (error) {
      throw safeError(error, context.credentials);
    }
  };
  return defineEndpointPackage({
    module: newApiProviderModuleRef,
    facet: "gateway",
    instance: options.instance ?? "dramaclaw-newapi.default",
    pool: options.pool ?? options.instance ?? "dramaclaw-newapi.default",
    credentials: {
      apiKey: options.apiKey ?? credentialRef("os", "dramaclaw-newapi.api-key"),
      ...(options.relay === undefined ? {} : {
        relayAccessKeyId: options.relay.accessKeyId,
        relayAccessKeySecret: options.relay.accessKeySecret,
      }),
    },
    credentialInputs: {
      apiKey: { label: "DramaClaw NewAPI API key" },
      ...(options.relay === undefined ? {} : {
        relayAccessKeyId: { label: "Aliyun OSS relay AccessKey ID" },
        relayAccessKeySecret: { label: "Aliyun OSS relay AccessKey secret" },
      }),
    },
    defaultConcurrency: options.defaultConcurrency ?? 2,
    ...(options.actionLimits === undefined ? { actionLimits: { submit: { concurrency: 2 }, poll: { concurrency: 8 }, collect: { concurrency: 2 } } } : { actionLimits: options.actionLimits }),
    capabilities: [...newApiRoutes.map((route) => route.result === "video"
      ? { capability: route.capability, returns: route.returns, lifecycle: "asynchronous" as const, endpoint: asyncEndpoint, capacity: route.capability.name, supports: route.supports }
      : { capability: route.capability, returns: route.returns, lifecycle: "immediate" as const,
        handler: route.result === "audio" ? audioEndpoint : imageEndpoint,
        capacity: route.capability.name, supports: route.supports }),
      { capability: cosyVoiceCapabilities.design, returns: cosyVoiceTypes.designedVoice,
        lifecycle: "immediate" as const, handler: voiceDesignEndpoint, capacity: "cosyvoice-design" },
      { capability: cosyVoiceCapabilities.speech, returns: artifactTypes.blob,
        lifecycle: "immediate" as const, handler: cosySpeechEndpoint, capacity: "cosyvoice-speech" }, {
      capability: whisperXCapabilities.alignment,
      returns: speechEvidenceTypes.alignedTranscript,
      lifecycle: "immediate" as const,
      handler: transcriptionEndpoint,
      capacity: "transcription",
    }],
  });
}
