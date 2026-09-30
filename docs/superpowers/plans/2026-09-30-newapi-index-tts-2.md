# NewAPI IndexTTS2 Voice Cloning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route Hypit's existing `mimo-v2.5-tts-voiceclone` capability through NewAPI's `index-tts-2` model and return the generated speech as a Hypit audio result.

**Architecture:** Extend the existing `@dramaclaw/provider-newapi` wire mapping instead of defining another Hypit model. The Provider publishes the single voice-reference artifact through its existing OSS relay, translates the exact Hypit request to `POST /audio/speech`, stores the binary audio response in the Build ResourceStore, and exposes the route as an immediate endpoint.

**Tech Stack:** TypeScript, Hypit generation/model/endpoint SDKs, Node `fetch`, `node:test`, Aliyun OSS relay.

## Global Constraints

- Reuse `@hypit/mimo-speech@1#mimo-v2.5-tts-voiceclone`; do not add a new Hypit Model definition.
- Support exactly one spoken text, exactly one audio voice reference, and at most one optional delivery instruction as defined by the existing Model.
- Route to NewAPI model `index-tts-2` through `POST /audio/speech`.
- Map `text` to `input`, `voiceReference` to `metadata.audio_url`, and `instruction` to `metadata.emotion_prompt` with `metadata.should_use_prompt_for_emotion: true` only when an instruction exists.
- Require the existing OSS publisher for the reference audio and fail before the paid NewAPI request when it is absent.
- Accept only non-empty `audio/*` responses, store them in ResourceStore, and return `GeneratedAudioSet`.
- Do not retry an uncertain speech generation automatically.
- Never expose API keys, OSS credentials, or signed URLs in public errors.
- Do not perform a paid live generation during automated verification.

## File Structure

- `packages/provider-newapi/src/mapping.ts`: declares the existing Hypit voice-clone capability and its flat wire fields.
- `packages/provider-newapi/src/routes.ts`: recognizes audio as a result type and packages audio artifacts.
- `packages/provider-newapi/src/provider.ts`: translates the flat wire request to NewAPI's nested speech body, posts and validates binary audio, and registers the immediate audio handler.
- `packages/provider-newapi/test/routes.test.ts`: verifies exact capability coverage and request compilation.
- `packages/provider-newapi/test/provider.test.ts`: verifies OSS publication, HTTP shape, audio storage, preflight failure, and sanitization.
- `packages/provider-newapi/test/setup.test.ts`: verifies the default Profile binding catalogue includes the speech route.
- `packages/provider-newapi/package.json`: declares `@hypit/mimo-speech` as a model-contract development dependency.
- `packages/provider-newapi/README.md`: documents the supported speech route and its OSS requirement.

---

### Task 1: Add the exact voice-clone route contract

**Files:**
- Modify: `packages/provider-newapi/src/mapping.ts`
- Modify: `packages/provider-newapi/src/routes.ts`
- Modify: `packages/provider-newapi/test/routes.test.ts`
- Modify: `packages/provider-newapi/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Consumes: `mimoSpeechPorts["mimo-v2.5-tts-voiceclone"]` and the existing `GenerationWireMapping` compiler.
- Produces: one `NewApiRoute` whose capability key is `@hypit/mimo-speech@1#mimo-v2.5-tts-voiceclone`, model is `index-tts-2`, result is `audio`, and `packageResult()` returns a `GeneratedAudioSet`.

- [ ] **Step 1: Write the failing route-contract test**

Add the Mimo imports, expected model and port table entry in `packages/provider-newapi/test/routes.test.ts`:

