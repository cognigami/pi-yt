/** Shared contracts and validation for the pi-yt transcript MVP. */

export const DEFAULT_LANGUAGES = ["en"] as const;
export const DEFAULT_SOURCE_PREFERENCE = "manual_then_auto" as const;
export const DEFAULT_INCLUDE_TIMESTAMPS = true;
export const DEFAULT_TIMEOUT_SEC = 30;
export const MAX_TIMEOUT_SEC = 600;
export const MIN_TIMEOUT_SEC = 1;

export type SubtitleSource = "manual" | "auto";
export type SubtitleSourcePreference =
  | "manual_then_auto"
  | "manual_only"
  | "auto_only";

export interface YtTranscriptParams {
  url: string;
  languages?: string[];
  sourcePreference?: SubtitleSourcePreference;
  includeTimestamps?: boolean;
  timeoutSec?: number;
}

export interface NormalizedYtTranscriptRequest {
  url: string;
  languages: string[];
  sourcePreference: SubtitleSourcePreference;
  includeTimestamps: boolean;
  timeoutSec: number;
}

export interface SubtitleTrack {
  language: string;
  source: SubtitleSource;
  ext?: string;
  name?: string;
  url?: string;
}

export interface SubtitleCatalog {
  manual: Record<string, SubtitleTrack[]>;
  auto: Record<string, SubtitleTrack[]>;
}

export interface SelectedSubtitleTrack extends SubtitleTrack {
  source: SubtitleSource;
}

export interface TranscriptSegment {
  index: number;
  start: number;
  end: number;
  text: string;
}

export interface TranscriptCleaningStats {
  rawSegmentCount: number;
  cleanedSegmentCount: number;
  exactDuplicateMerges: number;
  progressiveDuplicateMerges: number;
  overlapMerges: number;
  readableChunkMerges: number;
  heuristic: boolean;
  warnings: string[];
}

export interface YtDlpMetadata {
  id?: string;
  title?: string;
  original_url?: string;
  webpage_url?: string;
  channel?: string;
  uploader?: string;
  upload_date?: string;
  duration?: number;
  subtitles?: Record<string, Array<Record<string, unknown>>>;
  automatic_captions?: Record<string, Array<Record<string, unknown>>>;
  [key: string]: unknown;
}

export interface SubtitleAvailability {
  requestedLanguages: string[];
  availableManualLanguages: string[];
  availableAutoLanguages: string[];
}

export interface SubtitleFetchSuccess {
  status: "success";
  request: NormalizedYtTranscriptRequest;
  metadata: YtDlpMetadata;
  selectedTrack: SelectedSubtitleTrack;
  rawSubtitleContent: string;
  rawSubtitleFileName: string;
  availability: SubtitleAvailability;
  warnings: string[];
}

export interface SubtitleFetchNoSubtitles {
  status: "no_subtitles";
  request: NormalizedYtTranscriptRequest;
  metadata?: YtDlpMetadata;
  availability: SubtitleAvailability;
  warnings: string[];
}

export type SubtitleFetchResult =
  | SubtitleFetchSuccess
  | SubtitleFetchNoSubtitles;

export interface TranscriptArtifacts {
  /** Legacy raw transcript text path. */
  transcriptTextPath?: string;
  /** Legacy raw transcript JSON path. */
  transcriptJsonPath?: string;
  cleanTranscriptTextPath?: string;
  cleanTranscriptJsonPath?: string;
  rawSubtitlePath?: string;
  metadataJsonPath?: string;
}

export interface YtTranscriptSuccessDetails {
  status: "success";
  title?: string;
  originalUrl: string;
  webpageUrl?: string;
  videoId?: string;
  channel?: string;
  uploader?: string;
  uploadDate?: string;
  duration?: number;
  requestedLanguages: string[];
  selectedLanguage: string;
  subtitleSource: SubtitleSource;
  /** Raw parsed subtitle segment count, preserved for backward compatibility. */
  segmentCount: number;
  cleanSegmentCount: number;
  cleaning: TranscriptCleaningStats;
  previewText: string;
  previewTruncated: boolean;
  warnings: string[];
  artifacts: TranscriptArtifacts;
}

export interface YtTranscriptNoSubtitleDetails {
  status: "no_subtitles";
  originalUrl: string;
  title?: string;
  videoId?: string;
  requestedLanguages: string[];
  availableManualLanguages: string[];
  availableAutoLanguages: string[];
  warnings: string[];
}

export type YtTranscriptToolDetails =
  | YtTranscriptSuccessDetails
  | YtTranscriptNoSubtitleDetails;

export function normalizeYtTranscriptRequest(
  params: YtTranscriptParams
): NormalizedYtTranscriptRequest {
  return {
    url: normalizeVideoUrl(params.url),
    languages: normalizeLanguages(params.languages),
    sourcePreference: normalizeSourcePreference(params.sourcePreference),
    includeTimestamps: params.includeTimestamps ?? DEFAULT_INCLUDE_TIMESTAMPS,
    timeoutSec: normalizeTimeoutSec(params.timeoutSec),
  };
}

export function normalizeVideoUrl(input: string): string {
  if (typeof input !== "string") {
    throw new Error("URL is required.");
  }
  const trimmed = input.trim();
  if (trimmed === "") {
    throw new Error("URL is required.");
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error(`Malformed URL: ${trimmed}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`Unsupported URL scheme: ${parsed.protocol}`);
  }
  return parsed.toString();
}

function normalizeLanguages(languages: string[] | undefined): string[] {
  const rawLanguages = languages ?? [...DEFAULT_LANGUAGES];
  if (!Array.isArray(rawLanguages) || rawLanguages.length === 0) {
    throw new Error("At least one subtitle language is required.");
  }

  const normalized: string[] = [];
  for (const language of rawLanguages) {
    if (typeof language !== "string") {
      throw new Error("Subtitle languages must be strings.");
    }
    const trimmed = language.trim();
    if (trimmed === "" || /\s/u.test(trimmed)) {
      throw new Error(`Invalid subtitle language: ${JSON.stringify(language)}`);
    }
    if (!normalized.includes(trimmed)) normalized.push(trimmed);
  }
  return normalized;
}

function normalizeSourcePreference(
  preference: SubtitleSourcePreference | undefined
): SubtitleSourcePreference {
  const value = preference ?? DEFAULT_SOURCE_PREFERENCE;
  if (
    value !== "manual_then_auto" &&
    value !== "manual_only" &&
    value !== "auto_only"
  ) {
    throw new Error(`Unsupported subtitle source preference: ${String(value)}`);
  }
  return value;
}

function normalizeTimeoutSec(timeoutSec: number | undefined): number {
  const value = timeoutSec ?? DEFAULT_TIMEOUT_SEC;
  if (
    !Number.isInteger(value) ||
    value < MIN_TIMEOUT_SEC ||
    value > MAX_TIMEOUT_SEC
  ) {
    throw new Error(
      `timeoutSec must be an integer from ${MIN_TIMEOUT_SEC} to ${MAX_TIMEOUT_SEC}.`
    );
  }
  return value;
}
