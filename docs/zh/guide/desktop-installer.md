---
title: 桌面安装包
description: 在 macOS 或 Windows 安装 Hypit，并连接自己的 NewAPI 与 OSS。
---

# 桌面安装包（内部测试版）

安装包面向不需要编译源码的团队成员。它包含 Hypit、FFmpeg、FFprobe、Agent Skill 和中文配置向导。当前提供 **macOS Apple Silicon（arm64）DMG** 与 **Windows x64 EXE**；两者均未签名，且没有自动更新。Windows 安装包在 macOS 上交叉构建，尚未经过真实 Windows x64 机器的安装验证。

## 安装与核对文件

从可信的团队渠道取得安装包及同名 `.sha256` 文件，放在同一目录。可先核对下载文件：

```bash
# macOS，进入安装包所在目录后运行
shasum -a 256 -c Hypit-Setup-0.1.0-arm64.dmg.sha256
```

Windows 可在 PowerShell 中运行 `Get-FileHash .\Hypit-Setup-0.1.0-x64.exe -Algorithm SHA256`，将输出与 `.sha256` 文件开头的 64 位摘要逐字比较。摘要不一致时不要安装，请重新取得文件。

macOS：双击 DMG，将 `Hypit Setup.app` 拖入当前用户的“应用程序”目录并打开。由于内部测试包未签名，若系统阻止打开，在 Finder 中右键点选应用，选择“打开”，再确认“打开”。若仍被拦截，到“系统设置 → 隐私与安全性”确认该应用的“仍要打开”。只对已核对来源和摘要的安装包执行这一步。

Windows：运行 EXE，安装在当前用户下，不需要管理员权限。若 SmartScreen 提示未知发布者，确认文件来源与摘要后选择“更多信息 → 仍要运行”。安装完成会启动中文向导。

## 首次配置

向导需要六项配置，全部必填：

| 配置项 | 填什么 |
| --- | --- |
| NewAPI 地址 | 例如 `https://newapi.example.com`，根地址会自动补全 `/v1`；已有 `/v1` 或自定义 API 路径会保留，末尾斜杠会移除 |
| NewAPI API Key | 该服务分配的密钥 |
| OSS Endpoint | OSS 的 HTTPS Endpoint，例如 `oss-cn-hangzhou.aliyuncs.com` |
| OSS Bucket | 用来中转参考图片或视频的 Bucket 名称 |
| OSS AccessKey ID | 可访问该 Bucket 的 AccessKey ID |
| OSS AccessKey Secret | 对应的 AccessKey Secret |

点击“测试连接并安装”后，向导会读取 NewAPI 的可用模型列表，并在 OSS 上传一个 2 字节测试文件、通过短时签名 URL 下载核对，然后删除测试文件。此操作不会生成图片或视频，也不会提交付费生成请求。如果清理失败，界面会给出测试对象键，需到 OSS 手动删除。地址、Endpoint 和 Bucket 可作为非密钥草稿保留；三个密钥不会保存在草稿中，关闭向导后重新填写。

配置成功后，密钥放在 macOS 钥匙串或 Windows 凭据管理器；Runtime Profile 只保存凭据引用。桌面 Profile 位于 macOS 的 `~/Library/Application Support/Hypit/profiles/desktop-newapi.json`，Windows 的 `%LOCALAPPDATA%\Hypit\profiles\desktop-newapi.json`。命令入口分别为 `~/.local/bin/hypit` 与 `%LOCALAPPDATA%\Hypit\bin\hypit.cmd`。

通用 Agent Skill 始终安装到 `~/.agents/skills/hypit`（Windows 为 `%USERPROFILE%\.agents\skills\hypit`），供 Codex、Claymore Piko 和 Cursor 发现。检测到 Claude Code 时，还会安装到 `~/.claude/skills/hypit`（Windows 为 `%USERPROFILE%\.claude\skills\hypit`）。每个目标独立备份已有的非托管 Hypit Skill，卸载本机集成时分别恢复。

之后安装了新的 Agent，可在向导中点击“重新扫描 Agent”。此操作只更新 Skill 与命令入口，不会读取或改写凭据，也不要求重新输入密钥。旧版 `~/.codex/skills/hypit`（Windows 为 `%USERPROFILE%\.codex\skills\hypit`）仅用于托管安装迁移或手动恢复；无法证明归属的旧文件会保留并提示检查。

