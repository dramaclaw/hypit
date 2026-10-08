# 桌面安装向导预填 NewAPI 与 OSS 地址

## 目标

首次进入 Hypit 桌面安装向导时，三个非敏感配置项直接显示以下可编辑的值：

- NewAPI 地址：`https://llm-gateway-test.cdnfg.com/v1`
- OSS Endpoint：`oss-cn-chengdu.aliyuncs.com`
- OSS Bucket：`claymore-llm-relay`

API Key、OSS AccessKey ID、OSS AccessKey Secret 始终为空，由使用者自行填写。

## 行为与边界

安装向导只在初始化表单时应用默认值。已有草稿中的合法、非空自定义地址或 Bucket 优先；缺失、空白或不合法的草稿字段使用对应默认值。用户仍可在输入框中修改或清空任何预填项；保存和提交使用当前输入值，不能在提交时强制改回默认值。

草稿继续只保存三个非敏感字段，绝不保存密钥。已安装的 Runtime Profile、系统凭据及服务端配置不因打开向导而修改。这三个默认值是安装器的 UI 初始值，不从同名环境变量读取，也不代表连接测试一定通过。

## 实现与验证

沿用 `initialWizardState` 的草稿恢复入口，集中定义三个默认字符串，并让设置页输入框读取状态中的实际值。保留现有六项必填与 NewAPI/OSS 连接测试流程。增加测试覆盖首次打开、旧版空草稿、自定义草稿优先、输入可修改、密钥不预填及不写入草稿。通过类型检查和完整测试后，重新构建并验证 macOS ARM64 DMG 与 Windows x64 EXE；Windows 真机运行不在本次验证范围内。