```ts
import { mimoSpeechPorts, sealMimoSpeechRequest } from "@hypit/mimo-speech";

const expectedModels = new Map([
  // existing entries remain unchanged
  ["@hypit/mimo-speech@1#mimo-v2.5-tts-voiceclone", "index-tts-2"],
]);

const tables = {
  // existing entries remain unchanged
  "mimo-v2.5-tts-voiceclone": mimoSpeechPorts["mimo-v2.5-tts-voiceclone"],
};

test("NewAPI compiles Hypit voice cloning for IndexTTS2", async () => {
  const route = newApiRouteForCapability({
    module: { name: "@hypit/mimo-speech", version: "1" },
    name: "mimo-v2.5-tts-voiceclone",
  });
  assert.ok(route);
  const request = sealMimoSpeechRequest("mimo-v2.5-tts-voiceclone", {
    text: ["今天开始使用 AI 提高办公效率。"],
    instruction: ["沉稳、自信地讲解。"],
    voiceReference: [{
      role: "audio",
      artifact: { kind: "blob", resource: "res_voice", mediaType: "audio/wav", size: 3 },
    }],
  });
  assert.equal(route.returns.name, generationTypes.audioSet.name);
  assert.deepEqual(await route.prepare(constraints(request)).compile(async () => "https://relay.example/voice.wav"), {
    input: "今天开始使用 AI 提高办公效率。",
    emotion_prompt: "沉稳、自信地讲解。",
    audio_url: "https://relay.example/voice.wav",
  });
});
```

- [ ] **Step 2: Run the route test and verify it fails**

Run:

```bash
pnpm exec tsx --test packages/provider-newapi/test/routes.test.ts
```

Expected: FAIL because the Mimo dependency/route is absent and the current route result union only supports image and video.

- [ ] **Step 3: Add the Mimo mapping and audio route packaging**

In `packages/provider-newapi/src/mapping.ts`, declare the module and append this mapping:

```ts
const MIMO_SPEECH: ModuleRef = { name: "@hypit/mimo-speech", version: "1" };

{
  capability: { module: MIMO_SPEECH, name: "mimo-v2.5-tts-voiceclone" },
  result: "audio",
  routes: [{ model: "index-tts-2" }],
  fields: {
    text: { as: "value", field: "input" },
    instruction: { as: "value", field: "emotion_prompt" },
    voiceReference: { as: "url", field: "audio_url" },
  },
},
```

In `packages/provider-newapi/src/routes.ts`:

```ts
import {
  compileWireRequest,
  generationTypes,
  sealGeneratedAudioSet,
  sealGeneratedImageSet,
  sealGeneratedVideoSet,
  selectWireModelForRequest,
} from "@hypit/generation";

export type NewApiPreparedRequest = {
  readonly model: string;
  readonly result: "audio" | "image" | "video";
  readonly compile: (resolve: GenerationArtifactUrlResolver) => Promise<Record<string, unknown>>;
};

// In each generated route:
returns: mapping.result === "audio" ? generationTypes.audioSet
  : mapping.result === "image" ? generationTypes.imageSet : generationTypes.videoSet,

// Keep prepare open for all three implemented results:
if (mapping.result !== "audio" && mapping.result !== "image" && mapping.result !== "video") {
  throw new Error(`DramaClaw NewAPI does not implement ${mapping.result} routes`);
}

// In packageResult:
value: canonicalize(mapping.result === "audio"
  ? sealGeneratedAudioSet({ audios: artifacts })
  : mapping.result === "image"
    ? sealGeneratedImageSet({ images: artifacts })
    : sealGeneratedVideoSet({ videos: artifacts })),
```

Add `"@hypit/mimo-speech": "workspace:*"` to `devDependencies` in `packages/provider-newapi/package.json`, then update the lockfile with:

```bash
pnpm install --lockfile-only
```

- [ ] **Step 4: Run the route contract test and type checker**

Run:

```bash
pnpm exec tsx --test packages/provider-newapi/test/routes.test.ts
pnpm check
```

Expected: both commands PASS; the mapping catalogue contains ten routes and the new route compiles the three expected flat fields.

- [ ] **Step 5: Commit the route contract**

```bash
git add packages/provider-newapi/src/mapping.ts packages/provider-newapi/src/routes.ts packages/provider-newapi/test/routes.test.ts packages/provider-newapi/package.json pnpm-lock.yaml
git commit -m "feat(newapi): map IndexTTS2 voice cloning"
```

---

### Task 2: Execute immediate binary speech generation safely

**Files:**
- Modify: `packages/provider-newapi/src/provider.ts`
- Modify: `packages/provider-newapi/test/provider.test.ts`

**Interfaces:**
- Consumes: the Task 1 audio route, `AssetPublisher`, `EndpointInvocationContext.resources`, and the NewAPI API-key credential.
- Produces: `NewApiClient.audio(path, credentials, init)`, `speechBody(request, input)`, and an immediate handler for audio routes.

- [ ] **Step 1: Write the failing successful-generation test**

