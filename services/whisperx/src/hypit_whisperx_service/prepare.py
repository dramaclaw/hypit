from __future__ import annotations

import argparse
import os
from pathlib import Path

from .resources import prepare_punkt_tab, assert_sentence_data
from .config import ServiceConfig
from .models import prepare_models, alignment_selection
from dataclasses import replace


def main() -> None:
    config = ServiceConfig.from_environment()
    parser = argparse.ArgumentParser(description="Prepare the selected WhisperX models and sentence data")
    parser.add_argument(
        "--nltk-data",
        type=Path,
        # Preserve a user-selected symlink until prepare_punkt_tab can reject it.
        default=(
            Path(os.environ["HYPIT_WHISPERX_NLTK_DATA"])
            if os.environ.get("HYPIT_WHISPERX_NLTK_DATA")
            else config.nltk_data_root
        ),
        help="NLTK data root (defaults to the SVML user cache)",
    )
    arguments = parser.parse_args()
    nltk_data_root = arguments.nltk_data.expanduser()
    config = replace(config, nltk_data_root=nltk_data_root)
    for language in config.alignment_languages:
        if config.model.endswith(".en") and language != "en":
            raise ValueError(f"ASR model {config.model!r} is English-only; select a multilingual model to prepare {language}")
        alignment_selection(language)
    path = prepare_punkt_tab(nltk_data_root)
    for language in config.alignment_languages:
        assert_sentence_data(nltk_data_root, language)
    prepare_models(config)
    print(path)
