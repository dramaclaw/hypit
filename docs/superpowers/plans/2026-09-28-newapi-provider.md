# DramaClaw NewAPI Provider 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Hypit fork 中加入支持 9 个现有 Hypit 图片/视频能力的 NewAPI Provider，并让 OSS 仅在请求包含本地参考素材时成为必需。

**Architecture:** 新包 `@dramaclaw/provider-newapi` 使用 Hypit 的 `GenerationWireMapping` 把精确模型端口映射到 DramaClaw NewAPI 请求。图片能力走即时 `/images/generations` 或 `/images/edits`；视频能力走 `/video/generations` 的提交、轮询和收集生命周期。OSS 发布器延迟创建，只有解析媒体 Artifact URL 时才读取 OSS 配置和凭据。

**Tech Stack:** TypeScript、Node.js test runner、Hypit endpoint/generation/runtime SDK、`ali-oss`、pnpm workspace。

## Global Constraints

- 只支持设计文档列出的 9 个 Hypit 已有精确模型能力。
- 不新增文本、Embedding、TTS、音乐或 WhisperX 能力。
- `baseUrl` 和 `apiKey` 必填；OSS 四项配置要么全部提供，要么全部省略。
- 纯文字请求不能读取或要求 OSS 凭据。
- 所有真实密钥只通过 `CredentialRef` 解析，不进入仓库、错误或日志。
- 使用测试优先流程；每项生产行为必须先出现能够正确失败的测试。

---

### Task 1: 建立包和九模型映射

**Files:**
- Create: `packages/provider-newapi/package.json`
- Create: `packages/provider-newapi/src/index.ts`
- Create: `packages/provider-newapi/src/mapping.ts`
- Create: `packages/provider-newapi/src/routes.ts`
- Create: `packages/provider-newapi/test/routes.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `newApiMappings: readonly GenerationWireMapping[]`
- Produces: `newApiRoutes: readonly NewApiRoute[]`
- Produces: `newApiRouteForCapability(capability: CapabilityRef): NewApiRoute | undefined`
- Each route exposes `prepare(constraints)` returning the NewAPI model name and a request compiler.

- [ ] **Step 1: 写映射覆盖失败测试**

测试导入九个 Hypit 端口表，断言 `newApiMappings` 共九项，并对每项调用 `assertMappingCoversPorts`；同时逐项断言能力与 NewAPI 模型名：`LingShan-G2`、`LingShan-NB-2`、`LingShan-NB-Pro`、`seedream-5.0-lite`、四个 Seedance 变体和 `MiniMax-H3`。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --import tsx --test packages/provider-newapi/test/routes.test.ts`

Expected: FAIL，因为 `src/mapping.ts` 和 `src/routes.ts` 尚不存在。

- [ ] **Step 3: 实现最小映射和路由**

图片映射使用 `prompt`、`images`、`aspectRatio`、分辨率/质量和格式字段；视频映射使用 `prompt`、三类参考媒体、首尾帧、分辨率、比例、时长、生成音频和 Web Search 字段。路由通过 `compileWireRequest` 解析引用 URL，并根据 DramaClaw 目录限制返回 `supported` 或明确的 `unsupported` 原因。

- [ ] **Step 4: 运行映射测试和类型检查确认 GREEN**

Run: `node --import tsx --test packages/provider-newapi/test/routes.test.ts`

Run: `pnpm check`

Expected: 两条命令均以 0 退出。

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-lock.yaml packages/provider-newapi
git commit -m "feat(newapi): map supported Hypit media models"
```

### Task 2: 实现可选 OSS 配置和惰性发布器

**Files:**
- Create: `packages/provider-newapi/src/activation.ts`
- Create: `packages/provider-newapi/src/relay.ts`
- Create: `packages/provider-newapi/test/activation.test.ts`
- Create: `packages/provider-newapi/test/relay.test.ts`

**Interfaces:**
- Produces: `createOssPublisher(options): GenerationArtifactUrlResolver`
- Activation accepts required `baseUrl`/`apiKey` and optional all-or-none relay group.
- Provider options receive `publicAssetUrl?`; absence is valid until a request resolves media.

- [ ] **Step 1: 写配置行为失败测试**

测试以下行为：仅 `baseUrl` 和 `apiKey` 能激活；完整 OSS 组能激活；只提供 OSS 组中任一部分会失败；没有发布器时解析参考素材返回“需要配置 OSS 中转”的无密钥错误。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --import tsx --test packages/provider-newapi/test/activation.test.ts packages/provider-newapi/test/relay.test.ts`