Import the Mimo helpers in `packages/provider-newapi/test/provider.test.ts` and add:

```ts
import { mimoSpeechEndpoints, sealMimoSpeechRequest } from "@hypit/mimo-speech";

test("IndexTTS2 publishes one voice reference and stores binary speech", async () => {
  const resources = new MemoryResourceStore();
  const voice = await resources.put(new Uint8Array([1, 2, 3]), "audio/wav");
  const request = need(
    mimoSpeechEndpoints.voiceClone.capability,
    generationTypes.audioSet,
    sealMimoSpeechRequest("mimo-v2.5-tts-voiceclone", {
      text: ["欢迎使用 Hypit。"],
      instruction: ["温暖、自然地说。"],
      voiceReference: [{ role: "audio", artifact: voice }],
    }),
    "speech",
  );
  const published: string[] = [];
  const registration = await resolved(request, async (url, init) => {
    assert.equal(String(url), "https://newapi.example/v1/audio/speech");
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: "index-tts-2",
      input: "欢迎使用 Hypit。",
      metadata: {
        audio_url: "https://relay.example/voice.wav",
        emotion_prompt: "温暖、自然地说。",
        should_use_prompt_for_emotion: true,
      },
    });
    return new Response(new Uint8Array([82, 73, 70, 70]), {
      headers: { "content-type": "audio/wav" },
    });
  }, async ({ mediaType }) => {
    published.push(mediaType);
    return "https://relay.example/voice.wav";
  });
  assert.equal(registration.kind, "immediate");
  const result = await registration.handler({
    command: { kind: "fulfill-need", id: "command:speech", need: request },
    need: request,
    resources,
    credentials: allCredentials,
  });
  assert.deepEqual(published, ["audio/wav"]);
  assert.match(JSON.stringify(result), /audio\/wav/u);
});
```

- [ ] **Step 2: Write the failing preflight and response-validation tests**

Add a helper immediately below `resolved()`:

```ts
async function speechRequest(resources: MemoryResourceStore, instruction?: string): Promise<Need> {
  const voice = await resources.put(new Uint8Array([1, 2, 3]), "audio/wav");
  return need(
    mimoSpeechEndpoints.voiceClone.capability,
    generationTypes.audioSet,
    sealMimoSpeechRequest("mimo-v2.5-tts-voiceclone", {
      text: ["欢迎使用 Hypit。"],
      ...(instruction === undefined ? {} : { instruction: [instruction] }),
      voiceReference: [{ role: "audio", artifact: voice }],
    }),
    "speech",
  );
}
```

Add the preflight test:

```ts
test("IndexTTS2 without OSS fails before its paid request", async () => {
  const resources = new MemoryResourceStore();
  const request = await speechRequest(resources);
  let calls = 0;
  const registration = await resolved(request, async () => {
    calls += 1;
    return new Response();
  });
  assert.equal(registration.kind, "immediate");
  await assert.rejects(async () => await registration.handler({
    command: { kind: "fulfill-need", id: "command:speech", need: request },
    need: request,
    resources,
    credentials,
  }), /reference media requires an OSS relay configuration/u);
  assert.equal(calls, 0);
});
```

Add response validation and error sanitization:

```ts
for (const [name, response, message] of [
  ["empty", new Response(new Uint8Array(), { headers: { "content-type": "audio/wav" } }), /empty audio/u],
  ["non-audio", Response.json({ ok: true }), /not audio/u],
] as const) {
  test(`IndexTTS2 rejects ${name} success responses`, async () => {
    const resources = new MemoryResourceStore();
    const request = await speechRequest(resources);
    const registration = await resolved(request, async () => response.clone(),
      async () => "https://relay.example/voice.wav");
    assert.equal(registration.kind, "immediate");
    await assert.rejects(async () => await registration.handler({
      command: { kind: "fulfill-need", id: "command:speech", need: request },
      need: request,
      resources,
      credentials,
    }), message);
  });
}

test("IndexTTS2 redacts upstream speech errors", async () => {
  const resources = new MemoryResourceStore();
  const request = await speechRequest(resources);
  const registration = await resolved(request,
    async () => Response.json({ error: { message: reflected } }, { status: 400 }),
    async () => "https://relay.example/voice.wav");
  assert.equal(registration.kind, "immediate");
  await assert.rejects(async () => await registration.handler({
    command: { kind: "fulfill-need", id: "command:speech", need: request },
    need: request,
    resources,
    credentials: allCredentials,
  }), (error: Error) => {
    assertRedacted(error);
    assert.equal(error.cause, undefined);
    return true;
  });
});
```

