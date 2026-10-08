import assert from "node:assert/strict";
import test from "node:test";

import { artifactTypes } from "@hypit/artifact";
import { parseStructuredElement } from "@hypit/markup";
import type { SurfaceResolvedReference } from "@hypit/markup";
import { sealText, textTypes } from "@hypit/text";

import cosyPackage from "../src/activation.js";
import {
  cosyVoiceCapabilities, cosyVoiceComponent, cosyVoiceDesignFragment, cosyVoiceManifest, cosyVoiceSpeechFragment,
  cosyVoiceTypes, decodeCosyVoiceDesignSurface, decodeCosyVoiceSpeechSurface,
  sealCosyVoiceDesignRequest, sealDesignedVoice, verifyCosyVoiceDesignRequest,
  verifyDesignedVoice,
} from "../src/index.js";

const preview = { kind: "blob", resource: "res_preview", size: 44, mediaType: "audio/wav" } as const;
const design = { preferredName: "host1", voicePrompt: "A warm clear voice", previewText: "These are exact sample words.", language: "en" } as const;
const voice = { voice: "opaque-handle", targetModel: "cosyvoice-v3.5-flash", preview } as const;

test("design request accepts the exact fields and rejects invalid bounds", () => {
  assert.deepEqual(sealCosyVoiceDesignRequest(design), design);
  for (const invalid of [
    { ...design, preferredName: "bad-name" }, { ...design, preferredName: "12345678901" },
    { ...design, voicePrompt: "x".repeat(501) }, { ...design, voicePrompt: "" },
    { ...design, previewText: "x".repeat(14) }, { ...design, previewText: "x".repeat(201) },
    { ...design, language: "ja" }, { ...design, extra: true },
  ]) assert.throws(() => verifyCosyVoiceDesignRequest(invalid));
});

test("designed voice requires the fixed model and nonempty WAV preview", () => {
  assert.deepEqual(sealDesignedVoice(voice), voice);
  for (const invalid of [
    { ...voice, targetModel: "other" }, { ...voice, preview: { ...preview, size: 0 } },
    { ...voice, preview: { ...preview, mediaType: "audio/mpeg" } },
    { ...voice, preview: undefined }, { ...voice, voice: "" }, { ...voice, extra: true },
  ]) assert.throws(() => verifyDesignedVoice(invalid));
});

test("manifest and fragments expose typed design, preview, and speech needs", () => {
  assert.equal(cosyVoiceCapabilities.design.name, "cosyvoice-v3.5-flash-voice-design");
  assert.equal(cosyVoiceCapabilities.speech.name, "cosyvoice-v3.5-flash-speech");
  assert.equal(cosyVoiceManifest.capabilities[0]?.returns.name, cosyVoiceTypes.designedVoice.name);
  assert.equal(cosyVoiceManifest.capabilities[1]?.returns.name, artifactTypes.blob.name);
  assert.deepEqual(cosyVoiceDesignFragment.exports.map((item) => [item.name, item.type.name]), [
    ["preview", artifactTypes.blob.name], ["voice", cosyVoiceTypes.designedVoice.name],
  ]);
  assert.deepEqual(cosyVoiceSpeechFragment.exports.map((item) => item.name), ["audio"]);
});

test("component producers carry authored Text into design and speech, then project the preview Blob", async () => {
  const designResult = await cosyVoiceComponent.producers[0]!.handler({ inputs: {
    spec: { value: { kind: "inline", value: { preferredName: "host1", voicePrompt: "A warm clear voice", language: "en" } } },
    previewText: { value: { kind: "inline", value: sealText("These are exact sample words.") } },
  } } as never);
  assert.ok("voice" in designResult.needs);
  assert.deepEqual(designResult.needs.voice, design);

  const designedValue = { kind: "inline" as const, value: voice };
  const previewResult = await cosyVoiceComponent.producers[1]!.handler({ inputs: { voice: { value: designedValue } } } as never);
  assert.ok("preview" in previewResult.outputs);
  assert.deepEqual(previewResult.outputs.preview, preview);

  const speechResult = await cosyVoiceComponent.producers[2]!.handler({ inputs: {
    voice: { value: designedValue },
    speechText: { value: { kind: "inline", value: sealText("Speak this exact line.") } },
  } } as never);
  assert.ok("audio" in speechResult.needs);
  assert.deepEqual(speechResult.needs.audio, { voice, text: "Speak this exact line." });
});