Expected: FAIL，因为激活器和发布器尚不存在。

- [ ] **Step 3: 实现最小激活和发布逻辑**

激活器用 `runtimeConfigExact` 校验字段，用 `runtimeConfigCredentialRef` 保留密钥引用。`relay.ts` 在首次媒体解析时创建 `OSS` 客户端，上传到 `relay/hypit/YYYYMMDD/<uuid>.<ext>`，返回默认 3600 秒的签名 URL；没有完整 relay 配置时抛出不含素材 URL 和凭据的错误。

- [ ] **Step 4: 运行测试和类型检查确认 GREEN**

Run: `node --import tsx --test packages/provider-newapi/test/activation.test.ts packages/provider-newapi/test/relay.test.ts`

Run: `pnpm check`

Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add packages/provider-newapi
git commit -m "feat(newapi): make OSS relay optional"
```

### Task 3: 实现图片即时执行和视频任务生命周期

**Files:**
- Create: `packages/provider-newapi/src/provider.ts`
- Create: `packages/provider-newapi/src/errors.ts`
- Create: `packages/provider-newapi/test/provider.test.ts`

**Interfaces:**
- Produces: `createNewApiProvider(options): EndpointPackage`
- Image handlers return `GeneratedImageSet` immediately.
- Video endpoint returns a durable handle containing task ID、route key and submission time, then polls and collects `GeneratedVideoSet`.

- [ ] **Step 1: 写图片和视频失败测试**

覆盖：纯文字图片不调用发布器；参考图会调用发布器并走 `/images/edits`；纯文字视频不调用发布器；视频状态 `not_start`/`in_progress` 继续轮询；完成状态读取 `result_url`；`fail_reason` 保留公开原因；人物引用传递 `human_review`；错误信息不泄露 Authorization 或签名查询参数。

- [ ] **Step 2: 运行测试确认 RED**

Run: `node --import tsx --test packages/provider-newapi/test/provider.test.ts`

Expected: FAIL，因为 `createNewApiProvider` 尚未实现。

- [ ] **Step 3: 实现最小 Provider**

实现一个带超时的 NewAPI 客户端。图片按引用是否存在选择 `/images/generations` 或 `/images/edits`，接收 `b64_json` 或结果 URL。视频提交到 `/video/generations`，持久化任务 ID，按 NewAPI 状态轮询并在完成后下载结果。所有返回媒体通过 `context.resources.put` 纳入 Hypit Resource Store。

- [ ] **Step 4: 运行 Provider 测试、全部包测试和类型检查确认 GREEN**

Run: `node --import tsx --test packages/provider-newapi/test/*.test.ts`

Run: `pnpm check`

Expected: 全部通过。

- [ ] **Step 5: 提交**

```bash
git add packages/provider-newapi
git commit -m "feat(newapi): execute image and video generation"
```

### Task 4: 团队配置说明和最终回归

**Files:**
- Create: `packages/provider-newapi/README.md`
- Create: `examples/newapi-runtime/hypit.runtime.json`
- Create: `examples/newapi-runtime/README.md`
- Modify: `package.json`

**Interfaces:**
- Documents the nine mappings, required NewAPI configuration, optional OSS relay group, `hypit auth` commands and capability bindings.
- Example contains CredentialRefs and placeholders only, never secret values.

- [ ] **Step 1: 添加文档契约测试或分发检查所需清单**

在现有分发测试约定中断言新包的 README、activation 和示例配置能够被打包；如果仓库的分发检查已经按 glob 自动覆盖，则记录该现有覆盖并只补缺失的根依赖声明。

- [ ] **Step 2: 运行检查确认 RED**

Run: `pnpm check:distribution`

Expected: 在清单尚未包含新包或示例时失败。

- [ ] **Step 3: 添加中文团队说明和无密钥示例**

README 明确纯文字不需要 OSS，引用素材才需要 OSS，并列出九个模型和各自 Hypit binding。示例 Runtime 使用 `platform` Credential Store 和 `newapi.team` Endpoint。

- [ ] **Step 4: 最终验证**

Run: `node --import tsx --test packages/provider-newapi/test/*.test.ts`

Run: `pnpm check`

Run: `pnpm check:distribution`

Run: `pnpm test`

Expected: 所有命令以 0 退出，没有密钥扫描或 TypeScript 错误。

- [ ] **Step 5: 提交**

```bash
git add package.json packages/provider-newapi examples/newapi-runtime
git commit -m "docs(newapi): add team runtime setup"
```
