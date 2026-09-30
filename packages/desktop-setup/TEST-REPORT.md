# Hypit 桌面安装包验收记录

日期：2026-09-30。构建机：macOS Apple Silicon。交付物为未签名的团队内部测试包，未发布到外部平台。下方保留此前验收记录；本节文件和“本次通用 Agent 集成复验”对应当前最终构建。

## 最终文件

以下文件位于本目录的 `release/`（生成物，未提交 Git）：

| 文件 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| `Hypit-Setup-0.1.0-arm64.dmg` | 228845538 | `829b5d4a71c0f53d76aed02620dd1bbb9935700997adf1cc29e6c522de3040d1` |
| `Hypit-Setup-0.1.0-x64.exe` | 204605097 | `2a4803cedf1cb051c3b8787e057b54254cccdc9458168e593b458407d5275ebe` |

在 `packages/desktop-setup/release/` 目录运行 `shasum -a 256 -c Hypit-Setup-0.1.0-arm64.dmg.sha256` 和 `shasum -a 256 -c Hypit-Setup-0.1.0-x64.exe.sha256`，两项均输出 `OK`。校验文件中的文件名是相对文件名，因此应从 `release/` 目录运行。

## 本次通用 Agent 集成复验（2026-09-30）

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
