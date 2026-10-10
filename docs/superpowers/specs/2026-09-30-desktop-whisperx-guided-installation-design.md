# Desktop WhisperX Guided Installation Design

Date: 2026-09-30

## Goal

Add an optional, guided local WhisperX installation to Hypit Setup so a non-technical macOS or Windows user can prepare word-level transcription and alignment without installing Homebrew, Winget, Python, or `uv` manually.

The feature must not make WhisperX a prerequisite for the existing NewAPI and OSS setup. Users who do not need transcription or alignment can continue without downloading Python dependencies or model weights. A later NewAPI alignment implementation must be able to replace the local execution binding without changing authored video projects.

## Product Decisions

- Hypit Setup bundles a pinned `uv` executable for macOS arm64 and Windows x64.
- The bundled `uv` is verified at build time and runtime by platform, architecture, version, SHA-256, and accompanying license material.
- Local WhisperX remains optional. Installation begins only after an explicit user action.
- The default local deployment is `small`, `cpu`, `int8`, with Chinese (`zh`) and English (`en`) alignment resources.
- Python, packages, WhisperX models, language alignment resources, and logs live in Hypit's machine-level Program Home, not in a video project or the system Python environment.
- The initial setup does not silently install, start, or charge for a speech service.
- Local WhisperX uses the existing capability `@hypit/whisperx@1#whisperx-alignment` and produces the existing provider-neutral `AlignedTranscriptEvidence` result.
- A future NewAPI alignment adapter changes only the capability binding to `newapi.personal`; projects, Sources, Runs, captions, and semantic timing remain unchanged.

## Architecture

### Bundled `uv`

The desktop resource pipeline gains one locked `uv` binary per supported target. Its lock data follows the existing media-resource pattern and records:

- upstream version;
- target platform and architecture;
- archive and executable hashes where applicable;
- executable filename and packaged destination;
- license and source attribution.

Resource preparation rejects path traversal, case collisions, unexpected members, checksum mismatches, wrong executable architecture, or missing license material. Artifact inspection verifies the final DMG and unpacked NSIS application contain the exact locked executable. Runtime code resolves only the bundled path and never falls back to an arbitrary system `uv`.

### Managed Program

The existing `@hypit/provider-whisperx-local` Managed Program remains responsible for the Python environment, frozen Python dependencies, models, language resources, service process, health probe, logs, and reuse across projects.

Hypit Setup invokes a narrow desktop service around the existing Program lifecycle rather than duplicating WhisperX installation logic. The service exposes operations equivalent to:

- inspect current Program status;
- prepare Python, dependencies, ASR model, and alignment resources;
- start and await service readiness;
- stop the owned service;
- return bounded progress and sanitized failure information.

The desktop invocation supplies the bundled `uv` explicitly to the Managed Program environment. It does not modify the user's shell profile or global `PATH`.

### Runtime Profile

The managed local configuration is:

```json
{
  "endpoints": {
    "whisperx.local": {
      "use": "@hypit/provider-whisperx-local",
      "config": {
        "expectedModel": "small",
        "expectedDevice": "cpu",
        "expectedCompute": "int8",
        "alignmentLanguages": ["zh", "en"]
      }
    }
  },
  "bindings": {
    "@hypit/whisperx@1#whisperx-alignment": "whisperx.local"
  }
}
```

Resource preparation and the health check complete before the Profile is changed. The Profile update is an ownership-aware atomic transaction that modifies only `whisperx.local` and the alignment binding. It preserves every unrelated Endpoint, binding, credential reference, custom setting, and byte-level user edit it does not own. A conflicting user-owned `whisperx.local` entry or alignment binding stops the operation with recovery guidance rather than being overwritten.

If the Profile publication fails, the original Profile remains intact. If the Program becomes ready but Profile publication fails, the prepared local resources remain reusable for a retry.

## User Experience

### Entry points

The optional card appears:

1. after successful NewAPI and OSS setup; and
2. whenever Hypit Setup is reopened.

The card title is `本地语音识别与字幕对齐（可选）`. It explains that the feature downloads local dependencies and model resources, runs without NewAPI model charges, and is needed for reference transcription, word-timed captions, and semantic alignment.

The first action is `安装并启动`. Subsequent actions are selected from:

- `重试安装`;
- `启动服务`;
- `停止服务`;
- `检查状态`.

### Visible states

The UI distinguishes:

- not installed;
- preparing Python;
- downloading or installing dependencies;
- preparing the speech-recognition model;
- preparing Chinese alignment resources;
- preparing English alignment resources;
- starting the service;
- ready;
- stopped but prepared;
- failed with a retryable stage and log location.