Add one request without `instruction` and assert the submitted metadata contains no invented emotion fields:

```ts
test("IndexTTS2 omits emotion metadata without an instruction", async () => {
  const resources = new MemoryResourceStore();
  const request = await speechRequest(resources);
  const registration = await resolved(request, async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { metadata: Record<string, unknown> };
    assert.deepEqual(body.metadata, { audio_url: "https://relay.example/voice.wav" });
    return new Response(new Uint8Array([1]), { headers: { "content-type": "audio/mpeg" } });
  }, async () => "https://relay.example/voice.wav");
  assert.equal(registration.kind, "immediate");
  await registration.handler({
    command: { kind: "fulfill-need", id: "command:speech", need: request },
    need: request,
    resources,
    credentials,
  });
});
```

- [ ] **Step 3: Run focused Provider tests and verify they fail**

Run:

```bash
pnpm exec tsx --test packages/provider-newapi/test/provider.test.ts --test-name-pattern="IndexTTS2|speech"
```

Expected: FAIL because audio routes are not yet registered and `NewApiClient` only reads JSON API responses.

- [ ] **Step 4: Add binary response handling and the speech request body**

Add this method to `NewApiClient`, using the same deadline, credential, transport, retry-header and public-error parsing conventions as `json()`:

```ts
async audio(path: string, credentials: Credentials, init: RequestInit): Promise<{
  readonly bytes: Uint8Array;
  readonly mediaType: string;
}> {
  const deadline = requestDeadline(this.timeout,
    () => new EndpointTransportError("DramaClaw NewAPI speech request timed out"));
  try {
    const response = await transport(deadline.wait(this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      signal: deadline.signal,
      headers: {
        authorization: `Bearer ${credential(credentials, "apiKey")}`,
        "content-type": "application/json",
        ...(init.headers ?? {}),
      },
    })));
    if (!response.ok) {
      const text = await transport(deadline.wait(response.text()));
      let body: unknown = text;
      try { body = text.length === 0 ? {} : JSON.parse(text); } catch { /* retain public text */ }
      throw new EndpointHttpError(
        "DRAMACLAW_NEWAPI_HTTP_ERROR",
        `DramaClaw NewAPI ${init.method ?? "GET"} ${path} failed: ${publicError(body) ?? `HTTP ${response.status}`}`,
        response.status,
        retryAfterMs(response.headers),
      );
    }
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() ?? "";
    assert(mediaType.startsWith("audio/"), "DramaClaw NewAPI speech response is not audio");
    const bytes = new Uint8Array(await transport(deadline.wait(response.arrayBuffer())));
    assert(bytes.byteLength > 0, "DramaClaw NewAPI speech response contains empty audio");
    return { bytes, mediaType };
  } finally {
    deadline.finish();
  }
}
```

Add the body builder:

```ts
function speechBody(request: NewApiPreparedRequest, input: Record<string, unknown>) {
  const instruction = typeof input.emotion_prompt === "string" ? input.emotion_prompt : undefined;
  return {
    model: request.model,
    input: input.input,
    metadata: {
      audio_url: input.audio_url,
      ...(instruction === undefined ? {} : {
        emotion_prompt: instruction,
        should_use_prompt_for_emotion: true,
      }),
    },
  };
}
```

- [ ] **Step 5: Register the immediate audio handler**

Create an `audioEndpoint: ImmediateEndpointHandler` beside `imageEndpoint`:

```ts
const audioEndpoint: ImmediateEndpointHandler = async (context) => {
  try {
    const route = newApiRouteForCapability(context.need.capability);
    assert(route !== undefined && route.result === "audio",
      "DramaClaw NewAPI does not implement this exact audio capability");
    const { request, input } = await prepare(route, context, publish);
    const asset = await client.audio("/audio/speech", context.credentials, {
      method: "POST",
      body: JSON.stringify(speechBody(request, input)),
    });
    const artifact = await context.resources.put(asset.bytes, asset.mediaType);
    return { value: route.packageResult([artifact]) };
  } catch (error) {
    throw safeError(error, context.credentials);
  }
};
```

