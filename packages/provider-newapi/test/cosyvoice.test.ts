import assert from "node:assert/strict";
import test from "node:test";
import { inspect } from "node:util";

import { cosyVoiceCapabilities, cosyVoiceTypes } from "@hypit/cosyvoice";
import { EndpointRegistry, MemoryResourceStore } from "@hypit/driver-node";
import type { CanonicalValue, Need } from "@hypit/protocol";
import { credentialRef } from "@hypit/runtime";
import { artifactTypes } from "@hypit/artifact";

import { createNewApiProvider } from "../src/provider.js";

const credentials = { apiKey: { secret: "test-secret-key" } };
const voice = "opaque-voice.handle";
const signedUrl = "https://voice-assets.oss-cn-shanghai.aliyuncs.com/signed.wav?signature=private";
const wav = new Uint8Array(46);
wav.set(Buffer.from("RIFF", "ascii"), 0);
wav.set(Buffer.from("WAVE", "ascii"), 8);
wav.set(Buffer.from("fmt ", "ascii"), 12);
wav.set(Buffer.from("data", "ascii"), 36);
const wavHeader = new DataView(wav.buffer);
wavHeader.setUint32(4, wav.byteLength - 8, true);
wavHeader.setUint32(16, 16, true);
wavHeader.setUint16(20, 1, true);
wavHeader.setUint16(22, 1, true);
wavHeader.setUint32(24, 24_000, true);
wavHeader.setUint32(28, 48_000, true);
wavHeader.setUint16(32, 2, true);
wavHeader.setUint16(34, 16, true);
wavHeader.setUint32(40, 2, true);
wavHeader.setInt16(44, 1000, true);

function need(capability: Need["capability"], returns: Need["returns"], constraints: unknown): Need {
  return { id: "need:cosy", capability, returns, constraints: constraints as CanonicalValue, result: "record:cosy" };
}

async function invoke(request: Need, fetcher: typeof fetch, resources = new MemoryResourceStore(),
  audioAssetOrigins?: readonly string[], baseUrl = "https://gateway.example/v1") {
  const registry = new EndpointRegistry();
  await createNewApiProvider({
    baseUrl,
    apiKey: credentialRef("platform", "newapi.key"),
    ...(audioAssetOrigins === undefined ? {} : { audioAssetOrigins }),
    fetch: fetcher,
  }).install(registry);
  const resolution = registry.resolve(request);
  assert.equal(resolution.status, "resolved");
  assert.equal(resolution.registration.kind, "immediate");
  const result = await resolution.registration.handler({
    command: { kind: "fulfill-need", id: "command:cosy", need: request },
    need: request, resources, credentials,
  });
  return { result, resources };
}

const designRequest = {
  preferredName: "host1",
  voicePrompt: "温暖自然的年轻女性声音，吐字清晰。",
  previewText: "你好，这是一段足够长的音色设计预览文本。",
  language: "zh",
};

test("voice design stores WAV preview; returned opaque ID drives signed-URL speech", async () => {
  const requests: string[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push(url);
    if (url.endsWith("/audio/voice-designs")) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: "voice-enrollment", target_model: "cosyvoice-v3.5-flash",
        preferred_name: "host1", voice_prompt: designRequest.voicePrompt,
        preview_text: designRequest.previewText, language: "zh",
        sample_rate: 24_000, response_format: "wav",
      });
      return Response.json({ object: "audio.voice", voice, target_model: "cosyvoice-v3.5-flash", preview_audio: { data: Buffer.from(wav).toString("base64") } });
    }
    if (url.endsWith("/audio/speech")) {
      assert.deepEqual(JSON.parse(String(init?.body)), {
        model: "cosyvoice-v3.5-flash", input: "欢迎使用。", voice, response_format: "wav",
      });
      return Response.json({ audio: { url: signedUrl } });
    }
    assert.equal(url, signedUrl);
    assert.equal(init?.headers, undefined, "signed audio download must not forward API credentials");
    assert.equal(init?.redirect, "error", "signed audio download must reject redirects");
    return new Response(wav, { headers: { "content-type": "audio/wav" } });
  };
  const resources = new MemoryResourceStore();
  const design = await invoke(need(cosyVoiceCapabilities.design, cosyVoiceTypes.designedVoice, designRequest), fetcher, resources);
  assert.equal(design.result.value.kind, "inline");
  const designed = design.result.value.value as Record<string, unknown>;
  assert.equal(designed.voice, voice);
  assert.equal(designed.targetModel, "cosyvoice-v3.5-flash");
  const preview = designed.preview as { resource: Parameters<typeof resources.get>[0]; mediaType: string };
  assert.equal(preview.mediaType, "audio/wav");
  assert.deepEqual(await resources.get(preview.resource), wav);

  const speech = await invoke(need(cosyVoiceCapabilities.speech, artifactTypes.blob, {
    voice: designed, text: "欢迎使用。",
  }), fetcher, resources);
  assert.equal(speech.result.value.kind, "blob");
  assert.equal(speech.result.value.mediaType, "audio/wav");
  assert.deepEqual(await resources.get(speech.result.value.resource), wav);
  assert.deepEqual(requests, ["https://gateway.example/v1/audio/voice-designs", "https://gateway.example/v1/audio/speech", signedUrl]);
});

