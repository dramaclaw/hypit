from __future__ import annotations

from pathlib import Path
from tempfile import TemporaryDirectory


class UnpreparedResourceError(RuntimeError):
    """A selected local execution resource needs explicit preparation."""


def default_nltk_data_root() -> Path:
    return Path.home() / ".cache" / "hypit" / "whisperx" / "nltk_data"


def assert_punkt_tab(root: Path) -> None:
    import nltk

    location = str(root.expanduser().resolve())
    nltk.data.path[:] = [location]
    try:
        nltk.data.find("tokenizers/punkt_tab", paths=[location])
    except LookupError as error:
        raise UnpreparedResourceError(
            "NLTK punkt_tab data is unavailable; run `hypit-whisperx-prepare`"
        ) from error


def prepare_punkt_tab(root: Path) -> Path:
    root = root.expanduser()
    if root.is_symlink():
        raise UnpreparedResourceError("NLTK sentence data path contains a symlink")
    root = root.resolve()
    target = root / "tokenizers" / "punkt_tab"
    english = target / "english"
    if (root / "tokenizers").is_symlink() or target.is_symlink() or english.is_symlink():
        raise UnpreparedResourceError("NLTK sentence data path contains a symlink")
    try:
        assert_sentence_data(root, "en")
        return target
    except UnpreparedResourceError:
        pass
    if english.exists() or english.is_symlink():
        raise UnpreparedResourceError("NLTK sentence data is incomplete; inspect the selected data directory before retrying")
    target.mkdir(parents=True, exist_ok=True)
    from nltk.tokenize.punkt import PunktParameters, save_punkt_params

    # These parameters are authored by Hypit. No NLTK pretrained corpus or model is redistributed.
    parameters = PunktParameters()
    parameters.abbrev_types.update({"dr", "mr", "mrs", "ms", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e"})
    with TemporaryDirectory(prefix=".hypit-punkt-", dir=target) as temporary:
        staged = Path(temporary) / "english"
        save_punkt_params(parameters, dir=str(staged))
        staged.rename(english)
    assert_sentence_data(root, "en")
    return target


def assert_sentence_data(root: Path, language: str) -> None:
    from whisperx.utils import PUNKT_LANGUAGES
    from nltk.tokenize.punkt import load_punkt_params
    from nltk.data import FileSystemPathPointer
    # Use the same sentence tokenizer selection as the pinned WhisperX version.
    name = PUNKT_LANGUAGES.get(language, "english")
    try:
        assert_punkt_tab(root)
        load_punkt_params(FileSystemPathPointer(str(root / "tokenizers" / "punkt_tab" / name)))
    except (OSError, ValueError) as error:
        raise UnpreparedResourceError(f"NLTK sentence data for {language} ({name}) is unavailable; run hypit-whisperx-prepare") from error
