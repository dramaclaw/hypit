# NewAPI CosyVoice 3.5 Flash design and speech

## Goal and scope

Add a Hypit authoring path that designs a reusable CosyVoice 3.5 Flash voice from a text description, then uses that exact voice for speech. Keep the existing MiMo, IndexTTS2, and transcription contracts unchanged. New Runtime Profiles select `newapi.personal` for the two new capabilities; existing Profiles retain their authored bindings.

## Verified gateway contract

On the test gateway, `GET /v1/models` lists both `voice-enrollment` and `cosyvoice-v3.5-flash`. Voice design succeeds with `POST /v1/audio/voice-designs`, `model=voice-enrollment`, and `target_model=cosyvoice-v3.5-flash`. Using CosyVoice as the top-level design `model` is rejected. The gateway returns an opaque `voice` identifier and Base64 WAV preview. A subsequent `POST /v1/audio/speech` with `model=cosyvoice-v3.5-flash`, `voice=<returned identifier>`, and short `input` succeeded when the identifier was passed directly from the design response. Speech success was JSON with `audio.url` and an `archive` object, not binary audio; the Provider must download and store the URL asset.

The gateway rejected a design name longer than 10 characters and preview text outside 15–200 characters. The [Aliyun API reference](https://help.aliyun.com/zh/model-studio/voice-design-api-references) also specifies a 500-character voice prompt ceiling, an alphanumeric prefix no longer than 10 characters, and Chinese/English preview language hints. The [DramaClaw media protocol](https://github.com/dramaclaw/dramaclaw-gateway/blob/main/dc-media-protocol.md) defines the normalized voice-design request and response. We use `preferred_name` at the gateway boundary, which its adapter maps to Aliyun's `prefix`.

## Author model and data flow

Create `@hypit/cosyvoice` version 1 with two exact capabilities:

- `cosyvoice-v3.5-flash-voice-design`: accepts a nonempty voice description, 15–200 character preview text, explicit `zh` or `en` language, and an alphanumeric preferred name of 1–10 characters. It returns a `DesignedVoice` value containing the opaque gateway `voice` string, fixed target model `cosyvoice-v3.5-flash`, and a Blob reference to the decoded WAV preview stored in the Build's ResourceStore.
- `cosyvoice-v3.5-flash-speech`: accepts a `DesignedVoice` value and nonempty spoken text. It returns an ordinary generated audio artifact. It refuses a voice whose target model differs from `cosyvoice-v3.5-flash` before sending a paid request.

The author surfaces are:

```xml
<cosy:VoiceDesign id="host" name="host1" language="zh" speech={story.segment.voiceSample.speech}>
  温暖自然的年轻女性声音，音色清亮，语速平稳，吐字清晰。
</cosy:VoiceDesign>
<cosy:Speech id="narration" speech={story.segment.line.speech} voice={host.voice}/>
```

`host.voice` is the typed reusable voice value, `host.preview` is its audio preview Resource, and `narration.audio` is the synthesized audio Resource. The speech and preview text come from existing Hypit Text references; the design description is the element body. The voice identifier is never reconstructed from preview audio, and these capabilities are not aliases of MiMo models.

## Provider behavior and boundaries

Register both capabilities in `@dramaclaw/provider-newapi`. Voice design sends only normalized fields to `/audio/voice-designs`, requesting `sample_rate=24000` and `response_format=wav`, validates a nonempty voice identifier and a decodable, nonempty WAV preview, then stores the preview before returning `DesignedVoice`. It does not need OSS relay. Speech sends the returned opaque identifier to `/audio/speech` with the exact target model and `response_format=wav`. It accepts a binary audio response or the gateway's documented `audio.url` JSON response, downloads a URL result with the existing request timeout, verifies it is nonempty audio, and stores it in the ResourceStore. It does not persist signed URLs as voice identity.

Both requests use the Profile's existing `apiKey` credential reference. The Provider redacts credentials, voice handles, signed URLs, and nested upstream errors from diagnostic messages. A voice created under one gateway account/channel might not work under another; the starter binds both capabilities to the same `newapi.personal` endpoint and documentation warns against cross-account reuse.

## Verification and compatibility

Test the author surfaces, typed request/response values, capability resolution, exact request bodies, preview decoding, JSON URL and binary speech collection, invalid input rejection before paid requests, error redaction, and starter bindings. Run the repository type check and full test suite. Existing Profile files and current ten generation routes plus the NewAPI transcription route are not rewritten or renamed.
