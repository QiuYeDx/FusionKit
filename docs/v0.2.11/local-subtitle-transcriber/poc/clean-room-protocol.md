# Local Subtitle Independent-Implementation Rule

FusionKit does not reproduce FasterWhisperGUI and does not depend on its local
application snapshot, configuration or CTranslate2 model. The user-provided
SRT/LRC files are ordinary sample subtitle artifacts only.

Implementation may use FusionKit's design documents and public upstream APIs or
documentation for whisper.cpp, GGML model artifacts, Silero VAD, FFmpeg and
CUDA. Do not copy third-party GUI source code, tests, configuration files,
credentials or private paths into FusionKit.

This rule is a normal source-provenance safeguard, not a PRE-001 evidence gate.
