# Hypit 桌面安装器

此私有 workspace 包生成中文配置向导和团队内部测试安装包：macOS Apple Silicon DMG、Windows x64 NSIS EXE。两者均未签名；Windows EXE 从 macOS 交叉构建。用户安装与配置步骤见 [中文桌面安装指南](../../docs/zh/guide/desktop-installer.md)。

在仓库根目录安装依赖后，使用 `npm run desktop:dist:mac` 和 `npm run desktop:dist:win` 分别构建。脚本会重新打包 Hypit Distribution、准备对应平台的 FFmpeg/FFprobe 与 Skill、核对包内资源，最后在本目录的 `release/` 下生成安装包及相邻的 `.sha256` 文件。`release/`、`resources/`、`dist/` 是可再生输出，不应提交到 Git。

向导必须配置 NewAPI 地址、API Key、OSS Endpoint、Bucket、AccessKey ID、AccessKey Secret。点击“测试连接并安装”只测试模型列表与 OSS 小文件上传/下载/删除。密钥存入系统凭据库，桌面 Runtime Profile 只保存引用。普通卸载保留 Profile、凭据和视频项目；完整清除须在向导里另行确认。

验证命令与实际平台覆盖范围记录在 [TEST-REPORT.md](./TEST-REPORT.md)。
