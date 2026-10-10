# Hypit 桌面安装包验收记录

## 2026-10-10：PR #3 Review 修复验收（当前安装包）

本轮修复清除配置的并发编辑保护、连接探测时限及失败路径的 OSS 清理提示。Profile 删除使用现有文件事务，仅回滚本次拥有的变更；并发修改或新建的 Profile 被保留。连接探测共用 30 秒时限，覆盖 HTTP 请求头、响应体和 OSS 上传；清理另设最多 5 秒时限。HTTP 请求退出时取消读取，超时后向导队列能够继续诊断、清除和卸载。签名、下载或内容验证失败且清理失败时，原始错误类别和经过校验的测试对象键传递到设置流程、诊断及界面。

`pnpm check` 和 `git diff --check` 通过。完整测试共 1801 项，1776 通过、25 条件跳过、0 失败。新增回归曾复现并发 Profile 编辑丢失、停滞探测未退出及失败清理提示丢失，修复后通过。独立代码复核未发现剩余实质问题。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `release/Hypit-Setup-0.1.0-arm64.dmg` | 228704353 | `c249b0bbef0263d3f7bb4c92b170a8514a8d5c27a2b99945a0dabe6ef50680d5` |
| `release/Hypit-Setup-0.1.0-x64.exe` | 204486180 | `4045a4679ca7a900ba96cba19a6886cfe27c19c0d1a5a35394ccbff2e753c25a` |

DMG 实际挂载、EXE 双层解包、安装资源与架构检查均通过，两项相邻 `.sha256` 校验均为 `OK`。Windows 包由 macOS 交叉构建，尚未执行 Windows 真机安装和启动验收；本轮没有使用真实 OSS 或付费模型凭据。以下章节保留此前构建记录，其哈希不代表本轮安装包。

## 2026-10-10：NewAPI 语音与可编辑团队默认值

本轮在 macOS Apple Silicon 构建未签名的团队内部测试包。安装向导默认填入团队 NewAPI 地址、OSS Endpoint 与 Bucket，用户可编辑；API Key、OSS AccessKey ID 和 OSS AccessKey Secret 始终为空且不写入草稿。合法旧草稿继续保留，远程 HTTP NewAPI、带路径的 OSS Endpoint、过短或格式错误的 Bucket 会回退到团队默认值。

语音识别和逐词对齐使用 NewAPI。打包清单明确排除本地 WhisperX Provider、服务目录及 uv/Python 资源；安装器不会引导安装本地 WhisperX，也不会下载本地语音模型。

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `release/Hypit-Setup-0.1.0-arm64.dmg` | 228708238 | `c1ed967e990dccd4428daac62be642a2aa64711d3080f5ece5b10c563abfa6cd` |
| `release/Hypit-Setup-0.1.0-x64.exe` | 204484496 | `615cf429b636a347ace08afce5620dcc12b3754337b6e95b4b2b7f4e172e21d3` |

两项相邻 `.sha256` 校验均为 `OK`。打包流程实际挂载 DMG、双层解包 NSIS EXE，并验证应用架构、ASAR、Runtime、NewAPI 语音资源、FFmpeg/FFprobe、许可证、Skill、资源清单及文件摘要。解包后的 Windows ASAR 可检出三项预填值。`pnpm check` 通过；`pnpm test` 共 1790 项，1765 通过、25 条件跳过、0 失败；`git diff --check` 通过。

Windows 包由 macOS 交叉构建，尚未完成 Windows 真机安装与启动验证。两个安装包均未签名、未公证。常见私钥/API Key 模式扫描没有发现凭据；本机未安装专业 secret scanner，不能把补充扫描视为专业扫描的替代。

## 2026-09-30 历史记录

以下为旧版 Guided WhisperX 构建记录，仅用于追溯，不代表当前 NewAPI 语音安装包。构建机为 macOS Apple Silicon，交付物为未签名的团队内部测试包，未发布到外部平台。

## 本次 Distribution 真实依赖调用者复审修复

基于 `a3663d5f` 继续修复依赖复用判定：不再从全 Distribution 选择第一个声明者。选中组件的依赖图保留每个真实物理调用者，内部依赖从该调用者解析；按物理目录去重处理循环，拒绝越出 Distribution 的内部包。只有该 release 的所有真实调用者都能解析到 exact version 才复用包内依赖；缺失进入 host preparation，错误版本/格式明确失败，不使用 active external roots 冒充 bundle。

隔离 `a-unused` / `z-selected` 回归先观察到 4 项失败；随后加入物理依赖图、边界及 exact-version RED。修复后核心 18/18 通过（含真实 CLI 无 npm），locator/runtime-local/desktop 聚焦 520 项：518 通过、2 条件跳过；`pnpm test` 1774 项：1749 通过、25 条件跳过；`pnpm check`、desktop build、diff check 通过。

