# Hypit 通用 Agent Skill 安装设计

## 目标

把桌面安装器从只面向 Codex 的集成改为本机通用 Agent 集成。无论用户没有 Agent、只有一个 Agent，还是同时使用多个 Agent，安装器都必须提供一个可发现、可升级、可诊断、可安全卸载的 Hypit Skill，同时只保留一份共享的 Hypit CLI、NewAPI/OSS 配置和 Runtime Profile。

首批明确支持：

- Codex；
- Claymore Piko；
- Cursor；
- Claude Code。

设计必须允许以后增加新的 Agent 目标，而不重写 Skill 安装事务。

## 范围

本次包含：

- 通用 Agent Skill 目标和 Agent 检测；
- Claude Code 兼容 Skill；
- 旧版 Codex 专用安装的迁移；
- 多目标安装、升级、诊断、重新扫描和卸载；
- 桌面向导、状态页、诊断与说明文案的 Agent 中立化；
- macOS 与 Windows 的路径和回滚测试；
- 桌面分支同步已合并的 NewAPI Provider 与安全修复。

本次不包含：

- 后台常驻进程或 Agent 安装监控；
- 云端 Agent、远程 SSH 主机或容器内 Skill 同步；
- 自动修改 Agent 自身设置文件；
- 自动删除已经不再检测到的 Agent 的托管 Skill；
- 自动更新服务。

## 核心原则

### 一份运行环境，多份必要入口

NewAPI Key、OSS 凭据、Runtime Profile、FFmpeg、Hypit Distribution 和 `hypit` 启动入口属于本机共享环境。Agent 数量不会产生多份服务配置，也不会要求重复填写凭据。

Skill 根据 Agent 的发现规则安装。兼容开放 Agent Skills 用户目录的 Agent 共用一份通用 Skill；只有不读取该目录的 Agent 才得到兼容副本。

### 用户内容优先

安装器只直接升级或删除带有有效 Hypit 管理标记的 Skill。目标位置存在未托管 Skill 时，安装器必须先完整备份，再安装当前版本。卸载时恢复原备份。无法证明所有权时不得静默删除。

### 显式重新扫描

安装器首次运行和用户点击“重新扫描 Agent”时检测 Agent。安装器不常驻监控。用户之后安装新的 Agent 时，重新打开 Hypit 设置并点击一次即可补充兼容集成；不需要重新填写 NewAPI 或 OSS。

## Agent 目标模型

新增内部 `AgentSkillTarget`：

```ts
type AgentSkillTargetId = "portable" | "claude";

type AgentSkillTarget = {
  readonly id: AgentSkillTargetId;
  readonly label: "通用 Agent Skill" | "Claude Code Skill";
  readonly skillDirectory: string;
  readonly backupDirectory: string;
  readonly required: boolean;
  readonly detectedAgents: readonly string[];
};
```

首版目标：

| 目标 | Skill 位置 | 启用规则 | 使用者 |
| --- | --- | --- | --- |
| `portable` | `~/.agents/skills/hypit` | 始终启用 | Codex、Claymore Piko、Cursor，以及其他兼容 Agent Skills 用户目录的 Agent |
| `claude` | `~/.claude/skills/hypit` | 检测到 Claude Code 时启用 | Claude Code |

macOS 和 Windows 使用各自路径库拼接用户目录，不手写路径分隔符。每个目标的备份位于 `<Hypit desktop state>/skill-backup/<target-id>/hypit`。

通用目标即使未检测到 Agent 也会安装。这样用户先安装 Hypit、后安装支持开放目录的 Agent 时，不需要再次运行设置。

## Agent 检测

检测只读取存在性和可执行文件元数据，不读取 Agent 会话、聊天、令牌或用户项目。

首版检测信号：

- Codex：用户级 `.codex` 状态目录或已知本机应用/命令存在；
- Claymore Piko：其 Electron 用户数据目录或已知本机应用存在；
- Cursor：用户级 `.cursor` 状态目录或已知本机应用/命令存在；
- Claude Code：用户级 `.claude` 状态目录或已知本机应用/命令存在。

检测逻辑接受注入的文件存在检查与平台路径，单元测试不依赖开发机实际安装的软件。检测不到任何 Agent 不是错误；此时仍安装通用目标，并在界面说明以后可以重新扫描。