完成后重启正在使用的 Agent 和终端。运行 `hypit --version` 与 `hypit paths --json` 检查安装。在新的视频项目中，选择上面的桌面 Profile：

```bash
hypit runtime use "<桌面 Profile 的实际绝对路径>" --workspace "<视频项目目录>"
hypit doctor --workspace "<视频项目目录>"
```

每个项目独立选择 Runtime Profile；向导不会把桌面 Profile 强加到已有项目。Agent Skill 会在新项目中引导选择已安装的桌面 Profile，无需再输入已保存的密钥。`doctor` 用于诊断配置与依赖；正式生成前仍应核对所选模型、参数与费用。Chrome、WhisperX 和模型权重没有随安装包分发，选用相关功能时可能另外下载、安装或配置。

## 本地语音识别与字幕对齐（可选）

首次配置完成或重新打开 Hypit Setup 后，可点击“安装并启动”。跳过此卡片仍可使用 NewAPI/OSS；应用不会自动下载模型。默认采用 `small / cpu / int8`，准备中文 `zh`、英文 `en` 对齐资源。安装包含 Python 依赖和模型下载，可能较大且耗时，实际取决于网络和已有缓存。本地运行不收取 NewAPI 模型费用，也不读取或改写 NewAPI/OSS 凭据。

界面依次显示“准备运行环境、识别模型与中文对齐资源”“准备英文对齐资源”“启动本地服务”“服务已就绪”。前一阶段包含 Python/依赖/模型，当前没有更细下载百分比。资源和健康检查成功后才发布本地 Profile 绑定；发生自定义 Endpoint 或绑定冲突时保留用户修改。可以“重试安装”“启动服务”“停止服务”“检查状态”。关闭窗口不会取消主进程中的准备，重新打开会读取实际状态；强制退出应用或系统关机可能中断准备，稍后显式重试可复用有效缓存。

包内有 uv 0.12.20、对应许可证、WhisperX 服务代码及冻结依赖锁；不需要另装 Homebrew、Winget、Python 或 uv。首次准备会在本机生成中文和英文所需的最小 NLTK 句子参数，不访问 NLTK 下载站，也不读取用户以前的 NLTK 缓存。Whisper `small` 与对齐模型权重没有随包分发，点击安装后仍需联网下载。Program Home 为 `<hostState>/programs/whisperx-whisperx.local-127.0.0.1%3A8765`；其中有 `.venv`、`nltk_data`、`install.log`（安装日志）和 `program.log`（服务日志）。`hostState` 在 macOS 为 `~/Library/Application Support/Hypit`，Windows 为 `%LOCALAPPDATA%\Hypit`。Hugging Face、torch 模型缓存，以及 uv 缓存和下载的 Python，可能使用各自的上游默认位置，并非全部位于 Program Home。完整日志只留在本机，分享前应人工检查敏感内容。

本地绑定已成功发布后，可在终端只读检查或停止已托管服务：

```bash
hypit programs status --runtime "<桌面 Profile 的绝对路径>" --endpoint whisperx.local --json
hypit programs down --runtime "<桌面 Profile 的绝对路径>" --endpoint whisperx.local --json
```

准备失败且尚未发布绑定时，请回到卡片重试；上述命令无法检查 Profile 中不存在的 Endpoint。后续 `programs prepare` / `programs up` 可能触发依赖或模型准备，需要显式同意下载，优先使用向导操作。

### 未来 NewAPI 对齐

本地能力沿用 `@hypit/whisperx@1#whisperx-alignment` 与 `AlignedTranscriptEvidence`，需要输入规范的 16 kHz 单声道语音与明确语言，并返回逐词或逐字开始/结束时间。句子级时间戳和纯文本不能替代逐词对齐。未来 NewAPI 适配器满足该契约后，仅将绑定从 `whisperx.local` 切换到 `newapi.personal`；无需重写项目、Sources、Runs、字幕或语义时间线，也不删除本地模型。当前没有该云端对齐适配器或切换按钮；切回本地前须重新检查就绪状态。

## 更新与卸载

本版本不自动更新。取得新版安装包后，先结束正在运行的 Hypit 任务，再在相同位置安装新版并打开向导运行诊断。Windows 安装程序更新旧版时会保留命令入口、Skill、Profile 与凭据；macOS 如改变应用位置，应重新打开向导检查命令入口。

