# NewAPI `index-tts-2` 语音克隆接入设计

## 目标

让 `@dramaclaw/provider-newapi` 使用 NewAPI 的 `index-tts-2` 完成参考音频语音克隆，使已有的 Hypit
`@hypit/mimo-speech@1#mimo-v2.5-tts-voiceclone` 请求可以通过 `newapi.personal` 执行。

本次只接入“文字 + 一段参考音频 + 可选演绎指令”的语音克隆。声音设计、预设音色、音乐生成以及新的
Hypit Model 定义均不在范围内。

## 模型与 Provider 边界

Hypit 已有的 `mimo-v2.5-tts-voiceclone` 精确描述了本次生产所需的能力：

- 一段待朗读文字；
- 一段且仅一段音频声音参考；
- 一条可选的演绎指令；
- 一个音频结果。

`index-tts-2` 是 NewAPI 端的路由模型名，而不是新增的 Hypit 能力。因此只在 NewAPI Provider 中增加
能力映射和协议转换，不新增 `@dramaclaw/index-tts`，也不修改 `@hypit/mimo-speech` 的作者接口。
已有 `<mimo:VoiceClone>` Source 可在 Profile 绑定到 `newapi.personal` 后直接使用。

## 请求映射

Provider 为 `@hypit/mimo-speech@1#mimo-v2.5-tts-voiceclone` 注册以下路由：

| Hypit 输入 | NewAPI 请求 |
| --- | --- |
| 路由模型 | `model: "index-tts-2"` |
| `text` | `input` |
| `voiceReference` | `metadata.audio_url` |
| `instruction` | `metadata.emotion_prompt` |
| 存在 `instruction` | `metadata.should_use_prompt_for_emotion: true` |

请求发送至 `POST /audio/speech`。没有演绎指令时，不发送情绪提示字段，以保留上游默认行为。

参考音频继续使用 Provider 已有的 OSS Publisher：运行时先把 ResourceStore 中的音频发布为临时签名 URL，
再把该 URL 放入 `metadata.audio_url`。未配置 OSS 时，请求必须在调用 NewAPI 付费接口前失败；日志和错误中
不得泄漏签名 URL、API Key 或 OSS 凭据。

## 响应与执行

语音生成是即时操作，不进入视频任务的 `start`/`poll` 生命周期。Provider 调用 `/audio/speech` 后直接接收
音频字节，依据响应 `Content-Type` 校验其为 `audio/*`，写入当前 Build 的 ResourceStore，并封装成
Hypit `GeneratedAudioSet` 返回。

如果网关返回 JSON 错误、非音频响应、空响应或网络失败，Provider 使用现有公开错误清洗规则返回失败；
响应正文中的 URL 和请求凭据必须脱敏。Provider 不在未知远端结果时自动重试生成，避免重复计费。

## Profile 与首次启动

`newApiDefaultBindings` 增加语音克隆能力的默认绑定，使新建 Profile 默认选择 `newapi.personal`。已有 Profile
不会被静默改写；用户可按现有 Profile 机制手动添加绑定。

因为语音克隆必需参考音频，实际使用该能力时必须配置 OSS。首次启动仍允许用户跳过 OSS，以免破坏纯文字
图片/视频使用；届时语音克隆的 readiness/support 错误应明确说明需要配置 OSS。

Provider 包增加 `@hypit/mimo-speech` 作为开发期模型契约依赖，不把模型实现复制进 Provider。

## 验证

自动化测试覆盖：

1. 能力目录将 `mimo-v2.5-tts-voiceclone` 选到 `index-tts-2`，结果类型为音频；
2. 文字、单段参考音频和可选演绎指令正确转换为 `/audio/speech` 请求；
3. 参考音频通过 OSS Publisher 发布，且缺少 Publisher 时在 HTTP 请求前失败；
4. `audio/*` 响应进入 ResourceStore 并成为单项 `GeneratedAudioSet`；
5. 非音频、空响应、HTTP/网络错误失败且敏感数据不进入公开错误；
6. 新建 Profile 包含语音克隆默认绑定，已有图片和视频绑定保持不变；
7. `provider-newapi` 的类型检查和完整测试套件通过。

不执行真实付费语音生成作为自动化测试。完成本地契约测试后，如需验证实际 NewAPI 渠道，由用户另行确认一次
短文本、单段参考音频的付费烟雾测试。
