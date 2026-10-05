/** Artifact staging and compact LLM-facing result construction. */
import {
  type ArtifactStager,
  createExtensionFiles,
  formatJson,
} from "pi-extension-kit/files";
import type {
  SubtitleFetchContext,
  SubtitleFetchNoSubtitles,
  SubtitleFetchSuccess,
  TranscriptArtifactKey,
  TranscriptCleaningStats,
  TranscriptSegment,
  YtTranscriptGeneratedDetails,
  YtTranscriptNoSubtitleDetails,
  YtTranscriptSuccessDetails,
  YtTranscriptToolDetails,
} from "./contracts";
import { cleanTranscriptSegments, renderTranscript } from "./subtitles";

export const TRANSCRIPT_PREVIEW_LIMIT = 4000;
export const GEMINI_GENERATED_WARNING =
  "AI-generated transcript; wording, completeness, and timestamps may differ from the source.";

const defaultFiles = createExtensionFiles({ extensionName: "pi-yt" });
const defaultStager = defaultFiles.createArtifactStager({
  toolName: "yt_transcript",
});

export interface StageTranscriptOptions {
  fetch: SubtitleFetchSuccess;
  segments: TranscriptSegment[];
  stager?: ArtifactStager;
}

export async function stageTranscriptArtifacts(
  options: StageTranscriptOptions
): Promise<{ contentText: string; details: YtTranscriptSuccessDetails }> {
  const cleanTranscript = cleanTranscriptSegments(options.segments, {
    subtitleSource: options.fetch.selectedTrack.source,
  });
  const transcriptText = renderTranscript(options.segments, {
    includeTimestamps: options.fetch.request.includeTimestamps,
  });
  const cleanTranscriptText = renderTranscript(cleanTranscript.segments, {
    includeTimestamps: options.fetch.request.includeTimestamps,
  });
  const warnings = [
    ...options.fetch.warnings,
    ...cleanTranscript.stats.warnings,
  ];
  const preview = buildPreview(cleanTranscriptText, TRANSCRIPT_PREVIEW_LIMIT);
  const stager = options.stager ?? defaultStager;

  const staged = await stager.stageOutput<TranscriptArtifactKey>({
    artifacts: [
      {
        key: "cleanTranscriptText",
        label: "clean transcript",
        fileName: "transcript.clean.txt",
        content: cleanTranscriptText,
        primary: true,
      },
      {
        key: "cleanTranscriptJson",
        label: "clean transcript JSON",
        fileName: "transcript.clean.json",
        content: formatJson({
          segments: cleanTranscript.segments,
          cleaning: cleanTranscript.stats,
        }),
      },
      {
        key: "transcriptText",
        label: "raw transcript",
        fileName: "transcript.txt",
        content: transcriptText,
      },
      {
        key: "transcriptJson",
        label: "raw transcript JSON",
        fileName: "transcript.json",
        content: formatJson({ segments: options.segments }),
      },
      {
        key: "rawSubtitle",
        label: "raw subtitle",
        fileName: options.fetch.rawSubtitleFileName,
        content: options.fetch.rawSubtitleContent,
      },
      {
        key: "metadata",
        label: "metadata",
        fileName: "metadata.json",
        content: formatJson(
          buildMetadataArtifact(
            options.fetch,
            options.segments,
            cleanTranscript.stats,
            warnings
          )
        ),
      },
    ],
    appendText: () =>
      buildSuccessContentText({
        details: buildSuccessDetails(
          options.fetch,
          options.segments,
          cleanTranscript.segments,
          cleanTranscript.stats,
          preview,
          warnings,
          []
        ),
      }),
  });

  return {
    contentText: staged.contentText,
    details: buildSuccessDetails(
      options.fetch,
      options.segments,
      cleanTranscript.segments,
      cleanTranscript.stats,
      preview,
      warnings,
      staged.artifacts
    ),
  };
}

export interface StageGeneratedTranscriptOptions {
  context: SubtitleFetchContext;
  transcriptText: string;
  model: string;
  originalFailure: string;
  providerWarnings?: readonly string[];
  signal?: AbortSignal;
  stager?: ArtifactStager;
}