已有有效 Profile 时，新应用启动会核对当前包的 Skill 内容、版本和命令入口目标，自动刷新完整的托管集成，不要求再次输入密钥。应用搬移后，可确认属于原托管安装的 FFmpeg/FFprobe 路径也会一并更新。自行修改的 Skill、命令入口或自定义媒体路径会保留；无法安全修复或媒体路径失效时，向导会显示未完成或对应失败项。刷新失败会尝试恢复原文件，恢复异常会明确显示警告。

普通卸载默认保留桌面 Profile、系统凭据与视频项目。macOS 先在应用中点击“卸载本机集成”，确认移除命令入口、托管 Skill 与对应 PATH 配置，再把应用移到废纸篓。Windows 从系统“已安装的应用”卸载；卸载程序会尝试清理本机集成，失败时列出需要检查的位置，Profile、凭据与项目仍保留。卸载本机集成时，安装前备份的外部 Skill 会恢复。

若还要清除这台电脑上的桌面 NewAPI/OSS 配置，请先在向导中点击“清除本机配置和凭据”，确认删除桌面 Profile 及三项固定的系统凭据，然后再卸载应用。此操作不会删除视频项目，也不会清理其他项目自行建立的 Profile 或凭据。已经选用该桌面 Profile 的项目需要重新选择可用 Profile。

### 本地语音资源的保留与人工检查

普通卸载或“卸载本机集成”默认保留 WhisperX Program Home、所有模型缓存和桌面 Profile 的本地 capability binding。卸载不会自动停止服务；先在卡片点击“停止服务”，或运行上面的 `programs down` 并检查状态，再卸载应用。重装后可复用原有资源。单独确认“清除本机配置和凭据”会删除整个桌面 Profile，包括本地绑定，但不会删除语音资源。

当前没有“一键删除本地语音资源”功能：Program Home 没有完整内容归属清单，模型可能位于共享的上游缓存，不能仅凭目录名安全删除。释放空间前先运行 `hypit paths --json` 查看 `hostState`，在文件管理器打开上述精确 Program Home，人工检查 `.venv`、`nltk_data`、日志和未知文件。仅在服务已停、确认文件属于此安装且不再需要后，按操作系统方式移入废纸篓或回收站。不要清空整个 Hypit 主目录、共享 Hugging Face/torch/uv 缓存，不要跟随符号链接，也不要删除其他项目的 Profile。无法确认归属时保留并寻求维护者帮助。

## 排查

- `hypit` 找不到：重启正在使用的 Agent 和终端，检查向导的“命令入口”诊断，以及 macOS 的 `~/.local/bin` 或 Windows 当前用户 PATH。
- NewAPI 失败：核对地址和 API Key，确认该地址提供模型列表接口，检查网络与账户权限。
- OSS 失败：核对 Endpoint、Bucket、AccessKey 权限和时效；如界面列出测试对象键，请手动删除后重试。
- 本机依赖失败：在向导中“重新运行诊断”。诊断会检查安装资源、Hypit、FFmpeg/FFprobe、Skill、Profile、凭据与连接，不会生成素材。
- WhisperX 下载失败或磁盘不足：展开卡片的日志位置，查看 `install.log`；检查网络、代理、磁盘空间与目录写入权限，修复后点“重试安装”。已完成缓存会复用，不必先删除环境。
- 中文或英文资源缺失：按失败阶段重试准备；推理不会隐式补下载。启动失败看 `program.log`，确认回环地址 `127.0.0.1:8765` 未被其他服务占用；不要停止不属于 Hypit 的进程。
- `WHISPERX_BUNDLED_UV_INVALID`：重新核对安装包 SHA-256 并从可信渠道重装；不要用系统 uv 替换包内文件。`WHISPERX_PROFILE_CONFLICT`：人工检查桌面 Profile 的 `whisperx.local` 与对齐绑定，保留自定义内容后再决定如何恢复；不要直接覆盖整个 Profile。健康但未激活时可显式“启动服务”重试绑定发布。
- 恢复文件未清理：先检查界面给出的恢复路径，确认无需恢复后再人工处理；不要删除未知或修改过的内容。
- Windows 安装、启动、凭据和卸载的完整流程仍需真实 Windows x64 机器验收；遇到问题请记录系统版本、向导显示的错误代码和诊断项，不要分享密钥或带签名的 URL。

构建与验收记录见 [桌面安装包测试报告](../../../packages/desktop-setup/TEST-REPORT.md)。
