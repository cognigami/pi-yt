# pi-yt

`pi-yt` is a Pi extension package that exposes a narrow transcript workflow for video URLs.

## MVP scope

The package registers one tool:

- `yt_transcript` (`yt-transcript`): fetch subtitles with `yt-dlp`, normalize them into readable transcript artifacts, and return a compact preview.

The MVP is intentionally limited to transcript/subtitle extraction. It does not expose raw `yt-dlp` arguments, download media, crawl playlists, use browser cookies, access private/authenticated videos, or extract screenshots/frames.

## Requirements

- Pi runtime packages.
- `yt-dlp` installed on `PATH`.

If `yt-dlp` is unavailable, `yt_transcript` fails with an actionable error instead of attempting a fallback download.

## Tool inputs

```text
url: string                         # required http:// or https:// URL
languages?: string[]                # default: ["en"]
sourcePreference?:                  # default: "manual_then_auto"
  "manual_then_auto" | "manual_only" | "auto_only"
includeTimestamps?: boolean         # default: true
timeoutSec?: number                 # default: 30, range 1..600
```

One tool call processes one video resource. Playlist traversal is disabled.

## Results and artifacts

Successful calls return a truncation-aware cleaned preview plus staged artifact paths:

- raw subtitle file — original subtitle data returned by `yt-dlp`, unchanged.
- `transcript.txt` — raw parsed transcript text, preserving original segment/timestamp data.
- `transcript.json` — raw structured transcript segments with start/end seconds.
- `transcript.clean.txt` — cleaned/deduped transcript text for LLM reading.
- `transcript.clean.json` — cleaned/deduped structured transcript chunks with cleaning stats.
- `metadata.json` — title, URL, video id, channel/uploader, upload date, duration, selected language/source, availability, and transcript quality warnings when detectable.

When the preview is truncated, read `transcript.clean.txt` through Pi's `read` tool for the full cleaned transcript, or `transcript.txt` when you need original caption timing/fragments.

If requested subtitles are unavailable, the result reports requested languages plus available manual and auto subtitle languages when `yt-dlp` provides them.

## Installation

This repository currently supports the managed local install path:

```bash
just install
```

That recipe builds the extension and installs both its bundle and the shared `pi-extension-kit` runtime. Do not use a generic npm/Bun global install or publish this package as-is: `pi-extension-kit` is a local, unpublished dependency that remains external in the bundle.

## Development

The package follows the local `pi-extension-kit` extension scaffold and references it via `file:../pi-extension-kit` in `package.json`.

Preferred validation:

```text
build
test
lint
```

Package-level recipes are also available once dependencies are synced:

```bash
just build
just test
just lint
just compile
```

Unit tests are fixture/mocking based and do not require network access.
