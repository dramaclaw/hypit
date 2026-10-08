# NewAPI CosyVoice Design and Speech Implementation Plan

> **For agentic workers:** Implement these tasks inline in this worktree. Use test-driven development: every production behavior starts with a failing test.

**Goal:** Author a CosyVoice 3.5 Flash voice from text and reuse its gateway voice ID for speech in the same Hypit Build.

**Architecture:** A new `@hypit/cosyvoice` package owns the two exact capabilities, typed `DesignedVoice` value, graph fragments, and `<cosy:VoiceDesign>` / `<cosy:Speech>` surfaces. `@dramaclaw/provider-newapi` translates the two requests to the gateway, stores preview and speech audio in the ResourceStore, and the starter Profile binds both capabilities to `newapi.personal`.

**Tech Stack:** TypeScript, Hypit Module/Component/Fragment/Markup contracts, Node `fetch`, `node --test` with `tsx`, pnpm workspace.

## Global Constraints

- The design gateway request uses `model: "voice-enrollment"` and `target_model: "cosyvoice-v3.5-flash"`; the speech request uses `model: "cosyvoice-v3.5-flash"`.
- `preferred_name` is alphanumeric, 1–10 characters; `voice_prompt` is nonempty and at most 500 characters; `preview_text` is 15–200 characters; language is explicitly `zh` or `en`.
- Design requests use `sample_rate: 24000`, `response_format: "wav"`, and require a nonempty Base64 WAV preview. Speech requests use `response_format: "wav"`.
- The gateway voice identifier remains opaque; it is not derived from preview bytes and is not written into Source or Profile JSON.
- Speech accepts gateway `audio.url` JSON or binary audio; signed URLs and credentials never appear in errors.
- Existing Profile bindings and the already modified transcription implementation are preserved.

---

### Task 1: CosyVoice model and graph contract

**Files:**
- Create: `packages/cosyvoice/package.json`
- Create: `packages/cosyvoice/src/types.ts`, `program.ts`, `manifest.ts`, `component.ts`, `fragment.ts`, `index.ts`
- Create: `packages/cosyvoice/test/cosyvoice.test.ts`

**Interfaces:**
- `CosyVoiceDesignRequest = { preferredName: string; voicePrompt: string; previewText: string; language: "zh" | "en" }`
- `DesignedVoice = { voice: string; targetModel: "cosyvoice-v3.5-flash"; preview: BlobRef }`
- `CosyVoiceSpeechRequest = { voice: DesignedVoice; text: string }`
- Export `cosyVoiceCapabilities.design` (`cosyvoice-v3.5-flash-voice-design`) and `.speech` (`cosyvoice-v3.5-flash-speech`), plus `cosyVoiceTypes.designedVoice` and `cosyVoiceTypes.designSpec`.

The public values must have these exact shapes:

```ts
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
```

- [ ] Write tests for request and response validators: accept the exact valid fields; reject non-alphanumeric/long names, prompts over 500 characters, preview text outside 15–200 characters, invalid language, mismatched target model, and missing/empty preview Blob.
- [ ] Run `node --import tsx --test packages/cosyvoice/test/cosyvoice.test.ts`; verify the new exports do not yet exist.
- [ ] Add sealed/verified request and voice values in `program.ts`, a Module manifest whose design capability returns `DesignedVoice` and speech capability returns `artifactTypes.blob`, and two producers that create the exact Needs. Use `blobRefObjectSchema(["audio/wav"])` for the preview field.
- [ ] Add a design Fragment with inputs `spec` and `previewText`, a design Need, and a preview projection; export `voice` as `DesignedVoice` and `preview` as `BlobArtifact`. Add a speech Fragment with `voice` and `speechText` inputs and an audio Need.
- [ ] Run the focused test until green, then `pnpm check`.

### Task 2: Author surfaces and package activation

**Files:**
- Create: `packages/cosyvoice/src/surface.ts`, `activation.ts`, `README.md`
- Modify: `packages/cosyvoice/src/manifest.ts`, `index.ts`, `test/cosyvoice.test.ts`
- Modify: root `package.json` to include `@hypit/cosyvoice: workspace:*`

