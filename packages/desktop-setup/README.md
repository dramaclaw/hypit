# Hypit 桌面安装器

此私有 workspace 包生成中文配置向导和团队内部测试安装包：macOS Apple Silicon DMG、Windows x64 NSIS EXE。两者均未签名；Windows EXE 从 macOS 交叉构建。用户安装与配置步骤见 [中文桌面安装指南](../../docs/zh/guide/desktop-installer.md)。

在仓库根目录安装依赖后，使用 `npm run desktop:dist:mac` 和 `npm run desktop:dist:win` 分别构建。脚本会重新打包 Hypit Distribution、准备对应平台的 FFmpeg/FFprobe 与 Skill、核对包内资源，最后在本目录的 `release/` 下生成安装包及相邻的 `.sha256` 文件。`release/`、`resources/`、`dist/` 是可再生输出，不应提交到 Git。

FFmpeg/FFprobe 由 `media-lock.json` 固定：macOS arm64 为 Martin Riedl 9.0.2，Windows x64 为 Gyan 9.0.2 essentials。下载文件及解压后二进制均校验 SHA-256；缓存位于本包 `node_modules/.cache/hypit-media`，不能用本机 PATH 上的 FFmpeg 替代。资源与最终安装包均检查架构、`fps_mode` 选项、禁止 `--enable-nonfree`、锁定哈希和完整许可证文件。打包主机与目标相同则真实执行 `-fps_mode cfr` 的两帧 H.264 编码及 FFprobe 检查；跨平台构建仅检查静态能力，仍需原生目标验收。

安装包 `licenses/` 含完整 GPL 许可证、版本/编译选项和来源说明。两平台均采用 GPL-3.0-or-later 的独立命令行程序。当前安装包用于团队内部测试；外部分发须同时提供包括链接库及构建配方在内的对应源码，详见 `media-licenses/*/SOURCES.md`。不要使用带 `--enable-nonfree` 的替代构建。

完整资源生成后，可用 `HYPIT_TEST_STAGED_MEDIA=1 node --import tsx --test packages/desktop-setup/test/media-capabilities.test.ts` 在仓库根目录复验两目标媒体能力。

向导必须配置 NewAPI 地址、API Key、OSS Endpoint、Bucket、AccessKey ID、AccessKey Secret。点击“测试连接并安装”只测试模型列表与 OSS 小文件上传/下载/删除。密钥存入系统凭据库，桌面 Runtime Profile 只保存引用。普通卸载保留 Profile、凭据和视频项目；完整清除须在向导里另行确认。

验证命令与实际平台覆盖范围记录在 [TEST-REPORT.md](./TEST-REPORT.md)。

## NewAPI 语音转文字与对齐

桌面 Profile 默认把 `@hypit/whisperx@1#whisperx-alignment` 绑定到 `newapi.personal`。这是能力契约名称，不代表在本机运行 WhisperX。安装包不含 uv、Python 服务或模型权重，配置向导也不会下载多 GB 的本地模型。实际转写由 NewAPI 的 `audio-transcribe` 接口完成，并须返回逐词或逐字时间戳；模型调用可能计费。

旧版桌面 Profile 缺少该绑定时，启动新版向导会只补这一项，不读取或覆盖现有凭据与其他配置。已有自定义语音绑定不会自动替换。旧版曾下载的本地服务、模型和缓存不会被升级或卸载流程删除，需用户确认归属后自行清理。
