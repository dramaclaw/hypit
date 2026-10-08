# PR #2 Review 修复设计

## 目标与范围

修复 Review 指出的两个问题：`audio-transcribe` 不能把有文本却缺少逐词时间戳的段落当成完整证据；CosyVoice 返回的 `audio.url` 不能让 Provider 下载任意 HTTPS 地址。保留已有的顶层 `words` 转写格式、二进制配音响应，以及现有图片/视频素材下载行为。

## 转写证据

在 `interpretWhisperXTranscript` 之后校验结果。若网关提供段落级 `words`，逐个对照原始 `segments` 与对应 passage：每个非空 `text` 段必须至少有一个词，且该段所有词都必须有完整起止时间戳。空文本段允许无词。若段落均无词而网关提供顶层 `words`，沿用解释器现有的单 passage 回退路径，并要求其词具备时间戳；不因原始段落没有 `words` 而误拒该格式。若识别到文本但没有任何带时间戳的词，继续拒绝。错误经过现有脱敏逻辑。

## 音频 URL 下载

仅对 CosyVoice 的 JSON `audio.url` 下载增加目的地校验；不改变图片、视频的既有下载契约。使用 `URL` 解析完整地址，不接受用户名、密码、片段、非 HTTPS 地址或非默认端口；当配置的网关本身是显式 loopback HTTP 时，允许与其完全同源的 HTTP URL。默认可信目的地是网关同源，以及公开的阿里云 OSS 域名（`oss-<region>.aliyuncs.com` 或 `<bucket>.oss-<region>.aliyuncs.com`，排除 `-internal` 端点）。其他确实需要的目的地由 Endpoint 配置 `audioAssetOrigins` 按完整 origin 显式加入，不做后缀猜测。下载请求设置 `redirect: "error"`，遇到重定向失败，不跟随到其他地址；继续不向素材下载转发 NewAPI Authorization。

## 验证与交付

先写能复现混合段落漏词、任意内网 HTTPS URL、重定向的失败测试，再实现最小修复。覆盖合法顶层 `words`、可信 OSS 签名 URL、自定义 origin、二进制配音响应及现有脱敏行为。运行 Provider 测试、类型检查和相关仓库测试；推送到 PR #2 分支，并在 Review 中用中文说明修复与验证结果。
