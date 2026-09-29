# FFmpeg / FFprobe notices and sources

Copyright (c) the FFmpeg developers and the authors of the libraries listed in
VERSIONS.txt. The unmodified Gyan 9.0.2 essentials executables are distributed
under GPL-3.0-or-later; the full license is in COPYING. They are invoked as separate
programs, not linked into the Hypit application. No warranty is provided.

- Exact release: https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2
- Original builder: https://www.gyan.dev/ffmpeg/builds/
- Exact FFmpeg source revision recorded by builder: https://github.com/FFmpeg/FFmpeg/commit/946fcce07b
- FFmpeg 9.0.2 source: https://ffmpeg.org/releases/ffmpeg-9.0.2.tar.xz
- Dependency versions and build configuration: VERSIONS.txt
- Builder source notes and dependency information: https://www.gyan.dev/ffmpeg/builds/#about-these-builds

The build includes GPL codecs (including x264 and x265), without nonfree options.
Both executable digests are pinned in media-lock.json and verified before staging
and again from the final installer.

When distributing these binaries beyond this internal test delivery, provide the
corresponding source for FFmpeg and all linked dependencies (including the build
recipes and modifications) alongside the installers in accordance with COPYING.
Preserve this notice, COPYING, and VERSIONS.txt. Upstream links are provenance,
not a replacement for the distributor's source-delivery obligations.
