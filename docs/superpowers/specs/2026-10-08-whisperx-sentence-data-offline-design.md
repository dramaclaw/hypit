# Offline WhisperX sentence data design

## Goal

A fresh desktop installation prepares Chinese and English WhisperX without contacting NLTK's data host or reading a previous local NLTK installation. Whisper model weights remain an explicit first-install download.

## Decision

The upstream `punkt_tab` training data does not declare a package license, so the desktop installer will not redistribute it. The Hypit WhisperX service will instead create its own minimal English Punkt parameter set using the Apache-licensed NLTK library. This is enough for the pinned WhisperX 3.8.6 interface, whose `zh` and `en` paths both request `tokenizers/punkt_tab/english`. Hypit's parameter set contains only manually selected common abbreviations; no upstream model parameters or corpus are copied.

## Behavior

During explicit preparation, `prepare_punkt_tab(root)` first accepts a complete existing selected dataset at that root. On an empty root it creates the four NLTK parameter files locally and verifies both selected languages using NLTK's own loader. It never calls `nltk.download`. The inference process stays read-only and requires a prepared local root. A partial or conflicting dataset fails without silently replacing unrelated files.

The generated data may split sentences differently from NLTK's pretrained English model. Acoustic word timing is still produced by the pinned WhisperX aligner; tests cover ordinary English punctuation, an abbreviation, Chinese text, and that no download occurs. No other language is promised by the desktop setup.

## Validation

Run the Python service tests with an empty temporary NLTK root, prove download is forbidden, build the wheel and inspect its code, and run desktop tests and packaging checks. The Python prepare-command test stops at the model-download boundary with `prepare_models` patched; a full fresh-machine model download and Windows launch require separate environment testing.
