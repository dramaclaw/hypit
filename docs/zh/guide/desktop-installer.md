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

每个项目独立选择 Runtime Profile；向导不会把桌面 Profile 强加到已有项目。Agent Skill 会在新项目中引导选择已安装的桌面 Profile，无需再输入已保存的密钥。`doctor` 用于诊断配置与依赖；正式生成前仍应核对所选模型、参数与费用。Chrome 可能在首次使用时下载；语音转写使用已配置的 NewAPI，不需要安装本地 WhisperX 模型。

## 语音识别与字幕对齐

桌面 Profile 默认把逐词对齐能力 `@hypit/whisperx@1#whisperx-alignment` 交给 `newapi.personal`。名称沿用 Hypit 的能力契约；实际通过 NewAPI 的 `audio-transcribe` 接口转写，返回逐词或逐字时间戳。NewAPI 账户须开放对应模型与接口，调用可能产生费用。安装包不包含本地 WhisperX、uv、Python 环境或模型权重，也不会引导下载多 GB 的本地模型。

升级时，向导会为缺少这项绑定的旧桌面 Profile 补上 NewAPI 绑定，同时保留密钥引用和其他设置；已有自定义语音绑定不会自动改写。若旧版曾安装本地语音服务，升级不会自动停止或删除旧环境、模型及共享缓存，请确认服务已不再使用后自行检查。

## 更新与卸载

本版本不自动更新。取得新版安装包后，先结束正在运行的 Hypit 任务，再在相同位置安装新版并打开向导运行诊断。Windows 安装程序更新旧版时会保留命令入口、Skill、Profile 与凭据；macOS 如改变应用位置，应重新打开向导检查命令入口。

已有有效 Profile 时，新应用启动会核对当前包的 Skill 内容、版本和命令入口目标，自动刷新完整的托管集成，不要求再次输入密钥。应用搬移后，可确认属于原托管安装的 FFmpeg/FFprobe 路径也会一并更新。自行修改的 Skill、命令入口或自定义媒体路径会保留；无法安全修复或媒体路径失效时，向导会显示未完成或对应失败项。刷新失败会尝试恢复原文件，恢复异常会明确显示警告。

普通卸载默认保留桌面 Profile、系统凭据与视频项目。macOS 先在应用中点击“卸载本机集成”，确认移除命令入口、托管 Skill 与对应 PATH 配置，再把应用移到废纸篓。Windows 从系统“已安装的应用”卸载；卸载程序会尝试清理本机集成，失败时列出需要检查的位置，Profile、凭据与项目仍保留。卸载本机集成时，安装前备份的外部 Skill 会恢复。

若还要清除这台电脑上的桌面 NewAPI/OSS 配置，请先在向导中点击“清除本机配置和凭据”，确认删除桌面 Profile 及三项固定的系统凭据，然后再卸载应用。此操作不会删除视频项目，也不会清理其他项目自行建立的 Profile 或凭据。已经选用该桌面 Profile 的项目需要重新选择可用 Profile。

### 旧版本地语音资源

新版安装器不再使用或安装本地 WhisperX。普通升级、卸载和清除桌面 Profile 都不会删除旧版留下的 Program Home、模型或共享缓存。若此前启动过本地服务，请先用旧版命令或系统工具确认它已停止；检查 `<hostState>/programs/whisperx-whisperx.local-127.0.0.1%3A8765` 的归属后，再决定是否移入废纸篓或回收站。不要递归清空整个 Hypit 主目录，也不要删除共享的 Hugging Face、torch 或 uv 缓存。

## 排查

- `hypit` 找不到：重启正在使用的 Agent 和终端，检查向导的“命令入口”诊断，以及 macOS 的 `~/.local/bin` 或 Windows 当前用户 PATH。
- NewAPI 失败：核对地址和 API Key，确认该地址提供模型列表接口，检查网络与账户权限。
- OSS 失败：核对 Endpoint、Bucket、AccessKey 权限和时效；如界面列出测试对象键，请手动删除后重试。
- 本机依赖失败：在向导中“重新运行诊断”。诊断会检查安装资源、Hypit、FFmpeg/FFprobe、Skill、Profile、凭据与连接，不会生成素材。
- NewAPI 语音转写失败：确认账户开放 `audio-transcribe` 接口与对应模型，返回逐词或逐字时间戳；检查服务错误和用量。本安装包不提供本地模型回退。
- 升级后 Profile 被判未配置：检查是否保留了自定义语音绑定或旧 `whisperx.local` 端点。安装器只迁移完全匹配旧托管设置的端点，不会覆盖自定义内容；请先备份 Profile，再明确选择可用的 NewAPI 或独立 Provider。
- 恢复文件未清理：先检查界面给出的恢复路径，确认无需恢复后再人工处理；不要删除未知或修改过的内容。
- Windows 安装、启动、凭据和卸载的完整流程仍需真实 Windows x64 机器验收；遇到问题请记录系统版本、向导显示的错误代码和诊断项，不要分享密钥或带签名的 URL。

构建与验收记录见 [桌面安装包测试报告](../../../packages/desktop-setup/TEST-REPORT.md)。
