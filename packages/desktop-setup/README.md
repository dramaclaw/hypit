# Hypit 桌面安装器

此私有 workspace 包生成中文配置向导和团队内部测试安装包：macOS Apple Silicon DMG、Windows x64 NSIS EXE。两者均未签名；Windows EXE 从 macOS 交叉构建。用户安装与配置步骤见 [中文桌面安装指南](../../docs/zh/guide/desktop-installer.md)。

在仓库根目录安装依赖后，使用 `npm run desktop:dist:mac` 和 `npm run desktop:dist:win` 分别构建。脚本会重新打包 Hypit Distribution、准备对应平台的 FFmpeg/FFprobe 与 Skill、核对包内资源，最后在本目录的 `release/` 下生成安装包及相邻的 `.sha256` 文件。`release/`、`resources/`、`dist/` 是可再生输出，不应提交到 Git。

FFmpeg/FFprobe 由 `media-lock.json` 固定：macOS arm64 为 Martin Riedl 9.0.2，Windows x64 为 Gyan 9.0.2 essentials。下载文件及解压后二进制均校验 SHA-256；缓存位于本包 `node_modules/.cache/hypit-media`，不能用本机 PATH 上的 FFmpeg 替代。资源与最终安装包均检查架构、`fps_mode` 选项、禁止 `--enable-nonfree`、锁定哈希和完整许可证文件。打包主机与目标相同则真实执行 `-fps_mode cfr` 的两帧 H.264 编码及 FFprobe 检查；跨平台构建仅检查静态能力，仍需原生目标验收。

安装包 `licenses/` 含完整 GPL 许可证、版本/编译选项和来源说明。两平台均采用 GPL-3.0-or-later 的独立命令行程序。当前安装包用于团队内部测试；外部分发须同时提供包括链接库及构建配方在内的对应源码，详见 `media-licenses/*/SOURCES.md`。不要使用带 `--enable-nonfree` 的替代构建。

完整资源生成后，可用 `HYPIT_TEST_STAGED_MEDIA=1 node --import tsx --test packages/desktop-setup/test/media-capabilities.test.ts` 在仓库根目录复验两目标媒体能力。

向导必须配置 NewAPI 地址、API Key、OSS Endpoint、Bucket、AccessKey ID、AccessKey Secret。点击“测试连接并安装”只测试模型列表与 OSS 小文件上传/下载/删除。密钥存入系统凭据库，桌面 Runtime Profile 只保存引用。普通卸载保留 Profile、凭据和视频项目；完整清除须在向导里另行确认。

验证命令与实际平台覆盖范围记录在 [TEST-REPORT.md](./TEST-REPORT.md)。

## 可选本地 WhisperX

配置完成或重新打开后，“本地语音识别与字幕对齐（可选）”提供“安装并启动”。只有主动点击才准备本地依赖及模型；默认 `small / cpu / int8`、中文 `zh` 和英文 `en`。下载可能较大且耗时，失败可“重试安装”；不收取 NewAPI 模型费用，也不读取 NewAPI/OSS 凭据。关闭窗口不取消正在执行的准备，重新打开可“检查状态”；强制退出应用或系统关机会中断进程。

安装包包含锁定的 uv 0.12.20（macOS arm64 / Windows x64）及 MIT/Apache 许可证，不要求用户安装 Python 或 uv，不回退到系统 uv。WhisperX 服务源码与 `services/whisperx/uv.lock` 随 Distribution 分发；Python 依赖及模型权重按需下载。Program Home 为 `<hostState>/programs/whisperx-whisperx.local-127.0.0.1%3A8765`，保存 `.venv`、`nltk_data` 和 `install.log` / `program.log`。Hugging Face、torch 模型缓存，以及 uv 包缓存和下载的 Python，可能保存在各自上游默认位置；当前并不保证所有资源集中在 Program Home。

普通卸载保留 Program Home、模型缓存、桌面 Profile 及其本地绑定。停止服务后可按[中文指南](../../docs/zh/guide/desktop-installer.md#本地语音资源的保留与人工检查)人工检查占用；当前没有自动删除语音资源按钮。不要递归清空 Hypit 主目录或共享缓存，也不要跟随符号链接删除未知文件。单独确认的“清除本机配置和凭据”会删除整个桌面 Profile（包括绑定），但仍保留模型资源。

本地服务提供逐词/逐字时间戳，能力为 `@hypit/whisperx@1#whisperx-alignment`。未来 NewAPI 对齐适配器需返回同一 `AlignedTranscriptEvidence`，可将绑定从 `whisperx.local` 切到 `newapi.personal`；句子级时间戳或纯转写文本不能替代逐词对齐。当前尚未实现该云端适配器，切换设计不要求修改项目或删除本地模型。