本次**重新生成**的交付物位于 `release/guided-whisperx-requirer-20260930-2154/`；上一版产物保留为历史记录，不代表本轮源码：

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `Hypit-Setup-0.1.0-arm64.dmg` | 245808012 | `1b96d2d31c8270577145fd7990547666c843777c555d0ba86bac6a9ed2e1f9e5` |
| `Hypit-Setup-0.1.0-x64.exe` | 216392301 | `058718d60c4bb38a785a2e5618caeebce3cf7d8a8b55c14509f95be2bf0c6d87` |

两项相邻 checksum 为 `OK`。实际挂载 DMG 与实际双层解包 EXE 的 `inspectApp`、资源/锁/架构/媒体/许可证/ASAR 检查通过，并从交付物读取源码确认逐 requirer 修复存在。新包内真实 macOS Electron/CLI 在隔离 HOME、PATH 仅包内 bin、offline/禁止 Python 下载的环境中再次越过 `host.prepare` 到达实际 uv；同一 Electron/CLI 的受控 uv 回归也通过。扫描 4 个变更源码文件、10807 个资源文本与 16 个 ASAR 文本条目，模式命中为 0；专业 secret scanner 仍未安装。

本轮只删除其自行生成的中间 staging 和重复应用/解包副本，未删除任何旧交付物或用户文件；旧根 Distribution 输出临时移动后原样恢复。未下载模型或执行付费请求。仍为未签名、未公证的内部测试包，原生 Windows 与真实 WhisperX 服务/转写验收未执行。详细证据在 `.superpowers/sdd/final-fixes-report.md` 的后续复审章节和 `requirer-fix-*.log`。

## 此前 Guided WhisperX 最终审查修复

基于 `5fdd3bde` 修复 5 项 Important：真实 Distribution CLI 复用包内锁定依赖，不再为已捆绑的 `cjs-module-lexer` 运行系统 npm；运行前验证 uv 锁定版本、资源清单、大小、SHA-256 和原生架构；`starting` 非 pending 时可停止后重试；首次 Profile 激活仅补入拥有的 Endpoint/Binding，保留其余原文字节；候选文件/恢复目录在重启后仍触发独立固定清理警告，且不覆盖主要错误。

新交付物在 `release/guided-whisperx-fixes-20260930-2122/`，旧 release、DMG/EXE、校验文件和用户应用未改动：

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `Hypit-Setup-0.1.0-arm64.dmg` | 245809109 | `9ed0bb3616432392b42a33c060866380b507e05d09c1dd2e57313633187e3b73` |
| `Hypit-Setup-0.1.0-x64.exe` | 216392132 | `b5dd058b264171b80e1bae11b57bb286bbb4c7f401f7245c5a5f069f6b1829b4` |

| 验证 | 本次结果 |
| --- | --- |
| 每组回归 RED → GREEN | CLI、uv 替换、Profile 字节、清理重启/IPC/UI 均先观察失败后修复 |
| `pnpm check` / `git diff --check` | 通过 |
| `pnpm test` | 1765 项：1740 通过、25 条件跳过、0 失败 |
| `node --import tsx --test packages/desktop-setup/test/*.test.ts` | 426 项：424 通过、2 条件跳过、0 失败 |
| `pnpm --filter @hypit/desktop-setup build` | 通过；根目录没有单独的 `build` script |
| 新 DMG 实际挂载 / 新 EXE 实际双层解包 | 应用、ASAR、清单、文件 hash、uv 锁、架构、媒体能力、许可证、Skill 与 WhisperX 服务锁全部通过 |
| 相邻 `.sha256` | 两项均 `OK` |
| 实际 macOS 包内 CLI，无 npm | 隔离 HOME/hostState，PATH 仅包内 bin；已越过 `host.prepare` 并实际运行锁定 uv；`UV_OFFLINE=1` / `UV_PYTHON_DOWNLOADS=never` 在缺少 Python 的可控边界停止，生成真实 install.log，无模型下载 |
| 实际包内 CLI 受控回归 | 同一包内 Electron/CLI、隔离 HOME、PATH 仅受控 uv，达到 uv 边界，1/1 通过 |
| 密钥检查 | 15 个变更源码文件、10807 个包内文本、16 个 ASAR 文本条目模式扫描均 0 命中；`pre-commit` / `gitleaks` 未安装，不能替代专业 secret scanner |

25 项条件跳过与此前相同；其中 2 项 staged-media 没有重新以 staging 测试入口执行，但本次最终 DMG/EXE 的 `inspectApp` 已调用同一媒体检查，macOS 真实执行 FFmpeg/FFprobe，Windows 检查静态架构/选项/哈希。

