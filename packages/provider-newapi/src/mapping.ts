import type { GenerationWireMapping } from "@hypit/generation";
import type { ModuleRef } from "@hypit/protocol";

const GPT_IMAGE: ModuleRef = { name: "@hypit/gpt-image", version: "1" };
const NANO_BANANA: ModuleRef = { name: "@hypit/nano-banana", version: "1" };
const SEEDREAM: ModuleRef = { name: "@hypit/seedream", version: "1" };
const SEEDANCE: ModuleRef = { name: "@hypit/seedance", version: "1" };
const MINIMAX_H3: ModuleRef = { name: "@hypit/minimax-h3", version: "1" };
const MIMO_SPEECH: ModuleRef = { name: "@hypit/mimo-speech", version: "1" };

const imageFields = {
  prompt: { as: "value", field: "prompt" },
  images: { as: "urlArray", field: "image" },
  aspectRatio: { as: "value", field: "aspect_ratio" },
  resolution: { as: "value", field: "resolution" },
} as const satisfies GenerationWireMapping["fields"];

const seedanceFields = {
  prompt: { as: "value", field: "prompt" },
  referenceImage: { as: "urlArray", field: "reference_images", resourceFields: ["personReference"] },
  referenceVideo: { as: "urlArray", field: "reference_videos", resourceFields: ["personReference"] },
  referenceAudio: { as: "urlArray", field: "reference_audios" },
  firstFrame: { as: "url", field: "first_frame", resourceFields: ["personReference"] },
  lastFrame: { as: "url", field: "last_frame", resourceFields: ["personReference"] },
  resolution: { as: "value", field: "resolution" },
  aspectRatio: { as: "value", field: "aspect_ratio" },
  duration: { as: "value", field: "seconds" },
  generateAudio: { as: "value", field: "generate_audio" },
  webSearch: { as: "value", field: "web_search" },
} as const satisfies GenerationWireMapping["fields"];

const seedance = (name: string, model: string): GenerationWireMapping => ({
  capability: { module: SEEDANCE, name },
  result: "video",
  routes: [{ model }],
  fields: seedanceFields,
});

export const newApiMappings: readonly GenerationWireMapping[] = [
  {
    capability: { module: GPT_IMAGE, name: "gpt-image-2" },
    result: "image",
    routes: [{ model: "LingShan-G2" }],
    fields: {
      ...imageFields,
      background: { as: "value", field: "background" },
    },
  },
  ...([[
    "nano-banana-2", "LingShan-NB-2",
  ], [
    "nano-banana-pro", "LingShan-NB-Pro",
  ]] as const).map(([name, model]): GenerationWireMapping => ({
    capability: { module: NANO_BANANA, name },
    result: "image",
    routes: [{ model }],
    fields: {
      ...imageFields,
      outputFormat: { as: "value", field: "output_format" },
    },
  })),
  {
    capability: { module: SEEDREAM, name: "seedream-5-lite" },
    result: "image",
    routes: [{ model: "seedream-5.0-lite" }],
    fields: {
      prompt: { as: "value", field: "prompt" },
      images: { as: "urlArray", field: "image" },
      aspectRatio: { as: "value", field: "aspect_ratio" },
      quality: { as: "value", field: "quality" },
      outputFormat: { as: "value", field: "output_format" },
      nsfwCheck: { as: "value", field: "nsfw_check" },
    },
  },
  seedance("seedance-2", "seedance-2.0"),
  seedance("seedance-2-fast", "seedance-2.0-fast"),
  seedance("seedance-2-mini", "seedance-2.0-mini"),
  seedance("seedance-2.5", "seedance-2.5"),
  {
    capability: { module: MINIMAX_H3, name: "minimax-h3" },
    result: "video",
    routes: [{ model: "MiniMax-H3" }],
    fields: {
      prompt: { as: "value", field: "prompt" },
      referenceImage: { as: "urlArray", field: "reference_images" },
      referenceVideo: { as: "urlArray", field: "reference_videos" },
      referenceAudio: { as: "urlArray", field: "reference_audios" },
      firstFrame: { as: "url", field: "first_frame" },
      lastFrame: { as: "url", field: "last_frame" },
      resolution: { as: "value", field: "resolution" },
      aspectRatio: { as: "value", field: "aspect_ratio" },
      duration: { as: "value", field: "seconds" },
    },
  },
  {
    capability: { module: MIMO_SPEECH, name: "mimo-v2.5-tts-voiceclone" },
    result: "audio",
    routes: [{ model: "index-tts-2" }],
    fields: {
      text: { as: "value", field: "input" },
      instruction: { as: "value", field: "emotion_prompt" },
      voiceReference: { as: "url", field: "audio_url" },
    },
  },
];