const textRef: SurfaceResolvedReference = {
  path: "script.sample.speech", ref: { kind: "record", id: "script.sample.speech" }, type: textTypes.text,
  record: { id: "script.sample.speech", type: textTypes.text, value: { kind: "inline", value: sealText("These are exact sample words.") } },
};
const voiceRef: SurfaceResolvedReference = {
  path: "host.voice", ref: { kind: "record", id: "host.voice" }, type: cosyVoiceTypes.designedVoice,
};
const context = (source: string, refs: readonly SurfaceResolvedReference[] = [textRef, voiceRef]) => ({
  sourceName: "cosy.svml",
  element: parseStructuredElement({ name: "cosy.svml", text: source }, 0).element,
  resolveReference: (path: string) => refs.find((item) => item.path === path),
  resolveAsset: () => { throw new Error("no asset"); },
});

test("VoiceDesign publishes typed voice and preview references", async () => {
  const result = await decodeCosyVoiceDesignSurface(context('<cosy:VoiceDesign id="host" name="host1" language="en" speech={script.sample.speech}>A warm clear voice</cosy:VoiceDesign>'));
  assert.deepEqual(result.components[0]?.outputs, { voice: "host.voice", preview: "host.preview" });
  assert.equal(result.records[0]?.type.name, cosyVoiceTypes.designSpec.name);
  assert.deepEqual(result.components[0]?.inputs.previewText, textRef.ref);
  assert.equal(result.fragments[0]?.id, cosyVoiceDesignFragment.id);
});

test("Speech publishes audio and requires a DesignedVoice reference", async () => {
  const result = await decodeCosyVoiceSpeechSurface(context('<cosy:Speech id="line" speech={script.sample.speech} voice={host.voice}/>'));
  assert.deepEqual(result.components[0]?.outputs, { audio: "line.audio" });
  assert.deepEqual(result.components[0]?.inputs.voice, voiceRef.ref);
  assert.equal(result.fragments[0]?.id, cosyVoiceSpeechFragment.id);
});

test("surfaces reject malformed references, bodies, and attributes", async () => {
  for (const source of [
    '<cosy:VoiceDesign id="host" name="host1" language="en">Description</cosy:VoiceDesign>',
    '<cosy:VoiceDesign id="host" name="host1" language="en" speech="literal">Description</cosy:VoiceDesign>',
    '<cosy:VoiceDesign id="host" name="host1" language="en" speech={script.sample.speech}></cosy:VoiceDesign>',
    '<cosy:VoiceDesign id="host" name="host1" language="en" speech={script.sample.speech} extra="x">Description</cosy:VoiceDesign>',
  ]) await assert.rejects(async () => decodeCosyVoiceDesignSurface(context(source)));
  for (const source of [
    '<cosy:Speech id="line" speech={script.sample.speech}/>',
    '<cosy:Speech id="line" speech={script.sample.speech} voice="literal"/>',
    '<cosy:Speech id="line" speech={script.sample.speech} voice={host.voice}>Words</cosy:Speech>',
    '<cosy:Speech id="line" speech={script.sample.speech} voice={host.voice} extra="x"/>',
  ]) await assert.rejects(async () => decodeCosyVoiceSpeechSurface(context(source)));
  await assert.rejects(async () => decodeCosyVoiceSpeechSurface(context('<cosy:Speech id="line" speech={script.sample.speech} voice={host.voice}/> ', [textRef, { ...voiceRef, type: artifactTypes.blob }])));
});

test("activation registers both author surfaces", () => {
  assert.equal(cosyPackage.format, "hypit.node-package@1");
  assert.equal(cosyPackage.hostFacets.length, 2);
});
