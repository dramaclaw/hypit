---
title: 桌面安装包
description: 在 macOS 或 Windows 安装 Hypit，并连接自己的 NewAPI 与 OSS。
---

# 桌面安装包（内部测试版）

安装包面向不需要编译源码的团队成员。它包含 Hypit、FFmpeg、FFprobe、Codex Skill 和中文配置向导。当前提供 **macOS Apple Silicon（arm64）DMG** 与 **Windows x64 EXE**；两者均未签名，且没有自动更新。Windows 安装包在 macOS 上交叉构建，尚未经过真实 Windows x64 机器的安装验证。

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
| NewAPI 地址 | 你的 NewAPI 服务基础地址，例如 `https://newapi.example.com` |
| NewAPI API Key | 该服务分配的密钥 |
| OSS Endpoint | OSS 的 HTTPS Endpoint，例如 `oss-cn-hangzhou.aliyuncs.com` |
| OSS Bucket | 用来中转参考图片或视频的 Bucket 名称 |
| OSS AccessKey ID | 可访问该 Bucket 的 AccessKey ID |
| OSS AccessKey Secret | 对应的 AccessKey Secret |

点击“测试连接并安装”后，向导会读取 NewAPI 的可用模型列表，并在 OSS 上传一个 2 字节测试文件、通过短时签名 URL 下载核对，然后删除测试文件。此操作不会生成图片或视频，也不会提交付费生成请求。如果清理失败，界面会给出测试对象键，需到 OSS 手动删除。地址、Endpoint 和 Bucket 可作为非密钥草稿保留；三个密钥不会保存在草稿中，关闭向导后重新填写。

配置成功后，密钥放在 macOS 钥匙串或 Windows 凭据管理器；Runtime Profile 只保存凭据引用。桌面 Profile 位于 macOS 的 `~/Library/Application Support/Hypit/profiles/desktop-newapi.json`，Windows 的 `%LOCALAPPDATA%\Hypit\profiles\desktop-newapi.json`。命令入口分别为 `~/.local/bin/hypit` 与 `%LOCALAPPDATA%\Hypit\bin\hypit.cmd`，Codex Skill 位于 `~/.codex/skills/hypit` 或 `%USERPROFILE%\.codex\skills\hypit`。安装器会备份已有的非托管 Hypit Skill，卸载本机集成时恢复它。

完成后重启 Codex 和终端。运行 `hypit --version` 与 `hypit paths --json` 检查安装。在新的视频项目中，选择上面的桌面 Profile：

```bash
hypit runtime use "<桌面 Profile 的实际绝对路径>" --workspace "<视频项目目录>"
hypit doctor --workspace "<视频项目目录>"
```

每个项目独立选择 Runtime Profile；向导不会把桌面 Profile 强加到已有项目。Codex Skill 会在新项目中引导选择已安装的桌面 Profile，无需再输入已保存的密钥。`doctor` 用于诊断配置与依赖；正式生成前仍应核对所选模型、参数与费用。Chrome、WhisperX 和模型权重没有随安装包分发，选用相关功能时可能另外下载、安装或配置。

## 更新与卸载

本版本不自动更新。取得新版安装包后，先结束正在运行的 Hypit 任务，再在相同位置安装新版并打开向导运行诊断。Windows 安装程序更新旧版时会保留命令入口、Skill、Profile 与凭据；macOS 如改变应用位置，应重新打开向导检查命令入口。

普通卸载默认保留桌面 Profile、系统凭据与视频项目。macOS 先在应用中点击“卸载本机集成”，确认移除命令入口、托管 Skill 与对应 PATH 配置，再把应用移到废纸篓。Windows 从系统“已安装的应用”卸载；卸载程序会尝试清理本机集成，失败时列出需要检查的位置，Profile、凭据与项目仍保留。卸载本机集成时，安装前备份的外部 Skill 会恢复。

若还要清除这台电脑上的桌面 NewAPI/OSS 配置，请先在向导中点击“清除本机配置和凭据”，确认删除桌面 Profile 及三项固定的系统凭据，然后再卸载应用。此操作不会删除视频项目，也不会清理其他项目自行建立的 Profile 或凭据。已经选用该桌面 Profile 的项目需要重新选择可用 Profile。

## 排查

- `hypit` 找不到：重启 Codex 和终端，检查向导的“命令入口”诊断，以及 macOS 的 `~/.local/bin` 或 Windows 当前用户 PATH。
- NewAPI 失败：核对地址和 API Key，确认该地址提供模型列表接口，检查网络与账户权限。
- OSS 失败：核对 Endpoint、Bucket、AccessKey 权限和时效；如界面列出测试对象键，请手动删除后重试。
- 本机依赖失败：在向导中“重新运行诊断”。诊断会检查安装资源、Hypit、FFmpeg/FFprobe、Skill、Profile、凭据与连接，不会生成素材。
- Windows 安装、启动、凭据和卸载的完整流程仍需真实 Windows x64 机器验收；遇到问题请记录系统版本、向导显示的错误代码和诊断项，不要分享密钥或带签名的 URL。

构建与验收记录见 [桌面安装包测试报告](../../../packages/desktop-setup/TEST-REPORT.md)。