首次 DMG 和 Windows NSIS 打包遇到磁盘空间不足。复用本轮已完成的应用本体重新生成，最终构建退出 0。只删除本轮重复 staging/解包应用，以及经明确批准的 `.superpowers/sdd/final-fixes-preserved-20260930-2122/resources`（724 MiB 的可再生中间 staging）；后者不可撤回删除，但可从 Distribution 重建。没有删除 `task-6-preserved`、任何旧 release、旧安装器/校验文件、用户安装或用户数据。本次解包副本均已清理，交付安装器保留。DMG 检查后普通 detach 报忙，已仅对本轮只读挂载执行强制 detach 并成功。

依然未下载真实 WhisperX 模型、执行逐词转写或付费请求，未验证原生 Windows 安装/运行/凭据/卸载，也未签名、公证或发布。证据与 TDD 日志见 `.superpowers/sdd/final-fixes-report.md`；其余章节保留历史结果。

## 此前 Guided WhisperX 最终集成

基于 Tasks 1–5 的 `63a32201`，补充普通卸载保留 Program Home、所有模型缓存与本地 Profile 绑定的界面/原生提示和回归测试。测试也保留未知文件、共享缓存符号链接及绑定到 `newapi.personal` 的未来 Profile。最终安装包检查现在明确要求 CLI、WhisperX Provider、Python 服务、`pyproject.toml` 和冻结的 `uv.lock`。

本次产物位于 `release/guided-whisperx-20260930-2110/`，未覆盖旧版根目录的 DMG/EXE/校验文件和解包应用：

| 文件 | 字节 | SHA-256 |
| --- | ---: | --- |
| `Hypit-Setup-0.1.0-arm64.dmg` | 245786518 | `c2f4c31d3902eb3433b425ab841bc3adf626545b409df04df857ab64160e553f` |
| `Hypit-Setup-0.1.0-x64.exe` | 216387635 | `d01d31b44ec6e597d49779668e0abf5bf7d7ce8db2ae2a8bf396830345aa1c09` |

| 验证 | 本次结果 |
| --- | --- |
| `pnpm check` / `git diff --check` | 通过 |
| `pnpm test` | 1746 项：1721 通过、25 条件跳过、0 失败 |
| `node --import tsx --test packages/desktop-setup/test/*.test.ts` | 407 项：405 通过、2 条件跳过、0 失败 |
| `pnpm --filter @hypit/desktop-setup build` | 通过 |
| `HYPIT_TEST_STAGED_MEDIA=1 node --import tsx --test packages/desktop-setup/test/media-capabilities.test.ts` | 3/3 通过，补齐上述 2 项 staging 媒体验证 |
| `pnpm desktop:dist:mac` | 成功；实际挂载本次 DMG，应用/ASAR、清单、哈希、架构、媒体能力、完整 Skill、许可证与 WhisperX 服务锁检查通过 |
| `pnpm desktop:dist:win` | 成功；实际解包本次 NSIS EXE 及其 `app-64.7z`，同类静态资源检查通过 |
| 两平台 `check-artifact.mjs` | 最终 staging 资源检查通过 |
| 相邻 `.sha256` | 从新产物目录运行，两项均 `OK` |
| macOS 包内 CLI / uv smoke | 隔离 HOME、空 PATH、临时 hostState 下 `--version` 返回 `0.2.16`，`paths --json` 无 Profile；uv 返回 `0.12.20` |
| 密钥检查 | `pre-commit`、`gitleaks` 均 command not found；补充变更源码模式检查及 10733 个包内文本文件、两份 ASAR 共 14 个文本文件扫描，0 命中 |

25 项跳过：16 项 Chrome/浏览器或选择的 capture 环境未准备；3 项 Windows OAuth/凭据实机测试；2 项 Linux 鉴权测试；2 项 live OpenCV；2 项 staged-media（之后已单独补跑）。完整明细留在 `.superpowers/sdd/task-6-full-test-final.log`，桌面结果在 `task-6-desktop-test-final.log`。补充模式扫描仅识别私钥、AWS Key、常见 API Key 模式，不能替代未安装的专业 secret scanner。资源检查另外拒绝 Profile、credential、`.env`、私钥等敏感路径。

uv 两目标均为 0.12.20：macOS 为 Mach-O arm64，SHA-256 `2dd23b7aaf10b3d709beb3fcfe6d9cc456136f0dbd0f4b0ebd4f44d4a6a299ee`；Windows 为 PE32+ x86-64，SHA-256 `a0d2742d49564a32488753b02e76276e7b5ef1b1ea8cf30bcbf06ee28f60cd73`。两份包包含 MIT/Apache uv 许可证、媒体许可证及与锁数据一致的资源清单。

### 有意收窄与未验收范围

