# FK-PIT-0085: Separate media format from audio track metadata

## Area

Local subtitle / media metadata display.

## Triggers

MP4, WAV, MKV, `und`, AAC, container format, audio track language, codec,
ffprobe metadata.

## Symptoms

An MP4 draft row displays `und · AAC` where users expect to see `MP4`. Audio
files may appear more plausible by accident, making video input look unsupported
even though probing and transcription work correctly.

## Root cause

The draft summary renders only audio stream metadata. ffprobe uses `und` when a
stream has no language tag, while `AAC` is the audio codec; neither value is the
media container or filename format. Presenting them without a separate format
label makes the language sentinel look like a failed format probe.

## Do

- Derive a user-facing file format label from the already authorized display
  filename when the label is informational only.
- Keep audio codec, channel count, and sample rate as stream metadata.
- Suppress the standard `und` language sentinel while preserving meaningful
  language tags.
- Suppress a codec label when it duplicates the filename format, such as
  `MP3 · MP3`.
- Apply the same language normalization to both single-track summaries and
  multi-track selectors.

## Avoid

- Do not label `codec_name` as the file or video format.
- Do not expose `und` as useful language information.
- Do not expand the trusted IPC contract with a container field when the UI only
  needs a filename-format hint and already holds the verified display name.
- Do not hide a meaningful language tag such as `ja` or `eng`.

## Validation

- MP4 plus one unlabelled AAC track displays `MP4 · AAC`, never `und · AAC`.
- WAV displays `WAV` before its audio codec details.
- MP3, FLAC, and AAC summaries do not repeat identical format and codec labels.
- Meaningful track language tags remain visible.
- Extensionless or malformed display names do not produce a guessed format.
- Run the local subtitle model and page wiring tests plus TypeScript validation.

## Related files

- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/LocalSubtitleDraftMediaList.tsx`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.ts`
- `src/pages/Tools/Subtitle/LocalSubtitleTranscriber/localSubtitleTranscriberModel.test.ts`
