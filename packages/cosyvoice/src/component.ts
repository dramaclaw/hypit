import type { ComponentPackage } from "@hypit/component-kit";
import type { StoredValue } from "@hypit/protocol";
import { canonicalize } from "@hypit/protocol";
import { verifyText } from "@hypit/text";

import { cosyVoiceProducers, cosyVoiceTypes } from "./manifest.js";
import { verifyCosyVoiceDesignSpec, verifyDesignedVoice, sealCosyVoiceDesignRequest, sealCosyVoiceSpeechRequest } from "./program.js";

function inline(value: StoredValue | undefined, subject: string): unknown {
  if (value?.kind !== "inline") throw new Error(`${subject} must be inline`);
  return value.value;
}

function text(value: StoredValue | undefined): string {
  const item = inline(value, "Text");
  verifyText(item);
  return item.value;
}

export const cosyVoiceComponent = {
  validators: [
    { type: cosyVoiceTypes.designSpec, handler: ({ value }) => verifyCosyVoiceDesignSpec(inline(value, "CosyVoiceDesignSpec")) },
    { type: cosyVoiceTypes.designedVoice, handler: ({ value }) => verifyDesignedVoice(inline(value, "DesignedVoice")) },
  ],
  producers: [
    { producer: cosyVoiceProducers.design, handler: ({ inputs }) => {
      const spec = inline(inputs.spec?.value, "CosyVoiceDesignSpec");
      verifyCosyVoiceDesignSpec(spec);
      return { outputs: {}, needs: { voice: canonicalize(sealCosyVoiceDesignRequest({ ...spec, previewText: text(inputs.previewText?.value) })) } };
    } },
    { producer: cosyVoiceProducers.preview, handler: ({ inputs }) => {
      const voice = inline(inputs.voice?.value, "DesignedVoice");
      verifyDesignedVoice(voice);
      return { outputs: { preview: voice.preview }, needs: {} };
    } },
    { producer: cosyVoiceProducers.speech, handler: ({ inputs }) => {
      const voice = inline(inputs.voice?.value, "DesignedVoice");
      verifyDesignedVoice(voice);
      return { outputs: {}, needs: { audio: canonicalize(sealCosyVoiceSpeechRequest({ voice, text: text(inputs.speechText?.value) })) } };
    } },
  ],
} satisfies ComponentPackage;
