# NewAPI audio-transcribe Implementation Plan

> **For agentic workers:** Implement the tasks inline in this worktree. Use test-driven development for code changes.

**Goal:** Route Hypit's existing WhisperX alignment capability through NewAPI `audio-transcribe` and select it by default in newly initialized Runtime Profiles.

**Architecture:** `provider-newapi` validates a normalized evidence WAV, posts it to `/audio/transcriptions` as multipart form data, and converts timed words into `AlignedTranscriptEvidence`. The starter binding selects this Endpoint; existing explicit Profile bindings remain user controlled.

**Tech Stack:** TypeScript, Node.js `fetch`/`FormData`, Hypit Endpoint and WhisperX contracts, `node --test` with `tsx`.

## Global Constraints

- The gateway model name is exactly `audio-transcribe`.
- The request uses `response_format=verbose_json`, explicit language, and segment and word timestamp granularities.
- Audio bytes are a validated 16 kHz mono PCM s16 WAV and are sent directly; no OSS relay is involved.
- The API key remains in the declared credential slot and never enters tests, docs, or Profile JSON as plaintext.
- Existing Runtime Profiles are not automatically rewritten.

---

### Task 1: NewAPI transcription endpoint

**Files:**
- Modify: `packages/provider-newapi/src/provider.ts`
- Modify: `packages/provider-newapi/package.json`
- Create: `packages/provider-newapi/test/transcription.test.ts`

**Interfaces:**
- Consumes: `whisperXCapabilities.alignment`, `verifyWhisperXAlignmentRequest`, `assertWhisperXEvidenceWav`, `interpretWhisperXTranscript` from `@hypit/whisperx`.
- Produces: one immediate Endpoint returning `speechEvidenceTypes.alignedTranscript`.

- [x] Write a test that resolves a WhisperX alignment Need through `createNewApiProvider()` and asserts the multipart body contains the exact WAV, model, language, format, and timestamp granularities; return timed words and assert exact sample positions.
- [x] Run `node --import tsx --test packages/provider-newapi/test/transcription.test.ts` and verify failure because the capability is absent.
- [x] Add the direct multipart handler and dependencies; omit a fixed JSON content type when the body is `FormData`.
- [x] Run the focused test until it passes. Add coverage for malformed evidence, missing word timestamps, and redacted upstream errors.

### Task 2: New Profile binding and documentation

**Files:**
- Modify: `packages/provider-newapi/src/setup.ts`
- Modify: `packages/provider-newapi/test/setup.test.ts`
- Modify: `packages/provider-newapi/README.md`

**Interfaces:**
- Consumes: the capability key `@hypit/whisperx@1#whisperx-alignment`.
- Produces: a default `newapi.personal` binding for new Runtime Profiles.

- [x] Change the setup test to expect the alignment binding alongside all generation route keys; verify it fails before production changes.
- [x] Add the binding to `newApiDefaultBindings` and document how to select it in an existing Profile.
- [x] Run the setup, transcription, and video CLI first-run tests.

### Task 3: Final verification

**Files:** no production changes expected.

- [x] Run `pnpm check` after checking `package.json` scripts.
- [x] Run `pnpm test`; verify zero failures.
- [x] Inspect `git diff --check`, the diff, and `git status --short` for accidental credentials or unrelated changes.