- 本次没有自动删除语音资源：父任务明确批准安全收窄。Program Home 尚无完整归属清单，Hugging Face/torch/uv 可能使用上游共享缓存；文档如实说明 `.venv/nltk_data/logs` 与缓存位置差异，并提供停止服务、只读查看和人工检查指导。普通卸载保留全部；单独清除桌面配置会删除整个 Profile（包括绑定），仍保留模型。
- 没有下载 WhisperX 大模型、启动真实语音服务或进行中英文逐词转写验收；只有测试夹具和包内 CLI/uv 非下载 smoke，不能称为真实服务就绪验收。
- 没有真实 NewAPI/OSS 凭据测试、付费请求、原生 Windows 安装/准备/启停/卸载、重新安装本机 GUI 或签名/公证。未来 NewAPI 仅说明兼容契约，尚无云端对齐适配器。
- 旧 release 与 Distribution 产物已恢复原路径；旧 staging 资源完整保留在工作区 `.superpowers/sdd/task-6-preserved-20260930-2110/packages-desktop-setup-resources/`。本次新资源仍在 `resources/`；没有生成物被 Git 跟踪。

## 历史最终文件（Profile 回滚防护修复）

以下文件位于本目录的 `release/`（生成物，未提交 Git）：

| 文件 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| `Hypit-Setup-0.1.0-arm64.dmg` | 228850849 | `ec9281dd542b7d4cbc876dbf971d487a65cf5fbddc9246150ae0cdf0732773c3` |
| `Hypit-Setup-0.1.0-x64.exe` | 204610176 | `75d8a708d55b5b21fd4f3c1223fc5f504344fab9892f743818859d156a736041` |

在 `packages/desktop-setup/release/` 目录运行 `shasum -a 256 -c Hypit-Setup-0.1.0-arm64.dmg.sha256` 和 `shasum -a 256 -c Hypit-Setup-0.1.0-x64.exe.sha256`，两项均输出 `OK`。校验文件中的文件名是相对文件名，因此应从 `release/` 目录运行。

## 本次 Profile 回滚防护修复（2026-09-30）

启动媒体刷新若已发布 Profile，而并发编辑使回滚拒绝覆盖，安装向导会保留未就绪状态及 Profile 警告。显式重新扫描 Agent 只修复 Skill、命令入口等集成，不会清除此防护；本地恢复目录仍由状态读取发现，避免重复或已清除警告滞留。成功提交新 Profile 的显式设置流程会清除旧防护。重新扫描不运行凭据或网络诊断。

macOS 与 Windows 路径上的生产状态生命周期回归通过真实文件事务重现并发编辑与 Skill 失败，确认重新扫描前后均未就绪、Profile 警告保留，随后实际提交新 Profile 后恢复就绪。临时恢复旧版无条件清空行为时，两平台回归都在扫描后的就绪断言失败；修复版本通过。

| 命令 | 本次结果 |
| --- | --- |
| `pnpm check` | TypeScript 检查通过 |
| `pnpm test` | 1646 项：1621 通过、25 条件跳过、0 失败；首次并行构建时 runtime-local JSON 读取竞态失败 1 项，单项及顺序全量复跑均通过 |
| `node --import tsx --test packages/desktop-setup/test/*.test.ts` | 307 项：305 通过、2 项 staged-media 条件跳过、0 失败 |
| `pnpm desktop:build` | 桌面 bundle 构建通过 |
| `HYPIT_TEST_STAGED_MEDIA=1 node --import tsx --test packages/desktop-setup/test/media-capabilities.test.ts` | 3/3 通过 |
| 两平台 `check-artifact.mjs` | staging 资源与媒体校验通过 |
| `pnpm desktop:dist:mac` / `pnpm desktop:dist:win` | 重建成功；分别挂载 DMG、解包 EXE 并检查应用和资源 |
| 两项 `shasum -a 256 -c` | 均为 `OK` |

本次包仍未签名、公证或发布；未在真实 Windows x64 上安装，也未使用真实平台凭据或服务连接。

## 本次恢复警告持久化修复（2026-09-30）

命令入口、托管状态文件、macOS `.zprofile` 和 Runtime Profile 的准备事务可能留下同名 `.recovery-XXXXXX` 兄弟目录。现在启动状态、重新扫描和显式诊断会读取这四个固定目标的直接父目录，按生成器的六字符后缀筛选，用 `lstat` 检查目录或符号链接，不读取恢复内容或符号链接目标。每个目录最多检查 256 个条目，每个目标最多列出 3 条恢复路径；截断或检查失败时给出无路径的固定警告。已提交的配置继续保持就绪；恢复目录移除后，警告在下一次状态读取中消失。

回归先在 macOS 和 Windows 两种路径上复现了全新状态丢失 Profile 警告，再验证修复；复审发现启动时 Profile 回滚失败可能被清理警告过滤误删，也先复现失败再修复。测试覆盖命令入口、托管状态、`.zprofile`、Profile、显式诊断、重新扫描、清理后消失、相似文件和其他目录忽略、目录上限、符号链接安全报告、固定恢复指引及重复警告去重。真正的 Profile 回滚失败仍保持未就绪。

