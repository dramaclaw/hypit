# NewAPI `audio-transcribe` for Hypit alignment

## Goal

Let an existing Hypit `@hypit/whisperx@1#whisperx-alignment` Need run on the
DramaClaw NewAPI `audio-transcribe` model. A new Runtime Profile binds this
capability to `newapi.personal`; an existing Profile can select the same
Endpoint explicitly. Author Source and the aligned transcript value do not
change.

## Evidence and choice

A three-second English WAV submitted to the test gateway's
`POST /v1/audio/transcriptions` with `model=audio-transcribe`,
`response_format=verbose_json`, `language=en`, and both word and segment
timestamp granularities returned HTTP 200 with the exact sentence, one
segment, and eight timed words. This is the response shape Hypit's existing
transcript interpreter accepts.

Three approaches were considered: a new Hypit transcription capability,
reusing the hosted HypiHub endpoint, and adding a NewAPI endpoint for the
existing capability. The last keeps current Author Source and deterministic
alignment unchanged while selecting the service through the Runtime Profile.

## Boundary

The provider reads the already normalized 16 kHz mono PCM WAV from the
ResourceStore and verifies its declared size and sample count. It sends that
WAV directly as multipart `file` with the fixed model name, explicit language,
`verbose_json`, and `timestamp_granularities[]=segment` and `word`. No OSS
relay is needed. The provider converts the response's second-based word
windows to Hypit's exact sample positions and publishes
`AlignedTranscriptEvidence`.

The existing request timeout applies to the multipart request and response.
HTTP failures and malformed responses use the provider's credential and URL
redaction rules. A spoken response without words, or a recognized word without
valid timestamps, is invalid for this capability; an empty transcript remains
valid for silence. The provider does not synthesize timings. Existing Profiles
are not rewritten automatically because an explicit binding is a user selection.

## Verification

Tests cover the registered capability, multipart fields and bytes, exact word
timing conversion, no OSS use, invalid evidence rejection before network
activity, malformed text-only responses, redacted upstream errors, and the new
Profile binding. Type checking and the full test suite must pass. A short live
request verifies the gateway protocol independently of the fixture tests.
