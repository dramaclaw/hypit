# FFmpeg / FFprobe notices and sources

Copyright (c) the FFmpeg developers and the authors of the libraries listed in
VERSIONS.txt. These standalone executables are redistributed without modification
under GPL-3.0-or-later; the full license is in COPYING. They are invoked as separate
programs, not linked into the Hypit application. No warranty is provided.

- Exact binary release: https://ffmpeg.martin-riedl.de/info/detail/macos/arm64/1789931890_9.0.2
- FFmpeg 9.0.2 source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
- Build scripts and dependency source recipes: https://git.martin-riedl.de/ffmpeg/build-script
- Build configuration and dependency versions: VERSIONS.txt and https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/versions.txt

The configuration enables GPL components (including x264 and x265), but does not
enable nonfree components. The release archives and extracted binaries are pinned
by SHA-256 in media-lock.json. Modified or nonfree binaries fail the packaging gate.

When distributing these binaries beyond this internal test delivery, provide the
corresponding source for FFmpeg and all linked dependencies (including the build
recipes and modifications) alongside the installers in accordance with COPYING.
Preserve this notice, COPYING, and VERSIONS.txt. Upstream links are provenance,
not a replacement for the distributor's source-delivery obligations.