| 命令 | 本次结果 |
| --- | --- |
| `pnpm check` | TypeScript 检查通过 |
| `pnpm test` | 1644 项：1619 通过、25 条件跳过、0 失败 |
| `pnpm desktop:build` | 桌面 bundle 构建通过 |
| `node --import tsx --test packages/desktop-setup/test/*.test.ts` | 305 项：303 通过、2 项 staged-media 条件跳过、0 失败 |
| `HYPIT_TEST_STAGED_MEDIA=1 node --import tsx --test packages/desktop-setup/test/media-capabilities.test.ts` | 3/3 通过 |
| 两平台 `check-artifact.mjs` | staging 资源清单、哈希、锁定媒体、架构、许可证、Skill 与 Runtime 通过 |
| `pnpm desktop:dist:mac` / `pnpm desktop:dist:win` | 基于修复源码重建；DMG 实际挂载及 EXE 实际解包后的应用检查通过 |
| 两项 `shasum -a 256 -c` / `git diff --check` | 均通过 |

当前包仍未签名、公证或发布；Windows 尚未经真实 Windows x64 安装与卸载。未使用真实平台凭据、真实 NewAPI/OSS 或付费生成；未替换用户“应用程序”中的旧应用。其他既有限制与下方记录相同。

## 此前发布边界复审修复（2026-09-30）

最终源码提交为 `3b3fa56a`（基于 `e06d0c38`）。命令入口、托管状态、`.zprofile` 和启动时媒体 Profile 刷新使用同一准备事务：先把目标实际内容移入私有恢复目录，核对被移走文件的身份、字节和权限，再以排他 hard link 发布新文件。发布时出现新目标会保留新目标、原内容和准备内容并停止；回滚同样保留并检查实际被移走的内容，不覆盖并发用户编辑。恢复目录清理失败只报告固定类型警告，不撤销已提交的成功结果。

Windows PATH 改为单次 `compareAndSet(expected, value)` 编辑调用。生产实现使用按用户命名的互斥锁，在同一 PowerShell 调用内进行原始值的区分大小写比较、条件写入和写后检查；观察到值不匹配就停止，不重写该值。此锁只协调本程序的写入者，不能使不参与锁的第三方注册表编辑器具备全局原子性。NSIS 在清理返回零且输出非空时显示信息提示，并继续成功卸载；非零分支保留原行为。

回归先复现 10 项原问题失败，随后补充了 2 项首次创建时目标抢占失败和 2 项已提交 Profile 清理警告失败，再验证修复。新增共 22 项测试，覆盖发布、反向移动、提交前与提交后编辑、正常回滚、Windows 条件编辑、警告的安全 IPC 投影及 NSIS 输出提示。

| 命令 | 本次结果 |
| --- | --- |
| `pnpm check` | TypeScript 检查通过 |
| `pnpm test` | 1639 项：1614 通过、25 条件跳过、0 失败 |
| `pnpm desktop:build` | 主进程、preload、renderer 与清理入口构建通过 |
| `node --import tsx --test packages/desktop-setup/test/*.test.ts` | 300 项：298 通过、2 项 staged-media 条件跳过、0 失败 |
| `HYPIT_TEST_STAGED_MEDIA=1 node --import tsx --test packages/desktop-setup/test/media-capabilities.test.ts` | 3/3 通过；最终两平台 staging 均检查 |
| 两平台 `check-artifact.mjs` | 最终 staging 资源清单、哈希、锁定媒体、架构、许可证、Skill 与 Runtime 通过 |
| `pnpm desktop:dist:mac` / `pnpm desktop:dist:win` | 最终源码重建，均退出 0；实际 DMG 挂载和实际 EXE 解包后的 `inspectApp` 通过 |
| 两项 `shasum -a 256 -c` / `git diff --check` | 均通过 |

macOS 检查实际执行包内 FFmpeg/FFprobe，验证 `-fps_mode cfr` 与 H.264 两帧编码；Windows 检查 PE32+ x64、选项、哈希和解包内容，未执行 Windows 程序。排他文件发布依赖同一文件系统支持 hard link；不支持时会停止并保留恢复内容。为腾出打包空间，仅删除并重建了 `release/mac-arm64` 和 `release/win-unpacked` 两个生成目录。

`pre-commit`、`gitleaks` 和 Wine 不在 PATH，未运行。未使用真实凭据、真实 NewAPI/OSS 或付费生成，未替换用户“应用程序”中此前复制的应用。未签名、未公证、未对外发布；原生 GUI、系统凭据及完整 Windows 安装/卸载仍受下方“尚未执行”限制。