检测结果只增加目标。重新扫描时，某个 Agent 消失不会自动删除它的托管兼容 Skill，避免仅因应用移动、命令暂时不在 PATH 或检测规则变化而产生破坏性操作。所有托管目标在“卸载本机集成”时统一处理。

## 管理标记与备份

新安装使用 `hypit.desktop-managed@2` 标记：

```json
{
  "format": "hypit.desktop-managed@2",
  "target": "portable",
  "installedVersion": "0.1.0",
  "sourceDigest": "<sha256>",
  "backupDirectory": "<optional exact managed backup path>"
}
```

要求：

- 标记中的 `target` 必须与正在检查的目标一致；
- `backupDirectory` 必须精确等于该目标的派生备份路径；
- 所有托管副本必须来自同一个安装资源并具有同一个 `sourceDigest`；
- 自动刷新只能覆盖内容和标记均有效的托管副本；
- 被用户手动修改的托管副本视为不可安全刷新，状态页要求用户处理，不静默覆盖。

安装器继续读取 `hypit.desktop-managed@1`，但只把它用于旧 Codex 目标迁移，不能把任意 v1 标记当作新目标所有权。

## 首次安装和重新扫描

### 首次安装

1. 验证安装资源、Skill 树与启动入口资源。
2. 扫描当前 Agent。
3. 生成目标集合：始终包含 `portable`，检测到 Claude Code 时包含 `claude`。
4. 为每个目标准备 Skill 安装：验证现状、复制临时树、校验摘要、准备必要备份。
5. 准备 `hypit` 启动入口和 PATH 修改。
6. 统一提交所有目标与启动入口。
7. 运行逐目标诊断和现有 NewAPI、OSS、Profile 诊断。
8. 显示检测到的 Agent、实际安装目标及需要重启的程序。

### 重新扫描 Agent

新增不接收密钥的 IPC 方法 `refreshAgentIntegration()`。它只执行 Agent 检测、补充缺少的 Skill 目标、刷新已有有效托管目标和重新诊断。它不得写入或请求 NewAPI Key、OSS AccessKey、Runtime Profile 或项目文件。

如果扫描结果没有新增目标，操作保持幂等，只校验和刷新安装器已经安全管理的目标。

## 旧版迁移

旧版路径为 `~/.codex/skills/hypit`，旧备份位于原桌面状态目录中的 Codex Skill 备份位置。

迁移顺序：

1. 验证旧路径是否带有有效 `hypit.desktop-managed@1` 标记。
2. 完成所有新目标的准备，但尚不删除旧目标。
3. 准备旧目标移除；如旧标记记录了安装前备份，则准备恢复该备份。
4. 提交新目标和启动入口。
5. 移除旧托管 Codex Skill，或恢复它原先备份的用户 Skill。
6. 全部提交成功后才清理临时树和不再需要的旧备份。

旧路径没有有效管理标记时，迁移不得修改它。Codex 能读取新的通用目标；旧未托管副本是否保留由用户决定，诊断给出重复 Skill 警告而不是自动删除。

## 事务和错误处理

Skill 安装从单目标事务扩展为目标集合事务。每个目标提供 `prepare`、`commit`、`rollback` 和 `dispose`，桌面集成生命周期统一协调：

- 准备阶段失败：不改变现有安装；
- 提交阶段失败：逆序回滚已经提交的目标和启动入口；
- 回滚不完整：保留恢复所需的临时或备份材料，并返回稳定错误码；
- 提交成功但临时清理失败：安装仍视为成功，诊断报告可清理警告；
- 任一目标存在冲突或不可验证状态：不部分安装，显示具体目标和恢复建议。

错误和 IPC 结果不能包含 Skill 内容、凭据、Agent 会话或任意原始异常对象。

## 命令发现

macOS 继续安装 `~/.local/bin/hypit`，Windows 继续安装 `%LOCALAPPDATA%\Hypit\bin\hypit.cmd`。PATH 设置服务于终端和能够继承用户环境的 Agent。

Skill 的环境说明改为 Agent 中立表述：

- 先尝试 `hypit version` 和 `hypit paths`；
- 命令发现失败时，使用桌面安装器的已知绝对启动入口；
- GUI Agent 不继承 shell PATH 不能被误判为 Hypit 未安装；
- 配置状态完整时不得要求用户重新输入凭据。

