# NewAPI Provider 接入设计

## 目标

在你的 Hypit fork 中加入一个团队可复用的 DramaClaw NewAPI Provider，用团队的 NewAPI 网关生成图片和视频。

- 纯文字生成图片或视频：只需要配置 NewAPI 地址和 API Key。
- 使用本地参考图、视频首尾帧、参考视频或参考音频：还需要配置阿里云 OSS 中转。

## 本次修改范围

- 新增工作区包 `@dramaclaw/provider-newapi`。
- 支持已经在黑咖啡视频项目中验证过的两个模型映射：
  - Hypit 图片模型 `@hypit/gpt-image@1#gpt-image-2` 对应 NewAPI 模型 `LingShan-G2`。
  - Hypit 视频模型 `@hypit/seedance@1#seedance-2-mini` 对应 NewAPI 模型 `seedance-2.0-mini`。
- 支持图片生成和参考图编辑。
- 支持视频任务提交、状态查询和结果下载。
- 兼容 NewAPI 返回的任务状态和字段，包括 `not_start`、`in_progress`、`result_url`、`fail_reason`，以及人物素材触发的人工审核状态。
- NewAPI Key 和 OSS 密钥继续使用 Hypit 的 `CredentialRef` 保存，不把真实密钥提交到 Git。
- 增加一份不含真实密钥的团队配置示例和使用说明。

本次不实现 NewAPI 语音转写，也不替换 WhisperX。要替换 WhisperX，需要先验证 NewAPI 的语音模型是否能返回逐词时间戳，再单独设计和实现。

## 实现方式

Provider 会向 Hypit 注册一个可配置的 NewAPI Endpoint。

启动 Endpoint 时只强制要求：

- NewAPI 地址。
- NewAPI API Key 的凭据引用。

OSS 配置改为可选，但必须成套出现。如果要配置 OSS，下面四项必须全部填写：

- OSS Endpoint。
- OSS Bucket。
- OSS AccessKey ID 的凭据引用。
- OSS AccessKey Secret 的凭据引用。

纯文字请求不会创建 OSS 客户端，也不会读取 OSS 密钥，直接请求 NewAPI。

当请求中包含 Hypit 本地素材时，Provider 才会使用 OSS，包括图片编辑参考图、视频首尾帧、视频参考图、参考视频和参考音频。

Provider 会把这些本地素材上传到 OSS，生成临时签名 URL，再把 URL 发送给 NewAPI。如果请求使用了本地素材但没有配置 OSS，Provider 会在请求 NewAPI 之前给出清晰错误，不会导致整个 Endpoint 无法启动。

第一版继续使用已有的 `ali-oss` 实现。暂不增加 S3、MinIO 或自建文件服务支持，避免扩大本次修改范围。

## 配置要求

### 必填的 NewAPI 配置

- `baseUrl`：NewAPI 的 `/v1` 基础地址。
- `apiKey`：保存 NewAPI Token 的 `CredentialRef`。

### 可选的 OSS 配置

以下四项要么全部配置，要么全部不配置：

- `relayEndpoint`：阿里云 OSS Endpoint。
- `relayBucket`：OSS Bucket 名称。
- `relayAccessKeyId`：保存 OSS AccessKey ID 的 `CredentialRef`。
- `relayAccessKeySecret`：保存 OSS AccessKey Secret 的 `CredentialRef`。

还有一个可选参数：

- `relayTtlSeconds`：OSS 临时签名 URL 的有效时间，默认 3600 秒。

并发数、视频轮询间隔和请求超时时间继续允许配置。

第一版把 NewAPI 模型名固定为已经验证过的 `LingShan-G2` 和 `seedance-2.0-mini`，暂时不对团队开放未经验证的任意模型配置。

## 请求流程

### 纯文字生成

1. Hypit 选择 NewAPI Endpoint。
2. Provider 只读取 NewAPI API Key。
3. Provider 直接向 NewAPI 提交生成请求。
4. Provider 把 NewAPI 返回的图片或视频保存到 Hypit 的资源系统。

这个流程不需要 OSS。

### 使用参考素材生成

1. Provider 检测到请求包含本地图片、首尾帧、参考视频或音频。
2. Provider 检查 OSS 配置是否完整。
3. Provider 读取 OSS 凭据，把素材上传到 OSS。
4. Provider 为素材生成临时签名 URL。
5. Provider 把这些 URL 发送给 NewAPI。
6. Provider 把生成结果保存到 Hypit 的资源系统。

## 错误处理

- 只填写了一部分 OSS 配置时，Endpoint 启动失败，并说明 OSS 的四个配置必须成套填写。
- 完全不配置 OSS 时，Endpoint 可以正常启动，纯文字请求可以正常执行。
- 没有配置 OSS 却提交了本地参考素材时，只让该次请求失败，并明确提示需要配置 OSS 中转。
- NewAPI 请求失败时，只显示服务端允许公开的错误信息，不输出 API Key、OSS 密钥或签名 URL 的查询参数。
- 不支持的分辨率、时长、画幅比例或模型能力，在提交付费请求前直接拒绝。

## 测试要求

按照测试优先方式依次验证：

1. 只配置 `baseUrl` 和 `apiKey` 时，Endpoint 可以启动。
2. 只填写部分 OSS 配置时，Endpoint 拒绝启动。
3. 纯文字图片生成不会调用 OSS 上传。
4. 纯文字视频生成不会调用 OSS 上传。
5. 没有配置 OSS 时，包含参考素材的请求会返回清晰错误。
6. 配置 OSS 后，图片参考素材和视频首帧可以转换为签名 URL 并提交给 NewAPI。
7. 视频任务状态、人工审核、结果收集和错误脱敏行为保持正常。

先运行 Provider 自身的测试和 TypeScript 检查，再运行仓库中相关的回归测试。

## 团队使用方式

每位成员通过 `hypit auth` 配置自己的 NewAPI Token，或者使用团队分配的受限 Token。

- 只做纯文字生成：不需要 OSS 凭据。
- 使用本地参考图、首尾帧、参考视频或音频：需要配置权限受限的 OSS RAM 凭据。

仓库只提供配置模板和操作命令，不保存任何真实密钥。
