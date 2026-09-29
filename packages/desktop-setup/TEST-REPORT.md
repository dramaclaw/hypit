# Hypit 桌面安装包验收记录

日期：2026-09-29。构建机：macOS Apple Silicon。交付物为未签名的团队内部测试包，未发布到外部平台。

## 最终文件

以下文件位于本目录的 `release/`（生成物，未提交 Git）：

| 文件 | 大小（字节） | SHA-256 |
| --- | ---: | --- |
| `Hypit-Setup-0.1.0-arm64.dmg` | 196170089 | `b447e7bdc75ebffd79ca338352d231ce50182e389be6c1118d34783f23aa8f9f` |
| `Hypit-Setup-0.1.0-x64.exe` | 185444057 | `db50d96cc9027422f02e01a6b14d7e83168f64fa056a2218971657bd2c4ce4b2` |

在 `packages/desktop-setup/release/` 目录运行 `shasum -a 256 -c Hypit-Setup-0.1.0-arm64.dmg.sha256` 和 `shasum -a 256 -c Hypit-Setup-0.1.0-x64.exe.sha256`，两项均输出 `OK`。校验文件中的文件名是相对文件名，因此应从 `release/` 目录运行。

## 自动化与 Distribution

| 命令 | 结果 |
| --- | --- |
| `node --import tsx --test packages/desktop-setup/test/*.test.ts packages/provider-newapi/test/*.test.ts packages/video-cli/test/newapi-first-run.test.ts` | 330 通过，0 失败 |
| `npm run check` | TypeScript 检查通过 |
| `npm test` | 1459 项：1436 通过、23 按现有环境条件跳过、0 失败 |
| `npm run pack:distribution -- --json-path` | 生成 `hypit-hypit-0.2.16.tgz` |
| `npm run check:distribution -- ./dist/release/hypit-hypit-0.2.16.tgz` | 全新安装、示例组件编译、字体准备、本地 Runtime、渲染、导出、ffprobe 与 FFmpeg 解码通过；Runtime Worker 已停止 |
| `git diff --check` | 通过 |

`npm run desktop:dist:mac` 与 `npm run desktop:dist:win` 分别重新打包 Distribution、锁定的目标平台依赖、Skill 和 FFmpeg/FFprobe；构建脚本从实际 DMG/NSIS 解包内容核对资源清单和哈希，并生成最终校验文件。两个命令均退出 0。构建日志确认 macOS 签名禁用，Windows 安装器与卸载器签名均跳过。

## macOS Apple Silicon 安装检查

1. 使用 `hdiutil attach -readonly -nobrowse` 挂载**最终 DMG**；应用主程序、FFmpeg、FFprobe 经 `file` 确认都是 Mach-O arm64。
2. 从挂载应用中的 `app.asar` 提取检查 `dist/main.cjs`、`dist/preload.cjs`、`dist/renderer.js`、`dist/index.html`、`dist/styles.css`、`dist/cleanup.cjs`，都存在；完整 Skill、资源清单和解包的 Windows 凭据辅助脚本也存在。
3. 从 DMG 将应用复制到当前用户的 `/Users/wwq/Applications/Hypit Setup.app`。在复制前确认目标不存在；复制后运行安装资源检查，资源清单、文件哈希、Skill 与 GUI bundle 通过。
4. 在 `PATH` 为空的环境中，安装后内置 CLI `--version` 返回 `0.2.16`，内置 FFmpeg 返回 `4.4`，FFprobe 返回 `n4.4.1`。运行安装后 CLI 的 `doctor --json`，一个本地示例 Profile 返回 `ok: true`。
5. 通过 `open -a` 启动**已复制的应用**，可见中文欢迎页和六项必填配置表单；“测试连接并安装”在字段为空时禁用。GUI 资源和基本交互已目视检查。
6. 安装后 CLI 对现有示例 Run 执行了只读 `plan`；其输出列出 8 个请求及 Provider 价格页，但因示例的 WhisperX 与 Seedance Endpoint 未配置，退出码为 1，并明确显示 2 项未解析。没有启动 Build 或付费生成。

本次桌面向导连接测试显示 `SETUP_OSS_FAILED`，并提示 OSS 测试对象键 `relay/hypit/setup-test/dc33f5ae-80f5-4e30-a9db-56c9e4489a62.txt` 可能需要手动清理。未自动访问或清理该对象。由于连接测试未完成，桌面 Profile 与 `~/.local/bin/hypit` 尚未生成，平台凭据落盘、托管 Skill、桌面 Profile 选择及该配置的 Runtime 启停尚不能标记为通过。此错误与其对象清理需使用者确认后再复测；报告不记录任何输入字段值或密钥。

第一次复制到“应用程序”时，构建残留的解包目录占满磁盘，`ditto` 报 `No space left on device`。已删除本次创建的不完整应用拷贝及四个可再生的 `release/mac-arm64`、`release/win-unpacked`、`resources/mac-arm64`、`resources/win-x64` 目录，磁盘恢复后从同一最终 DMG 重新复制成功。最终 DMG/EXE 和校验文件未被删除或修改。检查结束后已卸载 DMG 卷；已复制的应用保留在当前用户“应用程序”中。

## Windows x64 交叉构建检查

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
- 未完成 macOS 桌面向导的成功连接与凭据保存、托管 Skill/命令入口、桌面 Profile 下的 Runtime 启停验收；见上方 OSS 错误。
- 未运行任何付费图片或视频生成测试。若需运行，须先单独确认所选模型、参数和预估费用。