test("rejects untrusted CosyVoice audio destinations before download", async () => {
  const resources = new MemoryResourceStore();
  const preview = await resources.put(wav, "audio/wav");
  const request = need(cosyVoiceCapabilities.speech, artifactTypes.blob, {
    voice: { voice, targetModel: "cosyvoice-v3.5-flash", preview }, text: "Hello there",
  });
  for (const url of [
    "https://127.0.0.1/private.wav",
    "https://user:password@voice-assets.oss-cn-shanghai.aliyuncs.com/private.wav",
    "https://voice-assets.oss-cn-shanghai.aliyuncs.com.evil.example/private.wav",
    "https://voice-assets.oss-cn-shanghai-internal.aliyuncs.com/private.wav",
    "https://voice-assets.oss-cn-shanghai.aliyuncs.com:8443/private.wav",
    "https://voice-assets.oss-cn-shanghai.aliyuncs.com/private.wav#fragment",
  ]) {
    let calls = 0;
    await assert.rejects(() => invoke(request, async () => {
      calls++;
      return Response.json({ audio: { url } });
    }, resources), `must reject ${url}`);
    assert.equal(calls, 1, `must reject ${url} before a second fetch`);
  }
});

test("accepts an explicitly trusted audio origin only when configured", async () => {
  const resources = new MemoryResourceStore();
  const preview = await resources.put(wav, "audio/wav");
  const request = need(cosyVoiceCapabilities.speech, artifactTypes.blob, {
    voice: { voice, targetModel: "cosyvoice-v3.5-flash", preview }, text: "Hello there",
  });
  const url = "https://audio.example/signed.wav?signature=private";
  let calls = 0;
  const fetcher: typeof fetch = async (input) => {
    calls++;
    return String(input).endsWith("/audio/speech") ? Response.json({ audio: { url } })
      : new Response(wav, { headers: { "content-type": "audio/wav" } });
  };
  await assert.rejects(() => invoke(request, fetcher, resources));
  assert.equal(calls, 1);
  const { result } = await invoke(request, fetcher, resources, ["https://audio.example"]);
  assert.equal(result.value.kind, "blob");
  assert.equal(calls, 3);
});

test("accepts same-origin audio from an explicit loopback HTTP gateway", async () => {
  const resources = new MemoryResourceStore();
  const preview = await resources.put(wav, "audio/wav");
  const request = need(cosyVoiceCapabilities.speech, artifactTypes.blob, {
    voice: { voice, targetModel: "cosyvoice-v3.5-flash", preview }, text: "Hello there",
  });
  const url = "http://127.0.0.1:3000/audio/signed.wav";
  const requests: string[] = [];
  const { result } = await invoke(request, async (input, init) => {
    requests.push(String(input));
    if (String(input).endsWith("/audio/speech")) return Response.json({ audio: { url } });
    assert.equal(init?.redirect, "error");
    return new Response(wav, { headers: { "content-type": "audio/wav" } });
  }, resources, undefined, "http://127.0.0.1:3000/v1");
  assert.equal(result.value.kind, "blob");
  assert.deepEqual(requests, ["http://127.0.0.1:3000/v1/audio/speech", url]);
});

test("speech accepts a binary WAV response", async () => {
  const resources = new MemoryResourceStore();
  const preview = await resources.put(wav, "audio/wav");
  const request = need(cosyVoiceCapabilities.speech, artifactTypes.blob, {
    voice: { voice, targetModel: "cosyvoice-v3.5-flash", preview }, text: "Hello there",
  });
  const { result } = await invoke(request, async () => new Response(wav, { headers: { "content-type": "audio/wav" } }), resources);
  assert.equal(result.value.kind, "blob");
  assert.deepEqual(await resources.get(result.value.resource), wav);
});

