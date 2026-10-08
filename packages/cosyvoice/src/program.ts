import { canonicalize } from "@hypit/protocol";

import type { CosyVoiceDesignRequest, CosyVoiceDesignSpec, CosyVoiceSpeechRequest, DesignedVoice } from "./types.js";

function object(value: unknown, subject: string, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${subject} must be an object`);
  const item = value as Record<string, unknown>;
  if (Object.keys(item).length !== keys.length || Object.keys(item).some((key) => !keys.includes(key))) {
    throw new Error(`${subject} has invalid fields`);
  }
  return item;
}

function nonempty(value: unknown, subject: string, max?: number): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0 || (max !== undefined && value.length > max)) {
    throw new Error(`${subject} must be nonempty${max === undefined ? "" : ` and at most ${max} characters`}`);
  }
}

export function verifyCosyVoiceDesignSpec(value: unknown): asserts value is CosyVoiceDesignSpec {
  const item = object(value, "CosyVoiceDesignSpec", ["preferredName", "voicePrompt", "language"]);
  if (typeof item.preferredName !== "string" || !/^[A-Za-z0-9]{1,10}$/u.test(item.preferredName)) {
    throw new Error("preferredName must be alphanumeric and 1–10 characters");
  }
  nonempty(item.voicePrompt, "voicePrompt", 500);
  if (item.language !== "zh" && item.language !== "en") throw new Error("language must be zh or en");
}

export function sealCosyVoiceDesignSpec(value: CosyVoiceDesignSpec): CosyVoiceDesignSpec {
  verifyCosyVoiceDesignSpec(value);
  return canonicalize(value) as unknown as CosyVoiceDesignSpec;
}

export function verifyCosyVoiceDesignRequest(value: unknown): asserts value is CosyVoiceDesignRequest {
  const item = object(value, "CosyVoiceDesignRequest", ["preferredName", "voicePrompt", "previewText", "language"]);
  verifyCosyVoiceDesignSpec({ preferredName: item.preferredName, voicePrompt: item.voicePrompt, language: item.language });
  if (typeof item.previewText !== "string" || item.previewText.length < 15 || item.previewText.length > 200 || !item.previewText.trim()) {
    throw new Error("previewText must be 15–200 characters");
  }
}

export function sealCosyVoiceDesignRequest(value: CosyVoiceDesignRequest): CosyVoiceDesignRequest {
  verifyCosyVoiceDesignRequest(value);
  return canonicalize(value) as unknown as CosyVoiceDesignRequest;
}

export function verifyDesignedVoice(value: unknown): asserts value is DesignedVoice {
  const item = object(value, "DesignedVoice", ["voice", "targetModel", "preview"]);
  nonempty(item.voice, "voice");
  if (item.targetModel !== "cosyvoice-v3.5-flash") throw new Error("targetModel must be cosyvoice-v3.5-flash");
  const preview = object(item.preview, "preview", ["kind", "resource", "size", "mediaType"]);
  if (preview.kind !== "blob" || typeof preview.resource !== "string" || !/^res_.+/u.test(preview.resource)
    || !Number.isSafeInteger(preview.size) || (preview.size as number) <= 0 || preview.mediaType !== "audio/wav") {
    throw new Error("preview must be a nonempty WAV BlobRef");
  }
}

export function sealDesignedVoice(value: DesignedVoice): DesignedVoice {
  verifyDesignedVoice(value);
  return canonicalize(value) as unknown as DesignedVoice;
}

export function verifyCosyVoiceSpeechRequest(value: unknown): asserts value is CosyVoiceSpeechRequest {
  const item = object(value, "CosyVoiceSpeechRequest", ["voice", "text"]);
  verifyDesignedVoice(item.voice);
  nonempty(item.text, "text");
}

export function sealCosyVoiceSpeechRequest(value: CosyVoiceSpeechRequest): CosyVoiceSpeechRequest {
  verifyCosyVoiceSpeechRequest(value);
  return canonicalize(value) as unknown as CosyVoiceSpeechRequest;
}
