/** Subtitle catalog selection, WebVTT parsing, and transcript rendering. */
import type {
  NormalizedYtTranscriptRequest,
  SelectedSubtitleTrack,
  SubtitleAvailability,
  SubtitleCatalog,
  SubtitleFetchSuccess,
  SubtitleSource,
  SubtitleTrack,
  TranscriptCleaningStats,
  TranscriptSegment,
  YtDlpMetadata,
} from "./contracts";

const TIMESTAMP_RE =
  /^(?<start>\d{2}:\d{2}(?::\d{2})?[.,]\d{3})\s+-->\s+(?<end>\d{2}:\d{2}(?::\d{2})?[.,]\d{3})(?:\s+.*)?$/u;
const MIN_OVERLAP_WORDS = 3;
const MIN_OVERLAP_CHARS = 18;
const READABLE_CHUNK_GAP_SECONDS = 4;
const READABLE_CHUNK_SOFT_CHARS = 550;
const READABLE_CHUNK_HARD_CHARS = 900;

export function buildSubtitleCatalog(metadata: YtDlpMetadata): SubtitleCatalog {
  return {
    manual: normalizeTrackMap(metadata.subtitles, "manual"),
    auto: normalizeTrackMap(metadata.automatic_captions, "auto"),
  };
}

export function buildSubtitleAvailability(
  metadata: YtDlpMetadata | undefined,
  requestedLanguages: string[]
): SubtitleAvailability {
  const catalog = metadata ? buildSubtitleCatalog(metadata) : emptyCatalog();
  return {
    requestedLanguages: [...requestedLanguages],
    availableManualLanguages: Object.keys(catalog.manual).sort(),
    availableAutoLanguages: Object.keys(catalog.auto).sort(),
  };
}

export function selectSubtitleTrack(
  metadata: YtDlpMetadata,
  request: NormalizedYtTranscriptRequest
): SelectedSubtitleTrack | undefined {
  const catalog = buildSubtitleCatalog(metadata);
  for (const source of sourceOrder(request.sourcePreference)) {
    for (const language of request.languages) {
      const track = choosePreferredTrack(catalog[source][language]);
      if (track) return { ...track, source };
    }
  }
  return undefined;
}

export function rawSubtitleFileName(fetch: SubtitleFetchSuccess): string {
  return safeArtifactName(
    `${fetch.selectedTrack.language}.${fetch.selectedTrack.source}.vtt`
  );
}

export function parseVtt(content: string): TranscriptSegment[] {
  const normalized = content.replace(/^\uFEFF/u, "").replace(/\r\n?/gu, "\n");
  const blocks = normalized.split(/\n{2,}/u);
  const segments: TranscriptSegment[] = [];

  for (const block of blocks) {
    const lines = block
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "");
    if (lines.length === 0) continue;
    if (lines[0] === "WEBVTT" || lines[0]?.startsWith("WEBVTT ")) continue;
    if (
      ["NOTE", "STYLE", "REGION"].some((prefix) => lines[0]?.startsWith(prefix))
    ) {
      continue;
    }

    const timestampIndex = lines.findIndex((line) => TIMESTAMP_RE.test(line));
    if (timestampIndex < 0) continue;

    const match = TIMESTAMP_RE.exec(lines[timestampIndex] ?? "");
    const startText = match?.groups?.start;
    const endText = match?.groups?.end;
    if (!startText || !endText) continue;

    const text = normalizeCueText(lines.slice(timestampIndex + 1).join("\n"));
    if (text === "") continue;

    const previous = segments.at(-1);
    const start = parseTimestamp(startText);
    const end = parseTimestamp(endText);
    if (
      previous &&
      previous.text === text &&
      Math.abs(previous.end - start) <= 0.05
    ) {
      previous.end = end;
      continue;
    }

    segments.push({
      index: segments.length + 1,
      start,
      end,
      text,
    });
  }

  return segments;
}

export interface CleanTranscriptOptions {
  subtitleSource?: SubtitleSource;
}

export interface CleanTranscriptResult {
  segments: TranscriptSegment[];
  stats: TranscriptCleaningStats;
}