重启提示改为“请重启正在使用的 Agent 和 Terminal，再测试 hypit 命令是否可用”。

## UI 与 IPC

界面不再出现只面向 Codex 的文案：

- 欢迎页：“为你的 AI Agent 准备 Hypit”；
- 安装阶段：“正在安装 Agent Skill”；
- 完成页：“在你的 Agent 中试试”；
- 诊断总项：“Agent Skill”；
- 新增 Agent 检测列表和“重新扫描 Agent”操作。

`SetupResult` 从单个 `skillPath` 调整为只读的 `skillTargets` 摘要，每项只包含目标 ID、公开标签、路径和状态。诊断项允许同一个 `skill` code 出现多次，并用目标 ID 区分。渲染器只接收白名单字段。

Agent 检测列表显示：

- Agent 名称；
- 已检测、未检测或通过通用目录兼容；
- 使用的 Skill 目标；
- 是否需要重启。

不会显示 Agent 内部数据目录中的文件、账户信息或会话信息。

## 诊断

诊断覆盖：

- 安装资源；
- 命令入口和绝对入口调用；
- Hypit 版本；
- FFmpeg；
- 每个预期 Skill 目标的管理标记、摘要、版本和备份一致性；
- 未托管旧 Codex Skill 引起的重复警告；
- Runtime Profile；
- 平台凭据槽；
- NewAPI；
- OSS。

普通诊断不生成图片、视频或音频，不修改凭据，也不自动修复未托管 Skill。“重新扫描 Agent”是用户明确触发的安装刷新操作，不属于普通只读诊断。

## 测试

### 路径与检测

- macOS 和 Windows 的通用、Claude、旧 Codex 与各自备份路径；
- 无 Agent、仅 Codex、仅 Claymore Piko、仅 Claude Code、多个 Agent；
- Codex、Piko、Cursor 共享一个通用目标；
- 检测依赖可注入且不读取 Agent 用户数据。

### Skill 生命周期

- 通用目标首次安装、重复安装和升级；
- Claude 兼容目标按检测结果安装；
- 两个目标使用相同源摘要；
- 每个目标独立备份和恢复未托管 Skill；
- 多目标准备失败不产生修改；
- 多目标提交中途失败逆序回滚；
- 回滚失败保留恢复材料并返回稳定错误；
- 重新扫描新增兼容目标但不删除消失 Agent 的目标；
- 卸载删除所有托管目标并恢复全部原备份。

### 旧版迁移

- 无备份的 v1 Codex 目标迁移；
- 带用户备份的 v1 目标迁移并恢复；
- 无效 v1 标记拒绝迁移；
- 未托管旧 Codex Skill 保留并产生诊断警告；
- 新目标提交失败时旧目标保持不变。

### UI、安全和制品

- UI 和文档不再把集成限定为 Codex；
- Agent 列表、目标状态和重新扫描结果只包含白名单字段；
- IPC 序列化不包含六项敏感配置输入；
- GUI Agent 可根据 Skill 说明找到绝对启动入口；
- TypeScript 检查、桌面专项测试和完整测试通过；
- DMG 构建、挂载、应用与资源检查通过；
- Windows EXE 完成静态、解包与资源检查，仍明确标注是否经过真实 Windows 安装验证。

## 分支集成顺序

实现前先把 `codex/desktop-installer` 同步到当前 `main`。当前 `main` 已包含 NewAPI Provider、IndexTTS2 和 NewAPI URL 凭据泄漏修复。解决同步冲突后先运行既有桌面测试，确认基线，再按测试驱动顺序实现本设计。

## 完成条件

- 没有 Agent 时安装器仍能完成并准备通用 Skill；
- 本机只有 Codex、Claymore Piko 或 Cursor 时只依赖通用 Skill 即可使用；
- 检测到 Claude Code 时兼容 Skill 自动安装；
- 本机同时存在多个 Agent 时一次安装后均能发现 Hypit；
- 后安装的专用目录 Agent 可通过“重新扫描 Agent”补充集成；
- 旧 Codex 托管安装安全迁移，用户原 Skill 和备份不丢失；
- 安装、升级、重新扫描和卸载均可验证、可回滚且不暴露凭据。