export async function stageGeneratedTranscriptArtifacts(
  options: StageGeneratedTranscriptOptions
): Promise<{ contentText: string; details: YtTranscriptGeneratedDetails }> {
  throwIfAborted(options.signal);
  const transcriptText = options.transcriptText.trim();
  const preview = buildPreview(transcriptText, TRANSCRIPT_PREVIEW_LIMIT);
  const warnings = [
    GEMINI_GENERATED_WARNING,
    "Gemini was used after YouTube rate-limited the automatic subtitle download.",
    ...(options.providerWarnings ?? []),
  ];
  const stager = options.stager ?? defaultStager;
  const detailsWithoutArtifacts = buildGeneratedDetails(
    options,
    preview,
    warnings,
    []
  );
  const staged = await stager.stageOutput<TranscriptArtifactKey>({
    artifacts: [
      {
        key: "generatedTranscriptText",
        label: "Gemini transcript",
        fileName: "transcript.gemini.md",
        content: `${transcriptText}\n`,
        primary: true,
      },
      {
        key: "metadata",
        label: "metadata",
        fileName: "metadata.json",
        content: formatJson({
          extractionMethod: "gemini_video",
          provider: "gemini",
          model: options.model,
          originalYtDlpFailure: options.originalFailure,
          request: options.context.request,
          selectedTrack: options.context.selectedTrack,
          availability: options.context.availability,
          metadata: options.context.metadata,
          warnings,
        }),
      },
    ],
    appendText: () => buildGeneratedContentText(detailsWithoutArtifacts),
  });

  throwIfAborted(options.signal);
  return {
    contentText: staged.contentText,
    details: buildGeneratedDetails(
      options,
      preview,
      warnings,
      staged.artifacts
    ),
  };
}

export function buildNoSubtitleToolResult(fetch: SubtitleFetchNoSubtitles): {
  content: Array<{ type: "text"; text: string }>;
  details: YtTranscriptNoSubtitleDetails;
} {
  const details: YtTranscriptNoSubtitleDetails = {
    status: "no_subtitles",
    originalUrl: fetch.request.url,
    title: fetch.metadata?.title,
    videoId: fetch.metadata?.id,
    requestedLanguages: [...fetch.availability.requestedLanguages],
    availableManualLanguages: [...fetch.availability.availableManualLanguages],
    availableAutoLanguages: [...fetch.availability.availableAutoLanguages],
    warnings: [...fetch.warnings],
  };
  return {
    content: [{ type: "text", text: buildNoSubtitleContentText(details) }],
    details,
  };
}

export function buildPreview(
  text: string,
  maxCharacters: number
): { text: string; truncated: boolean } {
  const limit = Math.max(0, Math.trunc(maxCharacters));
  if (text.length <= limit) return { text, truncated: false };
  return {
    text: `${text.slice(0, Math.max(0, limit - 20)).trimEnd()}\n... [truncated]`,
    truncated: true,
  };
}

