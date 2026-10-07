# pi-yt Phase 1 Design

## Context

`pi-yt` is a proposed Pi extension package for retrieving video transcript artifacts through `yt-dlp`. The initial use case is to let the LLM fetch readable transcripts from video URLs without exposing a broad shell or arbitrary `yt-dlp` command surface.

This document captures the accepted Phase 1 design boundary for handoff into Phase 2 planning.

## Decision

Create a Pi extension package named `pi-yt` that registers narrow, purpose-built custom tools.

The MVP should expose one initial tool:

```text
tool name:     yt_transcript
display label: yt-transcript
purpose:       fetch and stage subtitle/transcript artifacts for a video URL
```

Do not expose a generic `yt-dlp` passthrough tool for arbitrary CLI arguments. The tool should own a constrained transcript workflow with fixed safe command arguments and artifact staging.

## System Boundary

`pi-yt` owns:

- Validating model-provided video URLs.
- Calling `yt-dlp` with fixed, safe subtitle/transcript arguments.
- Fetching manual subtitles and/or auto-generated subtitles.
- Selecting an appropriate transcript language and source.
- Normalizing subtitle output into LLM-friendly transcript text.
- Staging full artifacts for follow-up reads.
- Returning a compact preview, metadata, warnings, and artifact paths.

`pi-yt` does not initially own:

- General video or audio downloading.
- Audio transcription when subtitles are unavailable.
- Authenticated/private videos.
- Browser cookie/session handling.
- Screenshot or frame extraction.
- Playlist crawling or bulk downloads.
- Paywall or access-control bypass.
- Model-controlled raw shell or raw `yt-dlp` arguments.

## Primary Tool Contract

### `yt_transcript`

Suggested inputs:

```text
url: string
languages?: string[]
sourcePreference?: "manual_then_auto" | "manual_only" | "auto_only"
includeTimestamps?: boolean
timeoutSec?: number
```

Recommended defaults:

```text
languages = ["en"]
sourcePreference = "manual_then_auto"
includeTimestamps = true
```

Suggested outputs/details:

```text
title
originalUrl
webpageUrl
videoId
duration
selectedLanguage
subtitleSource: "manual" | "auto"
segmentCount
previewText
artifacts:
  transcriptTextPath
  transcriptJsonPath
  rawSubtitlePath
  metadataJsonPath
warnings
```

The LLM-facing result should be concise and truncation-aware. It should include a preview of the transcript plus full staged artifact paths that can be read later.

## Artifact Model

For a successful transcript extraction, stage at least:

- `transcript.txt` or `transcript.md`: human-readable transcript, preferably timestamped by default.
- `transcript.json`: structured segments with timestamps and text.
- Raw subtitle file, such as `.vtt`, when available.
- `metadata.json`: relevant `yt-dlp` metadata and selected subtitle information.

Use `pi-extension-kit` artifact/file helpers where practical so output paths and cleanup behavior are consistent with the existing extension ecosystem.

## Error and Fallback Behavior

### Gemini fallback amendment

`yt-dlp` remains the primary and authoritative subtitle source. A configured Gemini API key opts into one narrow degraded fallback: when YouTube returns HTTP 429 while `yt-dlp` downloads a selected automatic-caption track, `pi-yt` may pass the canonical public YouTube URL to Gemini and request a complete transcript.

This fallback is intentionally independent of `pi-web-access` and does not download or upload an audio track. It must:

- Prefer original-language automatic-caption aliases such as `en-orig` and skip tracks whose timed-text URL carries `tlang`; translated YouTube tracks are outside the supported selection policy.
- Run only for a classified YouTube automatic-subtitle 429 on an otherwise eligible original track, not for missing binaries or unrelated errors.
- Report the result as `generated`, not as a manual or automatic subtitle source.
- Preserve the original yt-dlp failure and Gemini provider/model in metadata.
- Warn that wording, completeness, and timestamps may differ from the source.
- Stage the raw generated response without fabricating VTT or structured subtitle segments.
- Remain disabled unless `GEMINI_API_KEY` is present in Pi's environment.

This trades exact subtitle provenance for availability while avoiding the shared failure path, media download, conversion, and upload costs of an audio-ASR fallback.

If no requested-language transcript is available, the tool should return a clear non-success result with enough metadata to support a next step, such as:

- Requested languages.
- Available manual subtitle languages.
- Available auto-subtitle languages.
- Whether the URL was unsupported or inaccessible.
- Whether `yt-dlp` itself is unavailable.

The tool should not silently download media or attempt unrelated fallbacks.

## Future Expansion

### `yt_frame`

Screenshots/frame extraction should be a separate future tool rather than an option on `yt_transcript`.

Potential contract:

```text
tool name: yt_frame
inputs:
  url: string
  timestamp: string
  format?: "png" | "jpg"
```

This likely requires `ffmpeg`: `yt-dlp` can resolve or retrieve media, while `ffmpeg` extracts a frame. Keep this tool separate because it has different bandwidth, storage, runtime, and safety implications.

### `yt_metadata`

A future metadata-only tool may be useful for title, channel, duration, chapters, description, thumbnail, and available subtitle languages without fetching transcript content.

## Key Trade-offs

| Option | Pros | Cons | Decision |
|---|---|---|---|
| Generic `yt-dlp` wrapper | Flexible; easy to implement | Unsafe broad CLI surface; easy to download media accidentally; harder for LLM to use correctly | Reject for MVP |
| Focused `yt_transcript` tool | Safer; clear model affordance; artifact-oriented | Less flexible; requires subtitle parsing/normalization | Accept |
| Include screenshots in MVP | Supports richer video understanding | Requires ffmpeg/media handling; broader policy surface | Defer |
| Separate future `yt_frame` tool | Clean boundary; different safety model | More tools to maintain | Prefer when needed |

## Acceptance Criteria for Phase 2 Planning

Phase 2 planning can proceed once the team accepts:

- Package name: `pi-yt`.
- MVP tool name: `yt_transcript` with label `yt-transcript`.
- MVP scope: transcript/subtitle extraction only.
- No raw arbitrary `yt-dlp` argument passthrough.
- Screenshot/frame extraction is deferred to a separate future tool.
- Full transcript output is staged as artifacts, with only a compact preview returned directly to the LLM.

## Open Questions

1. Should the MVP restrict URLs to YouTube, or allow all `yt-dlp` supported extractors?
2. Should auto-generated subtitles be enabled by default after manual subtitles? The recommended default is yes.
3. Should English be the only default language, or should the tool accept a broader fallback list?
4. Should transcript text be timestamped by default? The recommended default is yes.
5. Should cookie/browser-auth support be explicitly out of scope for the first release? The recommended default is yes.
