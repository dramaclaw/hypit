# 桌面安装器改用 NewAPI 语音转文字

目标：以已合并的 NewAPI 逐词转写实现构建新 DMG 和 EXE。桌面用户只配置 NewAPI 与 OSS，不再看到、安装或下载本地 WhisperX、Python、uv 和模型。

设计：保留 `@hypit/whisperx@1#whisperx-alignment` 能力契约，默认绑定到 `newapi.personal`。从桌面 UI、IPC 和主进程删除本地服务操作；从桌面安装资源去掉 uv、`services/whisperx` 和 `provider-whisperx-local`，但不改通用源码发布与旧用户资源。已有桌面 Profile 仅在原绑定缺失时补 NewAPI 绑定；如已绑定其他端点则保留并提示检查，不自动覆盖。升级和卸载不删除旧模型、缓存或服务文件。

验收：新 Profile 与安全迁移测试、桌面 UI/IPC 测试、资源清单和实包检查；DMG 与 EXE 各附 SHA-256。跨平台打包不等于 Windows 实机验收；不发起付费转写。
