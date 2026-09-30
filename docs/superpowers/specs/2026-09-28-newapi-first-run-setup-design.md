# NewAPI 默认运行时与首次启动配置设计

## 目标

Hypit 的新项目默认同时提供 DramaClaw NewAPI 和 HypiHub。已经由 Hypit 精确定义并由 DramaClaw NewAPI 支持的九个图片、视频 Capability 默认路由到 NewAPI；HypiHub 保留用于其他能力和用户主动切换。

用户第一次执行 `hypit runtime up` 时，如果默认 NewAPI 尚未配置，CLI 直接进入交互式向导。用户不需要知道 Provider 包名、Runtime Profile 结构或 bindings。配置完成后继续本次启动；之后启动不再重复询问。

这一阶段不制作 macOS 或 Windows 安装包，但配置逻辑必须与终端输入分离，以便未来桌面安装向导复用。

## 默认 Runtime

`hypit runtime init` 写出的初始 Profile 保留现有 `hypihub.default`、本地媒体处理和 HyperFrames，并新增 `newapi.personal`：

- `use` 为 `@dramaclaw/provider-newapi`。
- API Key 使用平台凭据库引用 `newapi.personal.api-key`。
- 初始 NewAPI 地址为空，表示需要首次启动配置；空值只存在于尚未启动的 starter Profile 中。
- 初始不启用 OSS，因为纯文本图片和视频不需要中转存储。

下列九个 Capability 默认绑定到 `newapi.personal`：

- `@hypit/gpt-image@1#gpt-image-2`
- `@hypit/nano-banana@1#nano-banana-2`
- `@hypit/nano-banana@1#nano-banana-pro`
- `@hypit/seedream@1#seedream-5-lite`
- `@hypit/seedance@1#seedance-2`
- `@hypit/seedance@1#seedance-2-fast`
- `@hypit/seedance@1#seedance-2-mini`
- `@hypit/seedance@1#seedance-2.5`
- `@hypit/minimax-h3@1#minimax-h3`

已有自定义 Runtime Profile 不会被静默加入 NewAPI，也不会被重写绑定。自动向导只处理已经显式包含 `@dramaclaw/provider-newapi` 的 Endpoint。

## 可复用配置核心

Provider 包提供无 UI、无文件写入的纯配置模块。它负责：

- 判断 Endpoint 配置是否缺少 NewAPI 地址。
- 校验 NewAPI URL：HTTPS，或本机 loopback HTTP。
- 校验 OSS 配置必须完整包含 Endpoint、Bucket、AccessKey ID 和 AccessKey Secret。
- 生成 Provider 可直接解析的非敏感 Endpoint 配置。
- 给出需要保存的凭据槽位，不接触具体 CredentialStore。
- 返回九个默认 binding 的确定性映射。

模块不读取终端、不访问网络、不写文件、不持有全局状态。CLI 和未来桌面安装器只负责收集输入、保存结果和展示错误。

## 首次启动向导

CLI 增加普通文本输入能力，与已有的不回显密钥输入分开。`runtime up` 在创建 Runtime Host 之前检查选定 Profile：

1. 没有 NewAPI Endpoint：保持原行为，不主动添加。
2. NewAPI 已完整配置：不显示向导，直接继续启动。
3. NewAPI 地址缺失且终端可交互：启动向导。
4. NewAPI 地址缺失且终端不可交互：停止并列出缺少项，不尝试启动 Worker。

交互顺序：

1. 输入 NewAPI 地址。
2. 安全输入 NewAPI API Key。
3. 询问是否启用 OSS 中转。
4. 选择启用时，输入 OSS Endpoint、Bucket，并安全输入 AK、SK。
5. 显示不含密钥的确认摘要。
6. 原子写回 Runtime Profile 的非敏感配置。
7. 通过 Profile 已选择的平台 CredentialStore 保存 API Key，以及可选的 OSS AK、SK。
8. 重新打开并验证 Runtime，然后继续原本的 `runtime up` 流程。

如果保存凭据失败，错误必须明确，Profile 中不得出现密钥。非敏感配置可以保留，下一次启动仅补缺失凭据。

## 凭据缺失处理

首次配置完成后，`runtime up` 仍检查 `newapi.personal` 所声明的必需凭据：

- API Key 永远必需。
- 只有 Profile 已启用 OSS 时，AK、SK 才必需。

可写的凭据库缺少值且终端可交互时，只询问缺失项。环境变量等只读 CredentialStore 缺值时，不尝试写入，而是提示用户设置对应环境变量。已经配置的凭据永远不读取、不显示，也不要求重新输入。

HypiHub 的 OAuth 或其他 Endpoint 凭据不参与这个自动向导，避免改变现有认证语义。

## 安全边界

- Key、AK、SK 不写入 Runtime JSON、Source、日志、命令输出或异常。
- 普通文本输入不得用于密钥；密钥只经过不回显输入通道。
- CLI 的机器可读 JSON 模式和非交互环境不弹出问题，直接返回稳定错误。
- URL 错误继续脱敏签名地址。
- OSS 是可选能力；拒绝配置 OSS 不阻止纯文本生成。
- Runtime Profile 写入使用临时文件替换，避免中断后留下半个 JSON。

## 错误与恢复

- NewAPI 地址无效：停留在向导并要求重新输入；取消则不修改文件。
- 用户取消密钥输入：不启动 Runtime，不输出已输入内容。
- Profile 更新失败：不保存凭据。
- 凭据保存失败：报告具体槽位，保留可安全重试的非敏感 Profile。
- Runtime 验证失败：停止 Worker 启动，沿用现有诊断输出。
- OSS 未启用但后续请求包含参考素材：Provider 在付费提交前拒绝，并提示重新运行 NewAPI 配置入口或手动补充 OSS。

## 测试

自动测试覆盖：

- starter Profile 同时包含 NewAPI 和 HypiHub。
- 九个目标 Capability 默认绑定 NewAPI。
- 现有自定义 Profile 不被自动注入或改绑。
- 首次交互启动按顺序收集配置并继续启动。
- 不配置 OSS 仍能完成启动。
- 配置 OSS 时只把非敏感字段写入 Profile。
- API Key、AK、SK 只进入 CredentialStore，且不出现在文件和输出中。
- 第二次启动不重复询问。
- 删除某个凭据后只补该凭据。
- 非交互及 JSON 模式缺配置时失败并列出缺少项。
- 只读环境凭据库缺值时给出环境变量指引。
- 取消、中途写入失败和凭据保存失败都不会启动 Worker。

## 后续安装包

macOS/Windows 安装器不重新实现配置规则。它复用同一配置核心，以图形界面收集相同输入，继续使用平台 CredentialStore，并生成同样的 Runtime Profile。安装器、代码签名、自动更新、FFmpeg/Node 打包、Chrome 和 WhisperX 下载属于下一份独立设计。