## 此前通用 Agent 集成复验（2026-09-30）

最终源码提交为 `620ae66d`，包括 `297ec367`、`33891d39`、`b1fe0635` 和 `34b1d09a` 的修复：命令入口回滚保留并发用户编辑；卸载确认列出通用和 Claude 目标及旧版恢复位置；缺失备份使托管 Skill 未就绪并阻止刷新、升级或卸载；清理失败保留已提交结果和恢复文件，并显示固定类型的诊断警告。中文指南同步说明安装路径。重新扫描 Agent 只读取本地状态，不读取或改写凭据、不执行 NewAPI/OSS 连接探针。

各项回归均先观察到失败，再验证修复通过。测试覆盖 macOS `.zprofile`、命令入口、Windows PATH 并发编辑与 Windows 文件权限差异；同版本缺失备份；安装、刷新、卸载时的 EACCES 和恢复文件被修改；IPC 警告投影及不调用凭据服务的重新扫描。

| 命令 | 本次结果 |
| --- | --- |
| `pnpm check` | TypeScript 检查通过 |
| `pnpm test` | 1617 项：1592 通过、25 条件跳过、0 失败 |
| `pnpm desktop:build` | 桌面主进程、preload、renderer 与清理入口构建通过 |
| `node --import tsx --test packages/desktop-setup/test/*.test.ts` | 278 项：276 通过、2 项 staged-media 条件跳过、0 失败 |
| `HYPIT_TEST_STAGED_MEDIA=1 node --import tsx --test packages/desktop-setup/test/media-capabilities.test.ts` | 3/3 通过；上述两项条件测试已对最终 staging 补跑 |
| 两平台 `check-artifact.mjs` | 两份最终 staging 资源清单、哈希、锁定媒体、架构、许可证、Skill 和 Runtime 检查通过 |
| `pnpm desktop:dist:mac` / `pnpm desktop:dist:win` | 基于最终源码重新构建；DMG 实际挂载及 EXE 实际解包后的 `inspectApp` 均通过，命令均退出 0 |
| 两项 `shasum -a 256 -c` / `git diff --check` | 均通过 |

macOS 的媒体检查实际执行本包 FFmpeg/FFprobe，验证 `-fps_mode cfr` 与 H.264 两帧编码；Windows 检查 PE32+ x64、媒体哈希和选项，未执行 Windows 程序。未使用真实凭据、真实 NewAPI/OSS 或付费生成，未替换用户“应用程序”中此前复制的应用。`pre-commit`、`gitleaks` 和 Wine 不在 PATH，未运行这些工具；未向 Git 添加凭据或生成媒体。原生 GUI、系统凭据和完整 Windows 安装/卸载仍受下方“尚未执行”限制。

## 此前整分支复审修复复验（2026-09-29）

本次完成三项复审修复：两目标 FFmpeg/FFprobe 更新并固定到 9.0.2；NewAPI 根地址统一补 `/v1`；新 app 启动时安全刷新托管 Skill、命令入口及搬移后可认领的媒体路径，无需重新输入凭据。用户修改或非托管内容保留，失败回滚，无法安全修复时显示未完成或警告。

| 命令 | 本次结果 |
| --- | --- |
| `node --import tsx --test packages/desktop-setup/test/*.test.ts packages/provider-newapi/test/*.test.ts packages/video-cli/test/newapi-first-run.test.ts` | 382 项：380 通过、2 项 staged-media 条件跳过、0 失败 |
| `HYPIT_TEST_STAGED_MEDIA=1 node --import tsx --test packages/desktop-setup/test/media-capabilities.test.ts` | 3/3 通过；实际 staging 两目标均检查 |
| `npm run check` | TypeScript 检查通过 |
| `npm test` | 1511 项：1486 通过、25 条件跳过、0 失败（含上述 2 项另行执行的 staged-media 测试） |
| 两平台 `check-artifact.mjs` | 两份 staging 资源、锁定二进制、架构、SHA、许可证、Skill 与 Runtime 均通过 |
| `npm run desktop:dist:mac` / `npm run desktop:dist:win` | 两份最终包重新打包 Distribution 并完成实际挂载/解包检查，均退出 0 |
| `npm run check:distribution -- ./dist/release/hypit-hypit-0.2.16.tgz` | 全新安装、组件编译、字体、本地 Runtime、渲染、导出、FFprobe 与 FFmpeg 解码通过；Worker 已停止 |
| 两项 `shasum -a 256 -c` / `git diff --check` | 均通过 |

