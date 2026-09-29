# Hypit 一键桌面安装器设计

## 目标

为不熟悉命令行和代码的团队成员提供 Hypit 的一键安装体验。首版交付两个未签名的内部测试安装包：

- macOS Apple Silicon（M1–M4）`.dmg`
- Windows x64 NSIS `.exe`

安装器必须同时安装 Hypit CLI、内置运行环境和 Codex Hypit Skill，并通过中文图形向导完成 NewAPI 与 OSS 的必填配置。用户不需要编辑 JSON、运行 npm 或理解 Runtime Profile。

## 首版边界

首版采用 Electron 和 electron-builder。macOS 安装包在当前 Apple Silicon Mac 上原生构建和验证；Windows x64 安装包在同一台 Mac 上交叉构建。Windows 包必须完成静态、解包和可用的 Wine 检查，但在真正的 Windows x64 机器验证前不得标记为正式可用。

首版不包含：

- Apple Developer ID、公证或 Windows 代码签名；
- 自动升级；
- 完整离线的 Chrome、WhisperX 或模型权重；
- 项目管理或视频编辑桌面界面；
- 用户的 NewAPI 或 OSS 凭据；
- Intel Mac 或 Windows ARM64 安装包。

## 用户体验

### 安装

安装采用当前用户范围，不要求管理员权限。安装包提供一个“Hypit 设置”桌面应用，并安装：

- 平台对应的 Node.js；
- 平台对应的 FFmpeg；
- 当前仓库打包出的 Hypit npm Distribution；
- Codex Hypit Skill；
- 可从终端和 Codex 调用的稳定 `hypit` 启动入口。

macOS 创建 `~/.local/bin/hypit`。Windows 在当前用户的应用目录创建 `bin` 启动入口，并将该目录加入用户 PATH。启动入口必须定位安装器自带的运行时，不依赖机器预先安装 Node.js 或 npm。

### 首次配置

安装完成后自动打开中文向导。向导依次收集以下必填字段：

1. NewAPI 地址；
2. NewAPI API Key；
3. OSS Endpoint；
4. OSS Bucket；
5. OSS AccessKey ID；
6. OSS AccessKey Secret。

向导复用 `@dramaclaw/provider-newapi` 已有的地址、字段组合和密钥规则，不维护第二套不一致的校验逻辑。NewAPI 地址必须使用 HTTPS，只有回环地址可以使用 HTTP。

点击“测试配置”后执行：

1. 使用 API Key 请求 NewAPI `/v1/models`；
2. 向 `relay/hypit/setup-test/<uuid>` 上传一个极小临时对象；
3. 生成临时签名 URL 并下载该对象，确认 NewAPI 可访问同类引用素材；
4. 立即删除测试对象；
5. 只有所有步骤成功后才允许完成配置。

测试对象清理失败必须显示明确警告和对象键，便于人工清理，但不得泄露签名 URL 或凭据。配置测试失败时保留当前会话中的输入以便修正，但不得把未通过的配置或秘密写入最终存储。

### 配置完成

配置成功后：

- 生成默认 Runtime Profile；
- 使用 `newapi.personal` 和 `@dramaclaw/provider-newapi`；
- 将 Hypit 当前支持且 DramaClaw NewAPI 已映射的图片、视频能力绑定到 `newapi.personal`；
- 把 API Key 与 OSS 凭据写入平台凭据存储；
- 验证 Hypit CLI、FFmpeg、Codex Skill、PATH 和 Runtime Profile；
- 显示“配置完成”、打开配置目录、重新测试和一段中文 Codex 示例请求。

用户以后可以重新打开“Hypit 设置”修改配置、替换凭据或运行诊断。

## 架构

### `desktop-shell`

Electron 主进程拥有文件系统、平台凭据和子进程权限。渲染进程只显示中文界面，通过窄化的 preload API 调用允许的设置操作。禁用任意 Node 集成和远程网页导航；所有外部链接交给系统浏览器。

### `setup-core`

无界面的可测试核心，负责：

- 验证向导输入；
- 调用 NewAPI 与 OSS 测试；
- 生成 Runtime Profile；
- 协调凭据写入；
- 返回脱敏、结构化的诊断结果。

它应复用或抽取现有 `packages/provider-newapi/src/setup.ts` 的公共规则，避免桌面端与 CLI 首次启动产生分叉。

### `runtime-bundle`

按目标平台组装 Node.js、FFmpeg 和 Hypit `.tgz`。大型按需依赖不进入安装包：Chrome Headless Shell、WhisperX 和模型权重仍由 Hypit 在首次需要时准备。安装界面必须说明这些组件可能在以后首次使用时下载。

### `skill-installer`

把仓库内的 Hypit Skill 安装到当前用户的 `~/.codex/skills/hypit`。安装器使用自己的管理标记记录所有权：