Change capability registration to select the audio handler explicitly:

```ts
capabilities: newApiRoutes.map((route) => route.result === "video"
  ? { capability: route.capability, returns: route.returns, lifecycle: "asynchronous" as const,
      endpoint: asyncEndpoint, capacity: route.capability.name, supports: route.supports }
  : { capability: route.capability, returns: route.returns, lifecycle: "immediate" as const,
      handler: route.result === "audio" ? audioEndpoint : imageEndpoint,
      capacity: route.capability.name, supports: route.supports }),
```

- [ ] **Step 6: Run Provider tests and type checker**

Run:

```bash
pnpm exec tsx --test packages/provider-newapi/test/provider.test.ts
pnpm check
```

Expected: PASS; provider offers include four image, five video and one audio capability; no test performs a real network request.

- [ ] **Step 7: Commit the execution path**

```bash
git add packages/provider-newapi/src/provider.ts packages/provider-newapi/test/provider.test.ts
git commit -m "feat(newapi): generate cloned speech with IndexTTS2"
```

---

### Task 3: Expose the default binding and document operation

**Files:**
- Modify: `packages/provider-newapi/test/setup.test.ts`
- Modify: `packages/provider-newapi/README.md`

**Interfaces:**
- Consumes: `newApiRoutes` after Tasks 1 and 2.
- Produces: a ten-entry `newApiDefaultBindings` catalogue and operator documentation for required NewAPI/OSS configuration.

- [ ] **Step 1: Update the binding regression test**

Change the setup catalogue assertion:

```ts
test("the setup core owns exactly the ten NewAPI default bindings", () => {
  assert.equal(Object.keys(newApiDefaultBindings).length, 10);
  assert.deepEqual(new Set(Object.keys(newApiDefaultBindings)), new Set(newApiRoutes.map((route) => route.key)));
  assert.deepEqual(new Set(Object.values(newApiDefaultBindings)), new Set(["newapi.personal"]));
  assert.equal(
    newApiDefaultBindings["@hypit/mimo-speech@1#mimo-v2.5-tts-voiceclone"],
    "newapi.personal",
  );
});
```

- [ ] **Step 2: Run the setup test**

Run:

```bash
pnpm exec tsx --test packages/provider-newapi/test/setup.test.ts
```

Expected: PASS because `newApiDefaultBindings` derives directly from the ten routes. This protects future edits from silently dropping speech.

- [ ] **Step 3: Document the supported speech capability**

Add this row to the README capability table:

```md
| `@hypit/mimo-speech@1#mimo-v2.5-tts-voiceclone` | `index-tts-2` | 参考音频克隆配音 |
```

Change “上表九项能力” to “上表十项能力”. In the OSS section, state that `index-tts-2` always needs OSS because its required voice reference must be reachable by NewAPI. Add this request summary:

```md
`index-tts-2` 复用 Hypit 官方的 `<mimo:VoiceClone>` 作者接口。Provider 把朗读文字、唯一参考音频和可选演绎指令转换为 NewAPI `/audio/speech` 请求；返回音频会进入当前 Build 的 ResourceStore。它不提供无参考音频的预设音色或声音设计。
```

- [ ] **Step 4: Run all NewAPI and first-run regression tests**

Run:

```bash
pnpm exec tsx --test \
  packages/provider-newapi/test/*.test.ts \
  packages/video-cli/test/newapi-first-run.test.ts
pnpm check
git diff --check
```

Expected: every test and type check PASS; diff check prints no errors.

- [ ] **Step 5: Inspect the final diff for scope and secrets**

Run:

```bash
git diff --stat HEAD~2
git diff HEAD~2 -- packages/provider-newapi package.json pnpm-lock.yaml
git grep -nE 'sk-[A-Za-z0-9]{16,}|AccessKeySecret[[:space:]]*[:=][[:space:]]*[^<[:space:]]' -- packages/provider-newapi || true
```

Expected: only the planned Provider, tests, dependency metadata and documentation changed; the secret scan prints no credential values.

- [ ] **Step 6: Commit documentation and binding coverage**

```bash
git add packages/provider-newapi/test/setup.test.ts packages/provider-newapi/README.md
git commit -m "docs(newapi): explain IndexTTS2 voice cloning"
```