**Interfaces:**
- `<cosy:VoiceDesign id="host" name="host1" language="zh" speech={preview.speech}>description</cosy:VoiceDesign>` publishes `host.voice` and `host.preview`.
- `<cosy:Speech id="line" speech={line.speech} voice={host.voice}/>` publishes `line.audio`.

Both decoders should expose the same stable references in their component outputs:

```ts
// VoiceDesign
outputs: { voice: `${id}.voice`, preview: `${id}.preview` }
// Speech
outputs: { audio: `${id}.audio` }
```

- [ ] Write surface tests with real `parseStructuredElement`: check references, emitted records/components/outputs, and rejection of absent or mistyped `speech`/`voice`, empty description, unknown attributes, and nonempty `<cosy:Speech>` body.
- [ ] Run the focused tests and verify they fail for absent decoders/activation.
- [ ] Implement both strict surface decoders, markup vocabulary, and `hypitPackage` registration. The design surface creates a `designSpec` inline record; the speech surface requires `cosyVoiceTypes.designedVoice` rather than a generic audio Blob.
- [ ] Run focused tests and `pnpm check` until green.

### Task 3: NewAPI gateway design and speech handlers

**Files:**
- Modify: `packages/provider-newapi/src/provider.ts`, `packages/provider-newapi/package.json`
- Create: `packages/provider-newapi/test/cosyvoice.test.ts`

**Interfaces:**
- Design: `POST /audio/voice-designs` with normalized fields; return `DesignedVoice` including preview BlobRef.
- Speech: `POST /audio/speech` with returned opaque `voice`, exact model, and text; return a stored audio BlobRef.

The wire requests are exactly:

```ts
const designBody = {
  model: "voice-enrollment",
  target_model: "cosyvoice-v3.5-flash",
  preferred_name: request.preferredName,
  voice_prompt: request.voicePrompt,
  preview_text: request.previewText,
  language: request.language,
  sample_rate: 24_000,
  response_format: "wav",
};
const speechBody = {
  model: "cosyvoice-v3.5-flash",
  input: request.text,
  voice: request.voice.voice,
  response_format: "wav",
};
```

- [ ] Write a test that installs `createNewApiProvider`, resolves each new Need, asserts the exact request body, returns a gateway-shaped design JSON response with Base64 RIFF/WAV preview, and feeds the resulting voice into speech. Fake the signed `audio.url` download and assert the collected bytes and media type.
- [ ] Run `node --import tsx --test packages/provider-newapi/test/cosyvoice.test.ts`; verify missing-capability resolution fails.
- [ ] Add the two immediate handlers and capabilities. Validate design response `voice`, `target_model`, and preview WAV before storing; validate `DesignedVoice` before speech. Extend audio collection only for the CosyVoice route to support either audio bytes or `audio.url` JSON; preserve IndexTTS2's existing binary-response behavior. Never send voice design through OSS.
- [ ] Add negative tests for malformed Base64/WAV, absent voice, wrong target model, missing URL, non-audio/empty download, and upstream errors that reflect a voice handle, API key, or signed URL. Verify these fail before implementing each guard.
- [ ] Run focused NewAPI and existing provider tests, then `pnpm check`.

### Task 4: Starter bindings, documentation, and final verification

**Files:**
- Modify: `packages/provider-newapi/src/setup.ts`, `test/setup.test.ts`, `README.md`
- Modify: `packages/video-cli/test/newapi-first-run.test.ts`
- Modify: `packages/video-cli/package.json`, root `package.json`, `pnpm-lock.yaml` as required by workspace linking.

- [ ] Change setup and starter tests first to require both `@hypit/cosyvoice@1` capability keys bound to `newapi.personal`; run them and verify the binding-count/keys assertions fail.
- [ ] Add both exact default bindings; update the README with author syntax, the design/speech model-name distinction, audio URL download, and manual migration for existing Profiles. Keep the prior NewAPI WhisperX binding.
- [ ] Run `pnpm install` to link the new workspace package, then `pnpm check`, focused tests, and `pnpm test`; verify zero failures.
- [ ] Inspect `git diff --check`, `git status --short`, and all changed files for accidental API keys, signed URLs, generated voice IDs, or unrelated edits. Do not push or create a PR unless requested.
