# Offline WhisperX Sentence Data Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prepare `punkt_tab/english` on a fresh desktop machine without NLTK network access or a prior user cache.

**Architecture:** The WhisperX service writes a Hypit-owned minimal Punkt parameter set through NLTK's serializer into its selected Program Home. The existing runtime and desktop installer package the service source and need no separate data downloader.

**Tech Stack:** Python 3.10–3.13, NLTK 3.10.3, WhisperX 3.8.6, Node desktop packaging.

## Global Constraints

- Do not copy upstream `punkt_tab` data with unclear redistributable license.
- Keep the existing local-data-only inference check.
- Only `zh` and `en` are selected by the desktop installer.
- Keep model downloads behind the explicit installation action.

---

### Task 1: Local sentence data preparation

**Files:**
- Modify: `services/whisperx/tests/test_service.py`
- Modify: `services/whisperx/src/hypit_whisperx_service/resources.py`
- Modify: `services/whisperx/src/hypit_whisperx_service/prepare.py`

**Interfaces:**
- Consumes: `prepare_punkt_tab(root: Path) -> Path`.
- Produces: NLTK-loadable `root/tokenizers/punkt_tab/english` without invoking `nltk.download`.

- [x] Add a test that patches `nltk.download` to raise, calls `prepare_punkt_tab` on an empty temporary root, and loads `zh` and `en` sentence data.
- [x] Run the focused Python suite; verify the new test fails because the current implementation downloads.
- [x] Implement local Punkt parameter serialization and remove the download retry from `prepare.py`. Refuse incomplete existing directories and selected root symlinks.
- [x] Rerun the focused Python tests and verify all pass.

### Task 2: Documentation and end-to-end checks

**Files:**
- Modify: `services/whisperx/README.md`
- Modify: `docs/zh/guide/desktop-installer.md`
- Test: `services/whisperx/tests/test_service.py`
- Test: `packages/desktop-setup/test/builder-config.test.ts`

**Interfaces:**
- Consumes: the service's unchanged `hypit-whisperx-prepare` CLI.
- Produces: a clean-root preparation command test that reaches model preparation without NLTK DNS lookup, plus a packaged file inventory check.

- [x] Add a Python prepare-command test that reaches model preparation under an empty data root with NLTK download blocked. The Node distribution CLI test intentionally stops at the uv boundary because its cross-platform runner does not install Python/WhisperX.
- [x] Verify the old download retry fails when other selected language data is missing, then remove it.
- [x] Make final app inspection require the changed `prepare.py` and `resources.py` files.
- [x] Update the user docs to explain offline sentence data and first-use model downloads.
- [x] Run final Python service tests, desktop focused tests, `pnpm check`, and macOS/Windows package inspection. Report the absence of a real Windows launch and fresh model download accurately.