旧 macOS 资源在新增回归测试中真实执行失败：`Unrecognized option 'fps_mode'`；旧 Windows 资源缺少该选项字符串。当前 macOS staging 与最终挂载的 DMG 均用自身 FFmpeg 执行 `-fps_mode cfr` + `libx264` 编码两帧，再由自身 FFprobe 确认 H.264/2 帧。Windows 当前二进制由固定 9.0.2 上游归档提取，校验原始归档和二进制 SHA、PE32+ x64、`fps_mode` 选项及无 `--enable-nonfree`；无 Wine，未原生执行 Windows 编码或安装程序。两平台均包含 GPLv3、来源及编译配置说明；外部分发仍须提供对应源码，详见 `media-licenses/*/SOURCES.md`。

当时的 Distribution 为 2813224 字节，SHA-256 `319b2a4b170159f931063271d0bbf23c6771dc14809ac613264ed9e042f5f8e2`。没有使用真实凭据、真实 NewAPI/OSS 或付费生成；没有覆盖此前复制到用户“应用程序”的旧版应用。原生 GUI、系统凭据和完整 Windows 安装/卸载验收仍沿用下方“尚未执行”的限制。

## 此前 OSS 清理警告修复复验

本次修复将 OSS 探针的删除失败改为非阻塞警告：上传、签名 URL、下载及内容校验都成功后，删除失败仍返回连接成功，并在完成页和诊断页显示“OSS 已验证；测试对象未自动删除”及严格校验的对象键。若上传、签名、下载或内容校验失败，仍拒绝安装；即使同时删除失败，也保留原本的阻塞错误。回归测试覆盖凭据和 Runtime Profile 继续写入，以及 controller 后续安装与诊断流程继续执行。

| 命令 | 本次结果 |
| --- | --- |
| `node --import tsx --test packages/provider-newapi/test/*.test.ts packages/desktop-setup/test/*.test.ts` | 310 通过，0 失败 |
| `npm run check` | TypeScript 检查通过 |
| `npm test` | 1461 项：1438 通过、23 按现有环境条件跳过、0 失败 |
| `npm run desktop:dist:mac` | DMG 构建、挂载、应用及资源检查通过；未签名 |
| `npm run desktop:dist:win` | NSIS 交叉构建、解包、应用及资源检查通过；未签名 |
| 两项 `shasum -a 256 -c` | 均输出 `OK` |
| `git diff --check` | 通过 |

打包脚本对本次 DMG 实际挂载内容及本次 EXE 实际解包内容运行 `inspectApp`，包括应用可执行文件、资源清单与哈希、Runtime、Skill、媒体工具及桌面 bundle。没有读取真实平台凭据、调用真实 OSS/NewAPI 或运行付费生成。此次未在 macOS/Windows 向导中用真实凭据复测成功安装；Windows 仍未在实机安装验证。

## 此前自动化与 Distribution（修复前）

| 命令 | 结果 |
| --- | --- |
| `node --import tsx --test packages/desktop-setup/test/*.test.ts packages/provider-newapi/test/*.test.ts packages/video-cli/test/newapi-first-run.test.ts` | 330 通过，0 失败 |
| `npm run check` | TypeScript 检查通过 |
| `npm test` | 1459 项：1436 通过、23 按现有环境条件跳过、0 失败 |
| `npm run pack:distribution -- --json-path` | 生成 `hypit-hypit-0.2.16.tgz` |
| `npm run check:distribution -- ./dist/release/hypit-hypit-0.2.16.tgz` | 全新安装、示例组件编译、字体准备、本地 Runtime、渲染、导出、ffprobe 与 FFmpeg 解码通过；Runtime Worker 已停止 |
| `git diff --check` | 通过 |

`npm run desktop:dist:mac` 与 `npm run desktop:dist:win` 分别重新打包 Distribution、锁定的目标平台依赖、Skill 和 FFmpeg/FFprobe；构建脚本从实际 DMG/NSIS 解包内容核对资源清单和哈希，并生成最终校验文件。两个命令均退出 0。构建日志确认 macOS 签名禁用，Windows 安装器与卸载器签名均跳过。

## 此前 macOS Apple Silicon 安装检查（修复前构建）

1. 使用 `hdiutil attach -readonly -nobrowse` 挂载当时的 DMG；应用主程序、FFmpeg、FFprobe 经 `file` 确认都是 Mach-O arm64。
2. 从挂载应用中的 `app.asar` 提取检查 `dist/main.cjs`、`dist/preload.cjs`、`dist/renderer.js`、`dist/index.html`、`dist/styles.css`、`dist/cleanup.cjs`，都存在；完整 Skill、资源清单和解包的 Windows 凭据辅助脚本也存在。
3. 从当时的 DMG 将应用复制到当前用户的 `/Users/wwq/Applications/Hypit Setup.app`。在复制前确认目标不存在；复制后运行安装资源检查，资源清单、文件哈希、Skill 与 GUI bundle 通过。该已复制应用并非本次修复重建的版本。
4. 在 `PATH` 为空的环境中，安装后内置 CLI `--version` 返回 `0.2.16`，内置 FFmpeg 返回 `4.4`，FFprobe 返回 `n4.4.1`。运行安装后 CLI 的 `doctor --json`，一个本地示例 Profile 返回 `ok: true`。
5. 通过 `open -a` 启动**已复制的应用**，可见中文欢迎页和六项必填配置表单；“测试连接并安装”在字段为空时禁用。GUI 资源和基本交互已目视检查。
6. 安装后 CLI 对现有示例 Run 执行了只读 `plan`；其输出列出 8 个请求及 Provider 价格页，但因示例的 WhisperX 与 Seedance Endpoint 未配置，退出码为 1，并明确显示 2 项未解析。没有启动 Build 或付费生成。

