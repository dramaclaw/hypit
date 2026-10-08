import { artifactDependency, artifactTypes } from "@hypit/artifact";
import { blobRefObjectSchema } from "@hypit/protocol";
import type { CapabilityRef, ModuleManifest, ProducerRef, TypeRef, ValueSchema } from "@hypit/protocol";
import { textDependency, textTypes } from "@hypit/text";

export const cosyVoiceModuleRef = { name: "@hypit/cosyvoice", version: "1" } as const;
export const cosyVoiceTypes = {
  designedVoice: { module: cosyVoiceModuleRef, name: "DesignedVoice" },
  designSpec: { module: cosyVoiceModuleRef, name: "CosyVoiceDesignSpec" },
} satisfies Record<string, TypeRef>;
export const cosyVoiceCapabilities = {
  design: { module: cosyVoiceModuleRef, name: "cosyvoice-v3.5-flash-voice-design" },
  speech: { module: cosyVoiceModuleRef, name: "cosyvoice-v3.5-flash-speech" },
} satisfies Record<string, CapabilityRef>;
export const cosyVoiceProducers = {
  design: { module: cosyVoiceModuleRef, name: "request-cosyvoice-design" },
  preview: { module: cosyVoiceModuleRef, name: "project-cosyvoice-preview" },
  speech: { module: cosyVoiceModuleRef, name: "request-cosyvoice-speech" },
} satisfies Record<string, ProducerRef>;

export const cosyVoiceDesignedVoiceSchema: ValueSchema = { kind: "object", fields: {
  voice: { schema: { kind: "string", minLength: 1 } },
  targetModel: { schema: { kind: "literal", value: "cosyvoice-v3.5-flash" } },
  preview: { schema: blobRefObjectSchema(["audio/wav"]) },
} };
export const cosyVoiceDesignSpecSchema: ValueSchema = { kind: "object", fields: {
  preferredName: { schema: { kind: "string", minLength: 1, maxLength: 10 } },
  voicePrompt: { schema: { kind: "string", minLength: 1, maxLength: 500 } },
  language: { schema: { kind: "string", enum: ["zh", "en"] } },
} };

export const cosyVoiceMarkupSurfaces = [{
  name: "voiceDesign", tag: "VoiceDesign", mode: "structured", outputs: [cosyVoiceTypes.designSpec, cosyVoiceTypes.designedVoice, artifactTypes.blob],
  vocabulary: {
    summary: "Designs a reusable CosyVoice voice and its WAV preview.",
    attributes: [
      { name: "id", kind: "identifier", required: true, summary: "Names the design." },
      { name: "name", kind: "literal", required: true, summary: "Alphanumeric preferred name, 1–10 characters." },
      { name: "language", kind: "literal", required: true, values: ["zh", "en"], summary: "Preview language." },
      { name: "speech", kind: "reference", required: true, accepts: [textTypes.text], summary: "Preview words from Text." },
    ],
    ports: [
      { name: "voice", type: cosyVoiceTypes.designedVoice, summary: "Reusable voice handle." },
      { name: "preview", type: artifactTypes.blob, summary: "WAV preview." },
    ],
    text: "Required voice description, up to 500 characters.",
    example: '<cosy:VoiceDesign id="host" name="host1" language="zh" speech={sample.speech}>Warm and clear</cosy:VoiceDesign>',
  },
}, {
  name: "speech", tag: "Speech", mode: "structured", outputs: [artifactTypes.blob],
  vocabulary: {
    summary: "Speaks Text with a DesignedVoice.",
    attributes: [
      { name: "id", kind: "identifier", required: true, summary: "Names the speech." },
      { name: "speech", kind: "reference", required: true, accepts: [textTypes.text], summary: "Words to speak." },
      { name: "voice", kind: "reference", required: true, accepts: [cosyVoiceTypes.designedVoice], summary: "Designed voice." },
    ],
    ports: [{ name: "audio", type: artifactTypes.blob, summary: "Generated audio." }],
    example: '<cosy:Speech id="line" speech={line.speech} voice={host.voice}/>',
  },
}] as const;

export const cosyVoiceManifest: ModuleManifest = {
  format: "hypit.module@1", name: cosyVoiceModuleRef.name, version: cosyVoiceModuleRef.version,
  dependencies: [artifactDependency, textDependency],
  types: [{ name: cosyVoiceTypes.designSpec.name }, { name: cosyVoiceTypes.designedVoice.name }],
  capabilities: [
    { name: cosyVoiceCapabilities.design.name, returns: cosyVoiceTypes.designedVoice },
    { name: cosyVoiceCapabilities.speech.name, returns: artifactTypes.blob },
  ],
  producers: [
    { name: cosyVoiceProducers.design.name, inputs: [{ name: "spec", type: cosyVoiceTypes.designSpec }, { name: "previewText", type: textTypes.text }], outputs: [], needs: [{ name: "voice", capability: cosyVoiceCapabilities.design, returns: cosyVoiceTypes.designedVoice }] },
    { name: cosyVoiceProducers.preview.name, inputs: [{ name: "voice", type: cosyVoiceTypes.designedVoice }], outputs: [{ name: "preview", type: artifactTypes.blob }], needs: [] },
    { name: cosyVoiceProducers.speech.name, inputs: [{ name: "voice", type: cosyVoiceTypes.designedVoice }, { name: "speechText", type: textTypes.text }], outputs: [], needs: [{ name: "audio", capability: cosyVoiceCapabilities.speech, returns: artifactTypes.blob }] },
  ],
};