Before installation begins, the card presents the selected model, device, compute mode, languages, the fact that downloads can be large and slow, and a conservative size/time range derived from packaged guidance rather than an exact promise.

Closing the window does not classify a still-running preparation process as failed. Reopening the application reads the real Managed Program state. Completed caches and downloads are retained and reused.

### Progress and diagnostics

The renderer receives allowlisted progress stages and public Program status. It never receives commands, complete environment variables, credentials, cache tokens, arbitrary process output, or log contents. Failure output identifies the stage and a log file path. Full logs remain local.

All Program mutations use the existing serialized desktop controller queue. Repeated clicks and competing setup, rescan, clear, uninstall, or WhisperX operations cannot race one another.

## Failure and Recovery Semantics

- A bundled `uv` integrity, version, or architecture failure blocks local preparation. No system fallback is attempted.
- Dependency or model download failures retain valid cache entries and permit an explicit retry.
- A missing language resource reports the language and preparation step. Inference does not download it implicitly.
- A live process that is not ready is reported separately from a stopped process. The user can stop and retry it.
- Disk-full, permission, cancellation, process-exit, timeout, and network failures are normalized to fixed public codes and sanitized messages.
- Unknown or user-owned Profile content is never deleted or overwritten.
- Transaction cleanup failures preserve recovery artifacts and remain discoverable after application restart.
- The operation never reads, tests, changes, or rewrites NewAPI or OSS credentials.

## Future NewAPI Alignment

The future NewAPI Provider implementation must fulfill the existing alignment capability rather than introduce a desktop-only workflow. It must accept canonical 16 kHz mono speech evidence plus an explicit language and return passages containing word- or character-level start and end times in `AlignedTranscriptEvidence`.

Sentence-only timestamps or plain transcript text are insufficient for replacing WhisperX because Hypit uses measured word timing for Script alignment, semantic Takes, and word-timed captions.

When the NewAPI adapter is available, the setup UI may offer `NewAPI 云端` and `本地 WhisperX` choices. Switching changes only the alignment binding. It does not delete the local environment or model cache. Switching back requires a readiness check of the existing local Program.

## Removal

Application removal treats the potentially large local Program separately from the application bundle:

- the default is to retain the Python environment and model cache for a later reinstall;
- an explicit `同时删除本地语音资源` choice removes only resources proven to belong to the managed WhisperX Program;
- modified, unknown, shared, or ownership-ambiguous content is preserved with recovery guidance;
- the existing uninstall transaction and cleanup-warning rules remain in force.

The initial implementation may expose the resource-removal choice in Hypit Setup before launching the platform uninstaller when the native uninstaller cannot provide a safe interactive choice on both platforms.

## Security and Privacy

- No shell script fetched from the network is executed to install `uv`.
- Every bundled executable and archive is locked and inspected.
- The local service listens only on loopback and uses the existing expected-identity health checks.
- IPC accepts fixed operation names and no credential-bearing payload for WhisperX actions.
- Progress, errors, and status pass through the hostile-object-safe public projection.
- Paths are canonicalized and bounded to approved machine state and bundled resource roots.
- Logs and environment values are not rendered as HTML and are not returned wholesale over IPC.

## Testing and Acceptance

### Unit and integration tests

- locked `uv` resource and license validation for both targets;
- final resource manifest and architecture checks;
- Program status mapping and progress-stage allowlists;
- serialized installation, repeated clicks, cancellation, retry, stop, and restart;
- partial dependency/model/language preparation recovery;
- Profile ownership conflicts, concurrent edits, atomic publication, rollback, and cleanup-warning persistence;
- renderer state and secret-free IPC projection under hostile values;
- uninstall retention and explicit managed-resource removal;
- future binding switch behavior without local deletion.

### Platform acceptance

macOS arm64 acceptance must install and start the managed service and transcribe fixed short Chinese and English samples with word-level timestamps. The DMG must mount and pass packaged-resource inspection.

Windows x64 continues to receive cross-build, extraction, architecture, and static-resource validation on macOS. Release readiness still requires a native Windows machine to exercise installation, preparation, process control, retry, transcription, retention, and uninstall. The cross-built result must not be described as native Windows acceptance.

### Release limitations

The installers remain internal unsigned builds until signing and notarization are supplied. Real network routes and first-time model downloads vary by environment. Acceptance records must distinguish cached preparation from a fresh download and must not use paid generation credentials.
