# `@dramaclaw/provider-newapi`

这是 Hypit 对 DramaClaw NewAPI 网关的图片、视频 Provider。它只注册 Hypit 已经有精确定义、并且 DramaClaw 当前目录也支持的模型；不会额外伪造尚未定义的 Hypit 模型。

| Hypit Capability | NewAPI 模型名 | 类型 |
| --- | --- | --- |
| `@hypit/gpt-image@1#gpt-image-2` | `LingShan-G2` | 图片 |
| `@hypit/nano-banana@1#nano-banana-2` | `LingShan-NB-2` | 图片 |
| `@hypit/nano-banana@1#nano-banana-pro` | `LingShan-NB-Pro` | 图片 |
| `@hypit/seedream@1#seedream-5-lite` | `seedream-5.0-lite` | 图片 |
| `@hypit/seedance@1#seedance-2` | `seedance-2.0` | 视频 |
| `@hypit/seedance@1#seedance-2-fast` | `seedance-2.0-fast` | 视频 |
| `@hypit/seedance@1#seedance-2-mini` | `seedance-2.0-mini` | 视频 |
| `@hypit/seedance@1#seedance-2.5` | `seedance-2.5` | 视频 |
| `@hypit/minimax-h3@1#minimax-h3` | `MiniMax-H3` | 视频 |

## 只使用 NewAPI

纯文本生成图片或视频只需要 NewAPI 地址和 API Key，不需要 OSS：

```json
{
  "format": "hypit.runtime-local@1",
  "dataRoot": ".hypit/execution",
  "credentials": {
    "platform": { "use": "@hypit/credential-store-platform" }
  },
  "endpoints": {
    "newapi.team": {
      "use": "@dramaclaw/provider-newapi",
      "pool": "newapi.team",
      "config": {
        "baseUrl": "https://你的-newapi-地址/v1",
        "apiKey": { "store": "platform", "key": "newapi.team.api-key" },
        "defaultConcurrency": 2,
        "pollIntervalMs": 10000
      }
    }
  },
  "bindings": {
    "@hypit/gpt-image@1#gpt-image-2": "newapi.team",
    "@hypit/nano-banana@1#nano-banana-2": "newapi.team",
    "@hypit/nano-banana@1#nano-banana-pro": "newapi.team",
    "@hypit/seedream@1#seedream-5-lite": "newapi.team",
    "@hypit/seedance@1#seedance-2": "newapi.team",
    "@hypit/seedance@1#seedance-2-fast": "newapi.team",
    "@hypit/seedance@1#seedance-2-mini": "newapi.team",
    "@hypit/seedance@1#seedance-2.5": "newapi.team",
    "@hypit/minimax-h3@1#minimax-h3": "newapi.team"
  }
}
```

`baseUrl` 必须使用 HTTPS；本机服务可以使用 `http://127.0.0.1` 或 `http://localhost`。真实 Key 不要写进 JSON，配置中只保存 `CredentialRef`，然后用 Hypit 的凭据登录命令把 Key 存入 `platform` 凭据库。

## 使用参考素材时配置 OSS

NewAPI 必须能够下载参考图、首尾帧、参考视频或参考音频。此时再追加下面四项 OSS 配置；四项必须一起提供：

```json
{
  "relayEndpoint": "oss-cn-chengdu.aliyuncs.com",
  "relayBucket": "你的中转桶",
  "relayAccessKeyId": { "store": "platform", "key": "newapi.team.oss-ak" },
  "relayAccessKeySecret": { "store": "platform", "key": "newapi.team.oss-sk" },
  "relayTtlSeconds": 3600
}
```

Provider 只在请求实际包含参考素材时上传 OSS，路径为 `relay/hypit/YYYYMMDD/<uuid>.<扩展名>`，并把临时签名 URL 交给 NewAPI。纯文本请求不会创建 OSS 客户端，也不会上传任何内容。未配置 OSS 却使用参考素材时，请求会在调用付费生成接口之前失败，并给出明确错误。

视频生成通过 `POST /video/generations` 提交并轮询 `GET /video/generations/{taskId}`；图片根据是否有参考图调用 `/images/generations` 或 `/images/edits`。下载后的图片、视频都会进入当前 Hypit Build 的 ResourceStore。错误信息中的 HTTP(S) URL 会被脱敏，避免签名地址进入日志。