- 目标不存在时直接安装；
- 目标由本安装器管理时原子升级；
- 目标由其他方式安装时先完整备份，再安装当前版本；
- 卸载时删除本安装器管理的版本，并恢复先前备份。

任何失败都不得留下半写入的 Skill 目录。

### `credential-store`

macOS 使用 Keychain，Windows 使用 Credential Manager。Runtime Profile 只保存 `CredentialRef`，不得保存明文秘密。日志、错误、诊断和遥测中不得出现 API Key、AccessKey、Secret、Authorization 头或签名 URL。

### `launcher`

启动入口设置安装器内置 Node 和 Distribution 的绝对位置，然后调用 `bin/hypit.mjs`。它必须支持带空格和非 ASCII 字符的安装路径及项目路径，并把退出码和信号语义传回调用者。

### `diagnostics`

诊断依次检查：安装资源完整性、启动入口、版本、FFmpeg、Skill、Runtime Profile、凭据槽、NewAPI、OSS。默认诊断不提交任何图片或视频生成请求。

## 数据与安全

桌面应用的普通状态、向导进度和 Runtime Profile 保存在用户应用数据目录。项目与生成结果仍由各 Hypit 项目拥有，不迁移到桌面应用目录。

所有配置写入采用临时文件加原子替换。更新失败时继续使用旧版配置和运行组件。向导中断后只恢复非秘密字段和完成步骤；秘密字段由凭据存储状态决定，不写入普通草稿文件。

安装器不收集遥测。外部网络请求仅包括用户主动发起的配置测试，以及 Hypit 后续按需准备和生产请求。

## 更新与卸载

首版通过重新运行新版安装包升级，不实现自动更新。升级先验证新资源，再切换启动入口；失败时保留旧版。

默认卸载：

- 删除桌面应用、内置运行时和命令入口；
- 删除本安装器管理的 Skill，或恢复安装前备份；
- 保留视频项目、Runtime Profile 和平台凭据。

应用内提供独立的“清除本机配置和凭据”。该操作明确列出目标，要求二次确认，并且不删除视频项目。

## 构建

electron-builder 生成：

- `Hypit-Setup-0.1.0-arm64.dmg`
- `Hypit-Setup-0.1.0-x64.exe`

macOS 包在 Apple Silicon 本机原生生成。Windows x64 包在 Mac 上交叉生成；构建系统下载固定版本的 Windows Node.js 和 FFmpeg，不得把 macOS 二进制放入 Windows 包。依赖版本和下载校验和必须锁定。

每个产物同时生成 SHA-256 校验文件。构建脚本必须可以从干净 checkout 重复执行，并拒绝工作区内意外包含的密钥、用户 Profile 或生成媒体。

## 测试

### 单元测试

- NewAPI 与 OSS 输入规则；
- Runtime Profile 生成；
- 凭据脱敏；
- 启动入口参数和路径转义；
- Skill 首次安装、托管升级、外部版本备份及恢复；
- 配置测试的成功、失败和清理失败分支。

### 集成测试

使用隔离的临时用户目录模拟：

- 首次安装；
- 重复安装；
- 升级；
- 配置中断及恢复；
- 凭据更新；
- 默认卸载；
- 完整清理。

测试必须证明普通配置文件、日志和错误输出不包含测试秘密。

### macOS 实机验收

1. 挂载 `.dmg` 并完成用户级安装；
2. 启动中文配置向导；
3. 使用测试账户验证 NewAPI 和 OSS；
4. 检查 Keychain、Skill 和 `hypit` 启动入口；
5. 运行 `hypit doctor`、`runtime up` 和一个无付费请求的 `plan`；
6. 在用户单独确认费用后，执行一次最低成本生成测试；
7. 卸载并验证保留/删除规则。

### Windows 交叉构建验收

- 生成 NSIS x64 `.exe`；
- 解包并检查 PE x64 Node、FFmpeg、Hypit、Skill 和资源；
- 静态检查注册表、用户 PATH、卸载和路径引用；
- 如本机 Wine 环境可用，执行可运行部分；
- 测试报告明确写明未在真实 Windows x64 机器完成安装验证。

## 交付内容

- `Hypit-Setup-0.1.0-arm64.dmg`；
- `Hypit-Setup-0.1.0-x64.exe`；
- 两个产物的 SHA-256 文件；
- 中文安装说明；
- 自动化与人工测试报告；
- 可重复构建脚本。

## 完成标准

只有同时满足以下条件才可称为首版完成：

- macOS 安装、配置、诊断、CLI、Skill 和卸载实机通过；
- NewAPI 与 OSS 测试不会泄露凭据且能清理临时对象；
- `.tgz` Distribution 的现有类型检查、专项测试、完整测试和安装包测试继续通过；
- Windows x64 `.exe` 成功交叉构建并通过规定的静态/解包检查；
- 所有交付文件和校验和存在；
- 文档明确说明未签名警告与 Windows 实机验证缺口。
