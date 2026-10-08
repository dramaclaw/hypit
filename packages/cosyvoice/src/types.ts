import type { BlobRef } from "@hypit/protocol";

export type CosyVoiceDesignRequest = {
  readonly preferredName: string;
  readonly voicePrompt: string;
  readonly previewText: string;
  readonly language: "zh" | "en";
};

export type DesignedVoice = {
  readonly voice: string;
  readonly targetModel: "cosyvoice-v3.5-flash";
  readonly preview: BlobRef;
};

export type CosyVoiceSpeechRequest = {
  readonly voice: DesignedVoice;
  readonly text: string;
};

export type CosyVoiceDesignSpec = Pick<CosyVoiceDesignRequest, "preferredName" | "voicePrompt" | "language">;
