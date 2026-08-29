/** Artifact staging and compact LLM-facing result construction. */
import {
  type ArtifactStager,
  createExtensionFiles,
  formatJson,
} from "pi-extension-kit/files";
import type {
  SubtitleFetchNoSubtitles,
  SubtitleFetchSuccess,
  TranscriptCleaningStats,
  TranscriptSegment,
  YtTranscriptNoSubtitleDetails,
  YtTranscriptSuccessDetails,
  YtTranscriptToolDetails,
} from "./contracts";
import { cleanTranscriptSegments, renderTranscript } from "./subtitles";

export const TRANSCRIPT_PREVIEW_LIMIT = 4000;

const defaultFiles = createExtensionFiles({ extensionName: "pi-yt" });
const defaultStager = defaultFiles.createArtifactStager({
  toolName: "yt_transcript",
});

type ArtifactKey =
  | "transcriptText"
  | "transcriptJson"
  | "cleanTranscriptText"
  | "cleanTranscriptJson"
  | "rawSubtitle"
  | "metadata";

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

  return await stager.stage<ArtifactKey, YtTranscriptSuccessDetails>({
    files: [
      {
        key: "transcriptText",
        fileName: "transcript.txt",
        content: transcriptText,
      },
      {
        key: "transcriptJson",
        fileName: "transcript.json",
        content: formatJson({ segments: options.segments }),
      },
      {
        key: "cleanTranscriptText",
        fileName: "transcript.clean.txt",
        content: cleanTranscriptText,
      },
      {
        key: "cleanTranscriptJson",
        fileName: "transcript.clean.json",
        content: formatJson({
          segments: cleanTranscript.segments,
          cleaning: cleanTranscript.stats,
        }),
      },
      {
        key: "rawSubtitle",
        fileName: options.fetch.rawSubtitleFileName,
        content: options.fetch.rawSubtitleContent,
      },
      {
        key: "metadata",
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
    buildContentText: ({ paths }) =>
      buildSuccessContentText({
        details: buildSuccessDetails(
          options.fetch,
          options.segments,
          cleanTranscript.segments,
          cleanTranscript.stats,
          preview,
          warnings,
          {
            transcriptTextPath: paths.transcriptText,
            transcriptJsonPath: paths.transcriptJson,
            cleanTranscriptTextPath: paths.cleanTranscriptText,
            cleanTranscriptJsonPath: paths.cleanTranscriptJson,
            rawSubtitlePath: paths.rawSubtitle,
            metadataJsonPath: paths.metadata,
          }
        ),
      }),
    buildDetails: ({ paths }) =>
      buildSuccessDetails(
        options.fetch,
        options.segments,
        cleanTranscript.segments,
        cleanTranscript.stats,
        preview,
        warnings,
        {
          transcriptTextPath: paths.transcriptText,
          transcriptJsonPath: paths.transcriptJson,
          cleanTranscriptTextPath: paths.cleanTranscriptText,
          cleanTranscriptJsonPath: paths.cleanTranscriptJson,
          rawSubtitlePath: paths.rawSubtitle,
          metadataJsonPath: paths.metadata,
        }
      ),
  });
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
    details.artifacts.cleanTranscriptTextPath
      ? `clean transcript: ${details.artifacts.cleanTranscriptTextPath}`
      : undefined,
    details.artifacts.cleanTranscriptJsonPath
      ? `clean transcript JSON: ${details.artifacts.cleanTranscriptJsonPath}`
      : undefined,
    details.artifacts.transcriptTextPath
      ? `raw transcript: ${details.artifacts.transcriptTextPath}`
      : undefined,
    details.artifacts.transcriptJsonPath
      ? `raw transcript JSON: ${details.artifacts.transcriptJsonPath}`
      : undefined,
    details.artifacts.rawSubtitlePath
      ? `raw subtitle: ${details.artifacts.rawSubtitlePath}`
      : undefined,
    details.artifacts.metadataJsonPath
      ? `metadata: ${details.artifacts.metadataJsonPath}`
      : undefined,
    details.previewTruncated
      ? "preview: truncated; read the staged clean transcript for the full text."
      : "preview:",
    details.previewText,
  ];
  return lines.filter((line): line is string => line !== undefined).join("\n");
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
      (value as { status?: unknown }).status === "no_subtitles")
  );
}