修复前桌面向导连接测试显示 `SETUP_OSS_FAILED`，并提示 OSS 测试对象键 `relay/hypit/setup-test/dc33f5ae-80f5-4e30-a9db-56c9e4489a62.txt` 可能需要手动清理。观察到错误后，验收人员未额外访问或手动清理该对象。由于当时连接测试未完成，桌面 Profile 与 `~/.local/bin/hypit` 尚未生成，平台凭据落盘、托管 Skill、桌面 Profile 选择及该配置的 Runtime 启停尚不能标记为通过。本次修复已通过模拟删除失败的自动化测试；尚未使用真实配置复测。报告不记录任何输入字段值或密钥。

当时第一次复制到“应用程序”时，构建残留的解包目录占满磁盘，`ditto` 报 `No space left on device`。已删除当时创建的不完整应用拷贝及四个可再生目录，磁盘恢复后从同一 DMG 重新复制成功。当时的 DMG/EXE 和校验文件未被删除或修改。检查结束后已卸载 DMG 卷；已复制的旧版应用保留在当前用户“应用程序”中。

## 此前 Windows x64 交叉构建检查（修复前构建）

1. `npm run desktop:dist:win` 在 macOS 上完成 NSIS 编译；日志含 `oneClick=true perMachine=false`，并确认 EXE 与卸载器均跳过签名。
2. 使用 electron-builder 固定的 `7za` 解包最终 EXE，识别为 `NSIS-3 Unicode`；再解出 `$PLUGINSDIR/app-64.7z`，报告 `Everything is Ok`，含 6456 个文件。
3. 解包后的 `Hypit Setup.exe`、`resources/bin/ffmpeg.exe`、`resources/bin/ffprobe.exe` 经 `file` 确认为 PE32+ x86-64。对解包应用运行 `inspectApp(..., "win32", "x64")`，完整资源清单、哈希、Skill、GUI、`dist/cleanup.cjs` 和 ASAR 外的凭据辅助脚本均通过。
4. `build/installer.nsh` 在 `electron-builder.yml` 中被 NSIS `include`，源码及自动化测试验证普通卸载调用 `--integration-only` 清理入口，更新时由 `${isUpdated}` 条件跳过该清理。上述 NSIS 编译已实际完成。
5. `command -v wine` 未找到 Wine；未运行 Wine smoke。

独立解包和静态检查执行的命令（`<7za>` 为 electron-builder 锁定的 7za 程序，`<临时目录>` 是 `mktemp -d` 创建且检查后删除的目录）：

```bash
<7za> x -y -o<临时目录> release/Hypit-Setup-0.1.0-x64.exe
<7za> x -y -o<临时目录>/app '<临时目录>/$PLUGINSDIR/app-64.7z'
file '<临时目录>/app/Hypit Setup.exe' '<临时目录>/app/resources/bin/ffmpeg.exe' '<临时目录>/app/resources/bin/ffprobe.exe'
node --input-type=module -e 'import { inspectApp } from "./scripts/package.mjs"; await inspectApp(process.argv[1], "win32", "x64")' '<临时目录>/app'
command -v wine
```

前两条分别识别 `NSIS-3 Unicode` 和 7z 并报告 `Everything is Ok`；`file` 的三项均为 PE32+ x86-64，`inspectApp` 退出 0。最后一条未找到 Wine，因此没有执行安装程序的 Wine 测试。内置 `package.mjs` 在构建结束时还对最终 EXE 自动执行同类解包和检查。

Windows x64：已在 macOS 交叉构建并完成静态与解包检查；尚未在真实 Windows x64 机器完成安装、凭据管理和卸载验证。

## 尚未执行

- 未进行真实 Windows x64 安装、启动、PATH、系统凭据和卸载验收。
- 未使用真实配置完成本次 macOS 桌面向导的成功连接与凭据保存、托管 Skill/命令入口、桌面 Profile 下的 Runtime 启停验收；修复前的 OSS 错误见上方历史记录。
- 未运行任何付费图片或视频生成测试。若需运行，须先单独确认所选模型、参数和预估费用。
