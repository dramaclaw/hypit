import assert from "node:assert/strict";
import test from "node:test";

import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import type { CanonicalValue, Need } from "@hypit/protocol";
import { credentialRef } from "@hypit/runtime";
import { sealSpeechEvidenceAudio } from "@hypit/speech";
import { speechEvidenceTypes } from "@hypit/speech-evidence";
import { whisperXCapabilities, whisperXRequestForEvidenceAudio } from "@hypit/whisperx";

import { createNewApiProvider } from "../src/provider.js";

function wav(sampleFrames: number): Uint8Array {
  const bytes = new Uint8Array(44 + sampleFrames * 2);
  const view = new DataView(bytes.buffer);
  const write = (offset: number, value: string): void => {
    for (let index = 0; index < value.length; index += 1) bytes[offset + index] = value.charCodeAt(index);
  };
  write(0, "RIFF");
  view.setUint32(4, bytes.byteLength - 8, true);
  write(8, "WAVE");
  write(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  write(36, "data");
  view.setUint32(40, sampleFrames * 2, true);
  return bytes;
}

async function invokeTranscription(evidenceWav: Uint8Array, fetcher: typeof fetch) {
  const resources = new MemoryResourceStore();
  const artifact = await resources.put(evidenceWav, "audio/wav");
  const request: Need = {
    id: "need:transcription",
    capability: whisperXCapabilities.alignment,
    returns: speechEvidenceTypes.alignedTranscript,
    constraints: whisperXRequestForEvidenceAudio(
      sealSpeechEvidenceAudio({ artifact, sampleFrames: 32_000 }), { language: "en" },
    ) as unknown as CanonicalValue,
    result: "record:transcription",
  };
  const registry = new EndpointRegistry();
  await createNewApiProvider({
    baseUrl: "https://newapi.example/v1",
    apiKey: credentialRef("platform", "newapi.key"),
    fetch: fetcher,
  }).install(registry);
  const selected = registry.resolve(request);
  assert.equal(selected.status, "resolved");
  assert.equal(selected.registration.kind, "immediate");
  return await selected.registration.handler({
    command: { kind: "fulfill-need", id: "command:transcription", need: request },
    need: request, resources, credentials: { apiKey: { secret: "test-key" } },
  });
}

test("NewAPI audio-transcribe returns exact word evidence from a direct multipart WAV", async () => {
  const evidenceWav = wav(32_000);
  let calls = 0;
  const result = await invokeTranscription(evidenceWav, async (url, init) => {
    calls += 1;
    assert.equal(String(url), "https://newapi.example/v1/audio/transcriptions");
    assert.equal(init?.method, "POST");
    assert.equal((init?.headers as Record<string, string>)?.authorization, "Bearer test-key");
    assert.equal((init?.headers as Record<string, string>)?.["content-type"], undefined);
    assert.ok(init?.body instanceof FormData);
    const form = init.body;
    assert.equal(form.get("model"), "audio-transcribe");
    assert.equal(form.get("language"), "en");
    assert.equal(form.get("response_format"), "verbose_json");
    assert.deepEqual(form.getAll("timestamp_granularities[]"), ["segment", "word"]);
    const file = form.get("file");
    assert.ok(file instanceof File);
    assert.equal(file.type, "audio/wav");
    assert.deepEqual(new Uint8Array(await file.arrayBuffer()), evidenceWav);
    return Response.json({
      text: "Hello world.", task: "transcribe", language: "english", duration: 2,
      segments: [{ id: 0, start: 0.1, end: 0.8, text: "Hello world." }],
      words: [
        { word: "Hello", start: 0.1, end: 0.4 },
        { word: "world", start: 0.4, end: 0.8 },
      ],
    });
  });
  assert.deepEqual(result.value, { kind: "inline", value: { passages: [{
    startSample: 1600, endSampleExclusive: 12800,
    words: [
      { text: "Hello", startSample: 1600, endSampleExclusive: 6400 },
      { text: "world", startSample: 6400, endSampleExclusive: 12800 },
    ],
    chars: [],
  }] } });
  assert.equal(calls, 1);
});

test("NewAPI transcription rejects nonconforming evidence before the paid request", async () => {
  const evidenceWav = wav(32_000);
  new DataView(evidenceWav.buffer).setUint32(24, 8_000, true);
  let calls = 0;
  await assert.rejects(
    () => invokeTranscription(evidenceWav, async () => { calls += 1; return Response.json({}); }),
    /16 kHz mono PCM s16 WAV/u,
  );
  assert.equal(calls, 0);
});

test("NewAPI transcription refuses text-only success without timestamp evidence", async () => {
  await assert.rejects(
    () => invokeTranscription(wav(32_000), async () => Response.json({ text: "Hello world." })),
    /no Segment or Word array/u,
  );
});

test("NewAPI transcription refuses spoken segments without timed words", async () => {
  await assert.rejects(
    () => invokeTranscription(wav(32_000), async () => Response.json({
      text: "Hello world.",
      segments: [{ start: 0.1, end: 0.8, text: "Hello world." }],
    })),
    /no timed words/u,
  );
});

test("NewAPI transcription refuses recognized words without timestamps", async () => {
  await assert.rejects(
    () => invokeTranscription(wav(32_000), async () => Response.json({
      text: "Hello world.",
      words: [{ word: "Hello", start: null, end: null }],
    })),
    /missing a timestamp/u,
  );
});

test("NewAPI transcription preserves a genuinely empty transcript for silence", async () => {
  const result = await invokeTranscription(wav(32_000), async () => Response.json({ text: "", segments: [] }));
  assert.deepEqual(result.value, { kind: "inline", value: { passages: [] } });
});

test("NewAPI transcription redacts upstream credentials and URLs", async () => {
  await assert.rejects(
    () => invokeTranscription(wav(32_000), async () => Response.json({
      error: { message: "test-key failed at https://private.example/upload?token=secret" },
    }, { status: 502 })),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.doesNotMatch(error.message, /test-key|private\.example|token=secret/u);
      assert.match(error.message, /\[redacted\]|\[redacted-url\]/u);
      return true;
    },
  );
});
