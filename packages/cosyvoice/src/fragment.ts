import { artifactTypes } from "@hypit/artifact";
import { sealGraphFragment } from "@hypit/elaborator";
import { textTypes } from "@hypit/text";

import { cosyVoiceProducers, cosyVoiceTypes } from "./manifest.js";

const input = (name: string) => ({ kind: "fragment-input" as const, name });
const operation = (id: string) => ({ kind: "fragment-operation" as const, operation: id });

export const cosyVoiceDesignFragment = sealGraphFragment({
  inputs: [{ name: "spec", type: cosyVoiceTypes.designSpec }, { name: "previewText", type: textTypes.text }],
  operations: [
    { id: "design-voice", producer: cosyVoiceProducers.design, inputs: { spec: input("spec"), previewText: input("previewText") }, result: { kind: "need", name: "voice" } },
    { id: "project-preview", producer: cosyVoiceProducers.preview, inputs: { voice: operation("design-voice") }, result: { kind: "output", name: "preview" } },
  ],
  exports: [
    { name: "voice", type: cosyVoiceTypes.designedVoice, root: operation("design-voice") },
    { name: "preview", type: artifactTypes.blob, root: operation("project-preview") },
  ],
});

export const cosyVoiceSpeechFragment = sealGraphFragment({
  inputs: [{ name: "voice", type: cosyVoiceTypes.designedVoice }, { name: "speechText", type: textTypes.text }],
  operations: [{ id: "speak", producer: cosyVoiceProducers.speech, inputs: { voice: input("voice"), speechText: input("speechText") }, result: { kind: "need", name: "audio" } }],
  exports: [{ name: "audio", type: artifactTypes.blob, root: operation("speak") }],
});