export function cleanTranscriptSegments(
  segments: readonly TranscriptSegment[],
  options: CleanTranscriptOptions = {}
): CleanTranscriptResult {
  const stats: TranscriptCleaningStats = {
    rawSegmentCount: segments.length,
    cleanedSegmentCount: 0,
    exactDuplicateMerges: 0,
    progressiveDuplicateMerges: 0,
    overlapMerges: 0,
    readableChunkMerges: 0,
    heuristic: false,
    warnings: [],
  };

  const deduped: TranscriptSegment[] = [];
  for (const segment of segments) {
    const text = segment.text.trim();
    if (text === "") continue;

    const current = deduped.at(-1);
    if (current) {
      const merge = progressiveMerge(current.text, text);
      if (merge) {
        current.text = merge.text;
        current.end = Math.max(current.end, segment.end);
        if (merge.kind === "exact") stats.exactDuplicateMerges += 1;
        if (merge.kind === "progressive") {
          stats.progressiveDuplicateMerges += 1;
        }
        if (merge.kind === "overlap") stats.overlapMerges += 1;
        continue;
      }
    }

    deduped.push({
      index: deduped.length + 1,
      start: segment.start,
      end: segment.end,
      text,
    });
  }

  const cleaned = chunkReadableSegments(deduped, stats);
  stats.cleanedSegmentCount = cleaned.length;
  stats.heuristic =
    stats.exactDuplicateMerges > 0 ||
    stats.progressiveDuplicateMerges > 0 ||
    stats.overlapMerges > 0;

  if (options.subtitleSource === "auto") {
    stats.warnings.push(
      "Selected subtitles are auto-generated; wording and domain terms may be noisy."
    );
  }
  if (
    stats.progressiveDuplicateMerges > 0 ||
    stats.overlapMerges > 0 ||
    stats.exactDuplicateMerges > 0
  ) {
    stats.warnings.push(
      `Cleaned transcript merged ${stats.exactDuplicateMerges + stats.progressiveDuplicateMerges + stats.overlapMerges} duplicate or overlapping caption fragment(s) with heuristics.`
    );
  }

  return { segments: cleaned, stats };
}

export function renderTranscript(
  segments: readonly TranscriptSegment[],
  options: { includeTimestamps: boolean }
): string {
  return segments
    .map((segment) =>
      options.includeTimestamps
        ? `[${formatTimestamp(segment.start)}] ${segment.text}`
        : segment.text
    )
    .join("\n");
}

export function formatTimestamp(seconds: number): string {
  const wholeSeconds = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const secs = wholeSeconds % 60;
  return [hours, minutes, secs]
    .map((part) => String(part).padStart(2, "0"))
    .join(":");
}

function progressiveMerge(
  currentText: string,
  nextText: string
): { kind: "exact" | "progressive" | "overlap"; text: string } | undefined {
  const currentWords = tokenSpans(currentText).map((span) => span.compare);
  const nextWords = tokenSpans(nextText).map((span) => span.compare);
  if (currentWords.length === 0 || nextWords.length === 0) return undefined;

  if (arraysEqual(currentWords, nextWords)) {
    return { kind: "exact", text: currentText };
  }
  if (isTokenPrefix(currentWords, nextWords)) {
    return { kind: "progressive", text: nextText };
  }
  if (isTokenPrefix(nextWords, currentWords)) {
    return { kind: "progressive", text: currentText };
  }

  const overlap = wordOverlap(currentText, nextText);
  if (
    overlap.words >= MIN_OVERLAP_WORDS ||
    (overlap.words >= 2 && overlap.characters >= MIN_OVERLAP_CHARS)
  ) {
    return {
      kind: "overlap",
      text: appendNonOverlappingText(currentText, nextText, overlap.words),
    };
  }

  return undefined;
}

function chunkReadableSegments(
  segments: readonly TranscriptSegment[],
  stats: TranscriptCleaningStats
): TranscriptSegment[] {
  const chunks: TranscriptSegment[] = [];
  for (const segment of segments) {
    const current = chunks.at(-1);
    if (!current) {
      chunks.push({ ...segment, index: 1 });
      continue;
    }

    const gap = Math.max(0, segment.start - current.end);
    const joinedText = joinTranscriptText(current.text, segment.text);
    const canMerge =
      gap <= READABLE_CHUNK_GAP_SECONDS &&
      joinedText.length <= READABLE_CHUNK_HARD_CHARS &&
      (current.text.length < READABLE_CHUNK_SOFT_CHARS ||
        !endsWithSentenceBoundary(current.text));

    if (canMerge) {
      current.text = joinedText;
      current.end = Math.max(current.end, segment.end);
      stats.readableChunkMerges += 1;
      continue;
    }

    chunks.push({ ...segment, index: chunks.length + 1 });
  }
  return chunks.map((segment, index) => ({ ...segment, index: index + 1 }));
}

