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

## 首次使用

在视频项目中运行：

```bash
hypit runtime init
hypit runtime up
```

`runtime init` 在尚无 Profile 时创建并选择可编辑的 `hypit.runtime.json`；已有 Profile 会保留。
此命令不会登录或启动服务。起始 Profile 保留
HypiHub，并将上表九项能力默认绑定到 `newapi.personal`。首次 `runtime up` 会询问 NewAPI 地址和
API Key，再询问是否配置 OSS 中转。仅用文字生成图片或视频时可以选择不配置 OSS。

地址写入 Profile 的 `baseUrl`，必须使用 HTTPS；本机服务可以使用 loopback HTTP。API Key
写入 Profile 选定的 CredentialStore，Profile 中只保留 `CredentialRef`，不保存密钥原文。
默认选择名为 `platform` 的 Store；如果自行改选其他可写 Store，配置流程沿用该选择。

非交互终端中，若起始 Profile 缺少 `baseUrl`，`runtime up` 会报出缺少的字段并提示在交互终端配置。
已有地址但缺少所需凭据时，非交互运行也会报错并提示交互配置；只读凭据来源会提示改在该来源中设置。

## 以后再配置 OSS

使用参考图、首尾帧、参考视频或参考音频时，NewAPI 必须能够下载这些素材。编辑已选择的
`hypit.runtime.json`，在 `endpoints["newapi.personal"].config` 中一起添加中转地址、桶名和两个
凭据引用（如下为字段示意，值须换成自己的非密钥配置）：

```json
{
  "relayEndpoint": "<OSS Endpoint>",
  "relayBucket": "<OSS Bucket>",
  "relayAccessKeyId": { "store": "platform", "key": "newapi.personal.oss-ak" },
  "relayAccessKeySecret": { "store": "platform", "key": "newapi.personal.oss-sk" },
  "relayTtlSeconds": 3600
}
```

如果 Profile 已选择其他 CredentialStore，把两个引用的 `store` 改为该 Store 的名称。
然后分别通过安全输入把两个密钥写入选定 Store：

```bash
hypit auth login newapi.personal --slot relayAccessKeyId
hypit auth login newapi.personal --slot relayAccessKeySecret
hypit runtime up
```

不要把 OSS AccessKey 或 NewAPI API Key 原文写进 JSON。四项 OSS 必填配置
（`relayEndpoint`、`relayBucket` 和两个凭据引用）必须一起提供。再次 `runtime up` 会检查所需凭据，
不会因已有 `baseUrl` 而重新启动首次配置问答。

Provider 只在请求实际包含参考素材时上传 OSS，路径为 `relay/hypit/YYYYMMDD/<uuid>.<扩展名>`，并把临时签名 URL 交给 NewAPI。纯文本请求不会创建 OSS 客户端，也不会上传任何内容。未配置 OSS 却使用参考素材时，请求会在调用付费生成接口之前失败，并给出明确错误。

视频生成通过 `POST /video/generations` 提交并轮询 `GET /video/generations/{taskId}`；图片根据是否有参考图调用 `/images/generations` 或 `/images/edits`。下载后的图片、视频都会进入当前 Hypit Build 的 ResourceStore。错误信息中的 HTTP(S) URL 会被脱敏，避免签名地址进入日志。

## 模型约束与错误恢复

Seedream 5 Lite 的 Provider 契约采用网关固定开启的内容安全策略：只支持 `nsfwCheck=true`，
`false` 在能力选择和请求准备阶段返回 unsupported。网关目录没有可配置的安全检查字段，
因此请求不发送 `nsfw_check`，也不提供关闭安全检查的选项。

四个图片模型的尺寸规则保存在 Provider 路由内。Seedream basic/high 对应 2K/3K，至少
3,686,400 像素；其他图片模型支持 1K/2K/4K，至少 655,360 像素。尺寸保持所选比例并按
16 像素对齐，总像素不超过 8,294,400，边长不超过 3840。不支持的比例、分辨率或 Seedream
ultra 会在请求前拒绝。PNG/JPEG 的 base64 结果按文件签名保存正确的媒体类型。

HTTP 429 和 5xx 不会使已提交的视频任务立刻失败：轮询遵守 `Retry-After` 后继续，直到任务
完成或达到操作超时。图片和视频异常都会清除本次请求的凭据与 URL，不保留可打印的原始 cause。

首次启动向导要求 stdin、stdout 都是交互终端且未使用 JSON 模式。地址会在读取密钥前校验，
无效时只重新询问地址。配置完成后展示不含密钥的网关与 OSS 启用状态摘要。
