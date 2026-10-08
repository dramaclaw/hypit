# PR #2 Review Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 关闭 PR #2 中转写证据缺失和 CosyVoice 任意 HTTPS 音频下载这两项 Review 问题，并用中文回复评审。

**Architecture:** 转写 handler 在现有解释器之后，按实际采用的段落级或顶层 `words` 路径验证证据。CosyVoice JSON 配音路径通过独立的 URL 目的地校验器下载素材；配置解析只暴露可选的完整可信 origin 列表，图片和视频下载保持原状。

**Tech Stack:** TypeScript, Node `fetch`/`URL`, `node --import tsx --test`, pnpm workspace.

## Global Constraints

- 只在 `/Users/wwq/review-worktrees/prs/dramaclaw/hypit/pr-2` 中检查和修改 PR 源代码。
- 不把 NewAPI API Key、音色 ID 或签名 URL 写入文件或评论。
- 默认允许网关同源及公开阿里云 OSS；其他 origin 必须在 Endpoint 配置 `audioAssetOrigins` 中显式列出；音频下载禁止自动重定向。
- 保留顶层 `words` 回退、二进制配音、现有图片/视频素材下载和旧 Profile 不自动覆盖。

---

### Task 1: 逐段转写证据校验

**Files:**
- Modify: `packages/provider-newapi/test/transcription.test.ts`
- Modify: `packages/provider-newapi/src/provider.ts`

**Interfaces:**
- Consumes: `interpretWhisperXTranscript(response, sampleFrames)` 的 passages；原始 `response.segments` 与 `response.words`。
- Produces: `audio-transcribe` 非空段落缺少逐词时间戳时拒绝，顶层 `words` 回退仍通过。

- [ ] **Step 1: 写失败回归测试。** 在 `transcription.test.ts` 用两个段落构造响应，第一个有 `words`，第二个有非空 `text` 却无 `words`；用 `assert.rejects(..., /timed words/u)` 验证整次调用失败。另加入一个段落全无 `words`、顶层有完整 `words` 的成功断言，保留当前网关格式。
- [ ] **Step 2: 验证红灯。** 运行 `node --import tsx --test packages/provider-newapi/test/transcription.test.ts`；预期新混合段落测试失败（当前代码错误地成功），原有顶层回退仍通过。
- [ ] **Step 3: 最小修复。** 在 `provider.ts` 解释后，仅当原始 segments 中至少一段带有效词、解释器采用段落级结果时，按索引执行以下校验；顶层 `words` 路径维持现有全局检查：

  ```ts
  const segments = Array.isArray(response.segments) ? response.segments : [];
  const usesSegmentWords = passages.length === segments.length
    && passages.some((passage) => passage.words.length > 0);
  if (usesSegmentWords) {
    for (let index = 0; index < passages.length; index += 1) {
      const segment = segments[index] as Record<string, unknown>;
      assert(typeof segment.text !== "string" || segment.text.trim().length === 0
        || passages[index]!.words.length > 0,
      "DramaClaw NewAPI transcription segment has no timed words");
    }
  }
  ```

  沿用现有逐词 `startSample` / `endSampleExclusive` 校验；检查只有非空文本的段落，不因无声段落拒绝。
- [ ] **Step 4: 验证绿灯。** 重跑该测试文件，预期所有测试通过；运行 `pnpm check`，预期退出 0。
- [ ] **Step 5: 提交。** `git add packages/provider-newapi/test/transcription.test.ts packages/provider-newapi/src/provider.ts && git commit -m "fix(newapi): require timed words for every spoken segment"`。

### Task 2: 可信音频素材目的地

**Files:**
- Create: `packages/provider-newapi/src/audio-url.ts`
- Modify: `packages/provider-newapi/src/provider.ts`
- Modify: `packages/provider-newapi/src/config.ts`
- Modify: `packages/provider-newapi/src/activation.ts`
- Modify: `packages/provider-newapi/test/cosyvoice.test.ts`
- Modify: `packages/provider-newapi/test/config.test.ts`
- Modify: `packages/provider-newapi/README.md`

**Interfaces:**
- Consumes: `baseUrl`、可选 `audioAssetOrigins: readonly string[]`、网关 `audio.url`。
- Produces: `assertTrustedAudioAssetUrl(url, baseUrl, origins)`；只有 CosyVoice JSON 音频下载使用该校验和 `redirect: "error"`。

- [ ] **Step 1: 写失败回归测试。** `cosyvoice.test.ts` 覆盖 `https://127.0.0.1/`、带凭据 URL、伪装 OSS 后缀、OSS internal 端点、非默认端口均在第二次 fetch 前拒绝；合法公开 OSS URL 继续成功；测试下载请求 `redirect === "error"` 且无 `authorization`；配置额外可信 origin 后接受该 origin，不配置时拒绝。`config.test.ts` 验证数组原样解析并拒绝非字符串成员。
- [ ] **Step 2: 验证红灯。** 运行 `node --import tsx --test packages/provider-newapi/test/cosyvoice.test.ts packages/provider-newapi/test/config.test.ts`；预期新增安全测试失败。
- [ ] **Step 3: 最小实现。** 新建 `audio-url.ts`，用 `new URL()` 解析并断言协议、userinfo、hash、端口；只接受 `baseUrl` 同源、完整匹配的 `audioAssetOrigins` 或公开 OSS 主机（`<bucket>.oss-<region>.aliyuncs.com` / `oss-<region>.aliyuncs.com`，`-internal` 排除）。在 `CreateNewApiProviderOptions` 与 `NewApiEndpointConfig` 增加可选 origins；`config.ts` 的 `runtimeConfigExact` 加字段，并验证它是字符串数组；`activation.ts` 透传。CosyVoice `audio.url` 路径在调用 `asset` 前执行目的地校验，`asset` 为此路径传递 `redirect: "error"`，其他调用保持现状。README 说明默认与额外可信源配置。
- [ ] **Step 4: 验证绿灯。** 重跑 CosyVoice 与配置测试，预期通过；运行 `pnpm check`，预期退出 0。
- [ ] **Step 5: 提交。** `git add packages/provider-newapi && git commit -m "fix(newapi): constrain CosyVoice audio downloads"`。

### Task 3: 完整验证、推送、回复

**Files:** 本 Task 不修改生产代码；若验证发现遗漏，回到相应 Task 的红绿循环。

**Interfaces:**
- Consumes: Task 1、2 的提交与测试结果。
- Produces: PR #2 更新及中文 Review 回复。

- [ ] **Step 1: 验证。** 运行 `node --import tsx --test packages/provider-newapi/test/*.test.ts`、`pnpm check`、`pnpm test`、`git diff --check refs/remotes/origin/main...HEAD`；逐项确认退出 0，且 diff 不含密钥、签名 URL 或不相关改动。
- [ ] **Step 2: 检查远端。** 读取 `gh pr view 2 --repo dramaclaw/hypit --json headRefName,headRefOid`，从专用 clone fetch 最新 PR ref，确认远端仍是当前本地修复提交的祖先；若被他人更新，先审阅差异再决定整合，不强推。
- [ ] **Step 3: 推送。** 将本 worktree 的 `HEAD` 非强制推送到 PR 源分支 `codex/newapi-models`。
- [ ] **Step 4: 中文回复。** 在 PR #2 的 Review 上说明逐段证据校验、可信 URL 与重定向防护的具体修复、提交及测试结果；确认评论已发布且 PR 指向新提交。