test("rejects invalid design responses before storing a preview", async () => {
  const emptyData = wav.slice(0, 44);
  new DataView(emptyData.buffer).setUint32(4, emptyData.byteLength - 8, true);
  new DataView(emptyData.buffer).setUint32(40, 0, true);
  for (const response of [
    { target_model: "cosyvoice-v3.5-flash", preview_audio: { data: Buffer.from(wav).toString("base64") } },
    { voice: "  ", target_model: "cosyvoice-v3.5-flash", preview_audio: { data: Buffer.from(wav).toString("base64") } },
    { voice, target_model: "other-model", preview_audio: { data: Buffer.from(wav).toString("base64") } },
    { voice, target_model: "cosyvoice-v3.5-flash", preview_audio: { data: "%%%" } },
    { voice, target_model: "cosyvoice-v3.5-flash", preview_audio: { data: Buffer.from("not wav").toString("base64") } },
    { voice, target_model: "cosyvoice-v3.5-flash", preview_audio: { data: Buffer.from(wav.subarray(0, 12)).toString("base64") } },
    { voice, target_model: "cosyvoice-v3.5-flash", preview_audio: { data: Buffer.from(wav.subarray(0, 45)).toString("base64") } },
    { voice, target_model: "cosyvoice-v3.5-flash", preview_audio: { data: Buffer.from(emptyData).toString("base64") } },
  ]) {
    const resources = new MemoryResourceStore();
    await assert.rejects(() => invoke(need(cosyVoiceCapabilities.design, cosyVoiceTypes.designedVoice, designRequest), async () => Response.json(response), resources));
  }
});

test("rejects wrong target model before paid speech call", async () => {
  let calls = 0;
  const resources = new MemoryResourceStore();
  const preview = await resources.put(wav, "audio/wav");
  await assert.rejects(() => invoke(need(cosyVoiceCapabilities.speech, artifactTypes.blob, {
    voice: { voice, targetModel: "other-model", preview }, text: "Hello there",
  }), async () => { calls++; return Response.json({}); }, resources));
  assert.equal(calls, 0);
});

test("rejects missing speech URL before downloading", async () => {
  const resources = new MemoryResourceStore();
  const preview = await resources.put(wav, "audio/wav");
  await assert.rejects(() => invoke(need(cosyVoiceCapabilities.speech, artifactTypes.blob, {
    voice: { voice, targetModel: "cosyvoice-v3.5-flash", preview }, text: "Hello there",
  }), async () => Response.json({ audio: {} }), resources));
});

test("rejects non-audio and empty signed downloads", async () => {
  for (const download of [
    new Response("not audio", { headers: { "content-type": "text/plain" } }),
    new Response(new Uint8Array(), { headers: { "content-type": "audio/wav" } }),
  ]) {
    const resources = new MemoryResourceStore();
    const preview = await resources.put(wav, "audio/wav");
    let calls = 0;
    await assert.rejects(() => invoke(need(cosyVoiceCapabilities.speech, artifactTypes.blob, {
      voice: { voice, targetModel: "cosyvoice-v3.5-flash", preview }, text: "Hello there",
    }), async (input) => {
      calls++;
      return String(input).endsWith("/audio/speech")
        ? Response.json({ audio: { url: signedUrl } }) : download.clone();
    }, resources));
    assert.equal(calls, 2);
  }
});

test("upstream errors redact voice handle, key, and signed URL", async () => {
  const resources = new MemoryResourceStore();
  const preview = await resources.put(wav, "audio/wav");
  const request = need(cosyVoiceCapabilities.speech, artifactTypes.blob, {
    voice: { voice, targetModel: "cosyvoice-v3.5-flash", preview }, text: "Hello there",
  });
  await assert.rejects(() => invoke(request, async () => Response.json({ error: { message: `${voice} test-secret-key ${signedUrl}` } }, { status: 400 }), resources), (error) => {
    const message = inspect(error, { depth: 10 });
    assert.doesNotMatch(message, /opaque-voice|test-secret-key|signature=private|audio\.example/u);
    assert.match(message, /redacted/u);
    return true;
  });
});