function comparableText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[“”]/gu, '"')
    .replace(/[‘’]/gu, "'")
    .replace(/[^\p{L}\p{N}'’]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

function wordOverlap(
  currentText: string,
  nextText: string
): { words: number; characters: number } {
  const currentWords = tokenSpans(currentText).map((span) => span.compare);
  const nextSpans = tokenSpans(nextText);
  const nextWords = nextSpans.map((span) => span.compare);
  const max = Math.min(currentWords.length, nextWords.length);
  for (let length = max; length >= 1; length -= 1) {
    const currentSlice = currentWords.slice(currentWords.length - length);
    const nextSlice = nextWords.slice(0, length);
    if (arraysEqual(currentSlice, nextSlice)) {
      const characters = nextSpans[length - 1]
        ? nextSpans[length - 1].end - nextSpans[0]?.start
        : 0;
      return { words: length, characters };
    }
  }
  return { words: 0, characters: 0 };
}

function appendNonOverlappingText(
  currentText: string,
  nextText: string,
  overlapWords: number
): string {
  const spans = tokenSpans(nextText);
  const firstNewToken = spans[overlapWords];
  if (!firstNewToken) return currentText;
  return joinTranscriptText(currentText, nextText.slice(firstNewToken.start));
}

function tokenSpans(
  text: string
): Array<{ compare: string; start: number; end: number }> {
  return [...text.matchAll(/[\p{L}\p{N}][\p{L}\p{N}'’.-]*/gu)].map((match) => ({
    compare: comparableText(match[0] ?? ""),
    start: match.index ?? 0,
    end: (match.index ?? 0) + (match[0]?.length ?? 0),
  }));
}

function joinTranscriptText(left: string, right: string): string {
  const trimmedRight = right.trim();
  if (trimmedRight === "") return left.trim();
  const trimmedLeft = left.trim();
  if (trimmedLeft === "") return trimmedRight;
  return `${trimmedLeft} ${trimmedRight}`.replace(/\s+/gu, " ").trim();
}

function endsWithSentenceBoundary(text: string): boolean {
  return /[.!?]["')\]]?$/u.test(text.trim());
}

function arraysEqual(
  left: readonly string[],
  right: readonly string[]
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function isTokenPrefix(
  candidatePrefix: readonly string[],
  fullText: readonly string[]
): boolean {
  return (
    candidatePrefix.length < fullText.length &&
    candidatePrefix.every((value, index) => value === fullText[index])
  );
}

function normalizeTrackMap(
  tracksByLanguage: Record<string, Array<Record<string, unknown>>> | undefined,
  source: SubtitleSource
): Record<string, SubtitleTrack[]> {
  const output: Record<string, SubtitleTrack[]> = {};
  for (const [language, tracks] of Object.entries(tracksByLanguage ?? {})) {
    const normalizedTracks = tracks
      .map(
        (track): SubtitleTrack => ({
          language,
          source,
          ext: typeof track.ext === "string" ? track.ext : undefined,
          name: typeof track.name === "string" ? track.name : undefined,
          url: typeof track.url === "string" ? track.url : undefined,
        })
      )
      .filter((track) => track.url || track.ext);
    if (normalizedTracks.length > 0) output[language] = normalizedTracks;
  }
  return output;
}

function choosePreferredTrack(
  tracks: SubtitleTrack[] | undefined
): SubtitleTrack | undefined {
  if (!tracks || tracks.length === 0) return undefined;
  return (
    tracks.find((track) => track.ext === "vtt") ??
    tracks.find((track) => track.ext === "webvtt") ??
    tracks[0]
  );
}

function sourceOrder(
  preference: NormalizedYtTranscriptRequest["sourcePreference"]
): SubtitleSource[] {
  if (preference === "manual_only") return ["manual"];
  if (preference === "auto_only") return ["auto"];
  return ["manual", "auto"];
}

function emptyCatalog(): SubtitleCatalog {
  return { manual: {}, auto: {} };
}

function parseTimestamp(text: string): number {
  const parts = text.replace(",", ".").split(":");
  const secondsText = parts.at(-1) ?? "0";
  const minutesText = parts.at(-2) ?? "0";
  const hoursText = parts.length > 2 ? (parts.at(-3) ?? "0") : "0";
  return (
    Number(hoursText) * 3600 + Number(minutesText) * 60 + Number(secondsText)
  );
}

function normalizeCueText(text: string): string {
  return decodeHtmlEntities(
    text
      .replace(
        /<\/?(?:c|v|i|b|u|ruby|rt|lang)(?:\.[^>]+)?(?:\s+[^>]*)?>/giu,
        ""
      )
      .replace(/<[^>]+>/gu, "")
      .replace(/\{\\[^}]+\}/gu, "")
      .replace(/[ \t]*\n[ \t]*/gu, " ")
      .replace(/\s+/gu, " ")
      .trim()
  );
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;|&apos;/gu, "'");
}

function safeArtifactName(name: string): string {
  return name.replace(/[^a-z0-9._-]+/giu, "_");
}
