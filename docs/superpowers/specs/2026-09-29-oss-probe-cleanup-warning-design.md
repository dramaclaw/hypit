# OSS 探针清理降级设计

## 目标

Hypit 桌面安装器用一个 2 字节 OSS 对象验证上传、签名 URL 和下载。探针删除用于清理测试垃圾，不是视频工作流的连接能力要求。删除失败不得阻止配置安装。

## 行为

- NewAPI 模型列表、OSS 上传、签名和下载必须全部成功；任一步失败仍阻止安装。
- 下载内容验证成功后尝试删除探针对象。
- 删除成功时返回正常连接结果。
- 删除失败时仍返回成功连接结果，并附带经过严格校验的 `cleanupObjectKey` 警告。
- 桌面安装继续保存平台凭据、写入 Runtime Profile，并安装 launcher 与托管 Skill。
- 完成页和诊断页显示“OSS 已验证；测试对象未自动删除”的非阻塞警告及对象键，不把 OSS 标记为失败。
- 不透传 OSS SDK 错误、签名 URL、Endpoint、Bucket 或任何密钥。

## 接口

Provider 的连接测试结果新增可选 `cleanupObjectKey`。桌面 `SetupResult` 通过 diagnostics 中的 OSS 项传递该键；IPC 继续只允许 UUID-v4 格式的固定探针前缀。安装成功状态可同时包含 warning diagnostics。

## 测试

- 删除失败先观察现有行为的失败测试，再实现非阻塞结果。
- 验证清理失败时凭据、Profile、launcher 和 Skill 安装仍继续。
- 验证上传、签名、下载及内容不匹配仍是阻塞失败。
- 验证 renderer 将清理失败显示为警告而非连接失败。
- 运行 provider、desktop 全套测试、类型检查和安装包静态检查；最终重建 DMG/EXE。

## 非目标

- 不取消自动清理尝试。
- 不放宽上传、下载或内容校验。
- 不要求 `ListObjects` 权限。
- 不自动使用用户凭据再次删除历史残留对象。