export function buildSuccessContentText(options: {
  details: YtTranscriptSuccessDetails;
}): string {
  const { details } = options;
  const lines = [
    details.title ? `title: ${details.title}` : undefined,
    `selected: ${details.selectedLanguage} (${details.subtitleSource})`,
    `segments: raw ${details.segmentCount}, clean ${details.cleanSegmentCount}`,
    details.previewTruncated
      ? "preview: truncated; read the staged clean transcript for the full text."
      : "preview:",
    details.previewText,
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
}

export function buildGeneratedContentText(
  details: YtTranscriptGeneratedDetails
): string {
  return [
    details.title ? `title: ${details.title}` : undefined,
    `generated transcript: ${details.provider}/${details.model}`,
    ...details.warnings.map((warning) => `warning: ${warning}`),
    details.previewTruncated
      ? "preview: truncated; read the staged Gemini transcript for the full text."
      : "preview:",
    details.previewText,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function buildNoSubtitleContentText(
  details: YtTranscriptNoSubtitleDetails
): string {
  return [
    "no transcript subtitles found",
    details.title ? `title: ${details.title}` : undefined,
    `requested languages: ${details.requestedLanguages.join(", ")}`,
    `available manual languages: ${formatLanguageList(details.availableManualLanguages)}`,
    `available auto languages: ${formatLanguageList(details.availableAutoLanguages)}`,
    ...details.warnings.map((warning) => `warning: ${warning}`),
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function buildGeneratedDetails(
  options: StageGeneratedTranscriptOptions,
  preview: { text: string; truncated: boolean },
  warnings: string[],
  artifacts: YtTranscriptGeneratedDetails["artifacts"]
): YtTranscriptGeneratedDetails {
  const { context } = options;
  return {
    status: "generated",
    title: context.metadata.title,
    originalUrl: context.metadata.original_url ?? context.request.url,
    webpageUrl: context.metadata.webpage_url,
    videoId: context.metadata.id,
    channel: context.metadata.channel,
    uploader: context.metadata.uploader,
    uploadDate: context.metadata.upload_date,
    duration: context.metadata.duration,
    requestedLanguages: [...context.request.languages],
    provider: "gemini",
    model: options.model,
    previewText: preview.text,
    previewTruncated: preview.truncated,
    warnings,
    artifacts,
  };
}

function buildSuccessDetails(
  fetch: SubtitleFetchSuccess,
  segments: TranscriptSegment[],
  cleanSegments: TranscriptSegment[],
  cleaning: TranscriptCleaningStats,
  preview: { text: string; truncated: boolean },
  warnings: string[],
  artifacts: YtTranscriptSuccessDetails["artifacts"]
): YtTranscriptSuccessDetails {
  return {
    status: "success",
    title: fetch.metadata.title,
    originalUrl: fetch.metadata.original_url ?? fetch.request.url,
    webpageUrl: fetch.metadata.webpage_url,
    videoId: fetch.metadata.id,
    channel: fetch.metadata.channel,
    uploader: fetch.metadata.uploader,
    uploadDate: fetch.metadata.upload_date,
    duration: fetch.metadata.duration,
    requestedLanguages: [...fetch.request.languages],
    selectedLanguage: fetch.selectedTrack.language,
    subtitleSource: fetch.selectedTrack.source,
    segmentCount: segments.length,
    cleanSegmentCount: cleanSegments.length,
    cleaning,
    previewText: preview.text,
    previewTruncated: preview.truncated,
    warnings,
    artifacts,
  };
}

function buildMetadataArtifact(
  fetch: SubtitleFetchSuccess,
  segments: TranscriptSegment[],
  cleaning: TranscriptCleaningStats,
  warnings: string[]
): Record<string, unknown> {
  return {
    title: fetch.metadata.title,
    url: fetch.metadata.original_url ?? fetch.request.url,
    webpageUrl: fetch.metadata.webpage_url,
    videoId: fetch.metadata.id,
    channel: fetch.metadata.channel,
    uploader: fetch.metadata.uploader,
    uploadDate: fetch.metadata.upload_date,
    duration: fetch.metadata.duration,
    selectedLanguage: fetch.selectedTrack.language,
    subtitleSource: fetch.selectedTrack.source,
    transcriptQuality: {
      warnings,
      rawSegmentCount: segments.length,
      cleanedSegmentCount: cleaning.cleanedSegmentCount,
      heuristic: cleaning.heuristic,
      exactDuplicateMerges: cleaning.exactDuplicateMerges,
      progressiveDuplicateMerges: cleaning.progressiveDuplicateMerges,
      overlapMerges: cleaning.overlapMerges,
      readableChunkMerges: cleaning.readableChunkMerges,
    },
    request: fetch.request,
    selectedTrack: fetch.selectedTrack,
    availability: fetch.availability,
    metadata: fetch.metadata,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw signal.reason ?? new Error("Transcript request aborted.");
  }
}

function formatLanguageList(languages: readonly string[]): string {
  return languages.length === 0 ? "none" : languages.join(", ");
}

export function isYtTranscriptDetails(
  value: unknown
): value is YtTranscriptToolDetails {
  return (
    typeof value === "object" &&
    value !== null &&
    "status" in value &&
    ((value as { status?: unknown }).status === "success" ||
      (value as { status?: unknown }).status === "generated" ||
      (value as { status?: unknown }).status === "no_subtitles")
  );
}
