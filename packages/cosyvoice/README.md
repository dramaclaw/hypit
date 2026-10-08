# CosyVoice 3.5 Flash

`@hypit/cosyvoice` provides a typed voice design step and a speech step. A design returns a reusable `DesignedVoice` value and a WAV preview. Speech takes that exact value, preserving the gateway's opaque voice identifier.

```xml
<cosy:VoiceDesign id="host" name="host1" language="zh" speech={story.sample.speech}>
  温暖自然的年轻女性声音，音色清亮，语速平稳，吐字清晰。
</cosy:VoiceDesign>
<cosy:Speech id="line" speech={story.line.speech} voice={host.voice}/>
```

`host.voice` is the typed voice value, `host.preview` is its audio preview, and `line.audio` is generated speech. The `speech` attributes reference existing Text records. The design body is a required voice description of at most 500 characters; `name` is alphanumeric and 1–10 characters; `language` is `zh` or `en`; preview Text must be 15–200 characters.

The design capability is `cosyvoice-v3.5-flash-voice-design`, while speech is `cosyvoice-v3.5-flash-speech`. A Runtime Profile must bind both to an endpoint authorized for the same gateway account. The design gateway request uses `voice-enrollment` with target `cosyvoice-v3.5-flash`; speech uses `cosyvoice-v3.5-flash` directly. Keep the returned `DesignedVoice` value in the Build graph rather than copying its identifier into Source or Profile JSON.
