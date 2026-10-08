import { assertExactAttributes, textAttribute } from "@hypit/markup";
import type { MarkupAttributeValue, StructuredElement, StructuredSurfaceHandler, SurfaceResolvedReference } from "@hypit/markup";
import { sameType } from "@hypit/protocol";
import type { CanonicalValue } from "@hypit/protocol";
import { textTypes, verifyText } from "@hypit/text";

import { cosyVoiceDesignFragment, cosyVoiceSpeechFragment } from "./fragment.js";
import { cosyVoiceTypes } from "./manifest.js";
import { sealCosyVoiceDesignSpec } from "./program.js";

function reference(element: StructuredElement, name: string, expected: SurfaceResolvedReference["type"], resolve: (path: string) => SurfaceResolvedReference | undefined): SurfaceResolvedReference {
  const raw: MarkupAttributeValue | undefined = element.attributes[name];
  if (typeof raw !== "object" || raw.kind !== "reference" || !raw.path) throw new Error(`${element.name}.${name} must be a whole-value reference`);
  const result = resolve(raw.path);
  if (result === undefined || !sameType(result.type, expected)) throw new Error(`${element.name}.${name} must reference ${expected.name}`);
  if (sameType(expected, textTypes.text) && result.record !== undefined) {
    if (result.record.value.kind !== "inline") throw new Error(`${element.name}.${name} must reference Text`);
    verifyText(result.record.value.value);
  }
  return result;
}

function body(element: StructuredElement): string {
  if (element.children.some((child) => child.kind === "element")) throw new Error(`${element.name} accepts text only`);
  const lines = element.children.map((child) => child.kind === "text" ? child.value : "").join("").replaceAll("\r\n", "\n").split("\n");
  while (lines[0]?.trim() === "") lines.shift();
  while (lines.at(-1)?.trim() === "") lines.pop();
  const indent = Math.min(...lines.filter((line) => line.trim()).map((line) => /^\s*/u.exec(line)?.[0].length ?? 0));
  return lines.map((line) => line.slice(Number.isFinite(indent) ? indent : 0).trimEnd()).join("\n").trim();
}

export const decodeCosyVoiceDesignSurface: StructuredSurfaceHandler = ({ element, resolveReference }) => {
  assertExactAttributes(element, ["id", "name", "language", "speech"]);
  const id = textAttribute(element, "id");
  const previewText = reference(element, "speech", textTypes.text, resolveReference);
  const spec = sealCosyVoiceDesignSpec({
    preferredName: textAttribute(element, "name"),
    voicePrompt: body(element),
    language: textAttribute(element, "language") as "zh" | "en",
  });
  const specId = `${id}.spec`;
  return {
    records: [{ id: specId, type: cosyVoiceTypes.designSpec, value: { kind: "inline", value: spec as unknown as CanonicalValue }, range: element.range }],
    components: [{ id, fragment: cosyVoiceDesignFragment.id, inputs: { spec: { kind: "record", id: specId }, previewText: previewText.ref }, outputs: { voice: `${id}.voice`, preview: `${id}.preview` }, range: element.range }],
    fragments: [cosyVoiceDesignFragment],
  };
};

export const decodeCosyVoiceSpeechSurface: StructuredSurfaceHandler = ({ element, resolveReference }) => {
  assertExactAttributes(element, ["id", "speech", "voice"]);
  if (element.children.some((child) => child.kind === "element" || child.value.trim())) throw new Error(`${element.name} must be empty`);
  const id = textAttribute(element, "id");
  const speechText = reference(element, "speech", textTypes.text, resolveReference);
  const voice = reference(element, "voice", cosyVoiceTypes.designedVoice, resolveReference);
  return {
    records: [],
    components: [{ id, fragment: cosyVoiceSpeechFragment.id, inputs: { voice: voice.ref, speechText: speechText.ref }, outputs: { audio: `${id}.audio` }, range: element.range }],
    fragments: [cosyVoiceSpeechFragment],
  };
};
