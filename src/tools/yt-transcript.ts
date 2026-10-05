/** yt_transcript tool registration and end-to-end transcript pipeline. */
import { StringEnum } from "@earendil-works/pi-ai";
import type { Usage } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  type GeminiFallbackConfig,
  generateGeminiTranscript,
  loadGeminiFallbackConfig,
} from "../gemini/execute";
import {
  buildNoSubtitleToolResult,
  stageGeneratedTranscriptArtifacts,
  stageTranscriptArtifacts,
} from "../ytdlp/artifacts";
import {
  DEFAULT_INCLUDE_TIMESTAMPS,
  DEFAULT_LANGUAGES,
  DEFAULT_SOURCE_PREFERENCE,
  DEFAULT_TIMEOUT_SEC,
  MAX_TIMEOUT_SEC,
  MIN_TIMEOUT_SEC,
  normalizeYtTranscriptRequest,
  type SubtitleFetchResult,
  type YtTranscriptParams,
  type YtTranscriptToolDetails,
} from "../ytdlp/contracts";
import {
  fetchSubtitleWithYtDlp,
  YtDlpSubtitleRateLimitError,
} from "../ytdlp/execute";
import {
  renderYtTranscriptCall,
  renderYtTranscriptResult,
} from "../ytdlp/rendering";
import { parseVtt } from "../ytdlp/subtitles";

const YT_TRANSCRIPT_NAME = "yt_transcript";
const YT_TRANSCRIPT_LABEL = "yt-transcript";
const YT_TRANSCRIPT_DESCRIPTION =
  "Fetch video subtitles with yt-dlp, optionally fall back to Gemini for rate-limited YouTube captions, stage transcript artifacts, and return a compact preview.";
const YT_TRANSCRIPT_PROMPT_SNIPPET =
  "Use yt_transcript for video transcript extraction instead of shelling out to yt-dlp.";
const YT_TRANSCRIPT_PROMPT_GUIDELINES = [
  "Use yt_transcript when the user provides a video URL and needs readable transcript or subtitle text.",
  "Do not shell out to yt-dlp for transcript extraction when this tool is available.",
  "Pass only http:// or https:// video URLs; unsupported schemes are rejected before external commands run.",
  "Do not request generic yt-dlp arguments; this tool intentionally has no raw argv passthrough.",
  "Read the staged cleaned transcript artifact when the preview is truncated or the full transcript is needed; read the raw transcript when original caption timing/fragments matter.",
  "When GEMINI_API_KEY enables the YouTube 429 fallback, treat its result as AI-generated rather than an exact subtitle track and preserve the returned quality warning.",
  "If both yt-dlp and the built-in Gemini fallback fail, stop and ask the operator to retry later; do not attempt another transcript fallback.",
] as const;
const YT_TRANSCRIPT_EXTERNAL_DEPENDENCIES = ["yt-dlp"] as const;

const SourcePreferenceParam = StringEnum(
  ["manual_then_auto", "manual_only", "auto_only"] as const,
  {
    description: `Subtitle source preference. Defaults to ${DEFAULT_SOURCE_PREFERENCE}.`,
  }
);

export const YtTranscriptParamsSchema = Type.Object({
  url: Type.String({
    description: "HTTP/HTTPS video URL accepted by yt-dlp.",
  }),
  languages: Type.Optional(
    Type.Array(Type.String(), {
      minItems: 1,
      description: `Subtitle language preferences. Defaults to ${JSON.stringify(DEFAULT_LANGUAGES)}.`,
    })
  ),
  sourcePreference: Type.Optional(SourcePreferenceParam),
  includeTimestamps: Type.Optional(
    Type.Boolean({
      description: `Include timestamps in transcript.txt. Defaults to ${DEFAULT_INCLUDE_TIMESTAMPS}.`,
    })
  ),
  timeoutSec: Type.Optional(
    Type.Integer({
      minimum: MIN_TIMEOUT_SEC,
      maximum: MAX_TIMEOUT_SEC,
      description: `yt-dlp timeout in seconds. Defaults to ${DEFAULT_TIMEOUT_SEC}.`,
    })
  ),
});

export interface ExecuteYtTranscriptOptions {
  pi: Pick<ExtensionAPI, "exec">;
  params: YtTranscriptParams;
  signal?: AbortSignal;
  fetchSubtitles?: typeof fetchSubtitleWithYtDlp;
  stageArtifacts?: typeof stageTranscriptArtifacts;
  generateTranscript?: typeof generateGeminiTranscript;
  stageGeneratedArtifacts?: typeof stageGeneratedTranscriptArtifacts;
  /** Undefined loads environment configuration; null explicitly disables fallback. */
  geminiFallback?: GeminiFallbackConfig | null;
}

export async function executeYtTranscript(
  options: ExecuteYtTranscriptOptions
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: YtTranscriptToolDetails;
  usage?: Usage;
}> {
  const request = normalizeYtTranscriptRequest(options.params);
  const fetchSubtitles = options.fetchSubtitles ?? fetchSubtitleWithYtDlp;
  let fetch: SubtitleFetchResult;
  try {
    fetch = await fetchSubtitles({
      pi: options.pi,
      request,
      signal: options.signal,
    });
  } catch (error) {
    if (!(error instanceof YtDlpSubtitleRateLimitError)) throw error;

    const fallback =
      options.geminiFallback === undefined
        ? loadGeminiFallbackConfig()
        : options.geminiFallback;
    if (!fallback) {
      throw new YtDlpSubtitleRateLimitError(
        `${error.message}\nGemini fallback is disabled; set GEMINI_API_KEY to opt in.`,
        error.context
      );
    }

    const generateTranscript =
      options.generateTranscript ?? generateGeminiTranscript;
    try {
      const generated = await generateTranscript({
        apiKey: fallback.apiKey,
        model: fallback.model,
        url: canonicalYouTubeUrl(error),
        languages: request.languages,
        includeTimestamps: request.includeTimestamps,
        signal: options.signal,
      });
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("Transcript request aborted.");
      }
      const stageGeneratedArtifacts =
        options.stageGeneratedArtifacts ?? stageGeneratedTranscriptArtifacts;
      const staged = await stageGeneratedArtifacts({
        context: error.context,
        transcriptText: generated.text,
        model: generated.model,
        originalFailure: error.message,
        providerWarnings: generated.warnings,
        signal: options.signal,
      });
      if (options.signal?.aborted) {
        throw options.signal.reason ?? new Error("Transcript request aborted.");
      }
      return {
        content: [{ type: "text" as const, text: staged.contentText }],
        details: staged.details,
        ...(generated.usage ? { usage: toPiUsage(generated.usage) } : {}),
      };
    } catch (fallbackError) {
      if (options.signal?.aborted) throw fallbackError;
      const fallbackMessage =
        fallbackError instanceof Error
          ? fallbackError.message
          : String(fallbackError);
      throw new Error(
        `${error.message}\nGemini transcript fallback failed: ${fallbackMessage}\nStop and ask the operator to retry later; do not attempt another transcript fallback.`,
        { cause: fallbackError }
      );
    }
  }

  if (fetch.status === "no_subtitles") {
    return buildNoSubtitleToolResult(fetch);
  }

  const segments = parseVtt(fetch.rawSubtitleContent);
  const stageArtifacts = options.stageArtifacts ?? stageTranscriptArtifacts;
  const staged = await stageArtifacts({ fetch, segments });
  return {
    content: [{ type: "text" as const, text: staged.contentText }],
    details: staged.details,
  };
}

function toPiUsage(usage: {
  input: number;
  output: number;
  cacheRead: number;
  reasoning: number;
  totalTokens: number;
}): Usage {
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: 0,
    reasoning: usage.reasoning,
    totalTokens: usage.totalTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function canonicalYouTubeUrl(error: YtDlpSubtitleRateLimitError): string {
  const videoId =
    normalizeVideoId(error.context.metadata.id) ??
    extractYouTubeVideoId(error.context.request.url);
  if (!videoId) {
    throw new Error(
      "Could not derive a canonical public YouTube video URL for Gemini fallback."
    );
  }
  return `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}`;
}

function extractYouTubeVideoId(input: string): string | undefined {
  const parsed = new URL(input);
  const hostname = parsed.hostname.toLowerCase();
  if (hostname === "youtu.be") {
    return normalizeVideoId(parsed.pathname.split("/").filter(Boolean)[0]);
  }
  if (hostname === "youtube.com" || hostname.endsWith(".youtube.com")) {
    const queryId = normalizeVideoId(parsed.searchParams.get("v") ?? undefined);
    if (queryId) return queryId;
    const [kind, pathId] = parsed.pathname.split("/").filter(Boolean);
    if (["shorts", "live", "embed", "v"].includes(kind ?? "")) {
      return normalizeVideoId(pathId);
    }
  }
  return undefined;
}

function normalizeVideoId(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && /^[a-z0-9_-]+$/iu.test(normalized)
    ? normalized
    : undefined;
}

const ytTranscriptTool = {
  name: YT_TRANSCRIPT_NAME,
  label: YT_TRANSCRIPT_LABEL,
  description: YT_TRANSCRIPT_DESCRIPTION,
  promptSnippet: YT_TRANSCRIPT_PROMPT_SNIPPET,
  promptGuidelines: YT_TRANSCRIPT_PROMPT_GUIDELINES,
  externalDependencies: YT_TRANSCRIPT_EXTERNAL_DEPENDENCIES,
  register(pi: ExtensionAPI) {
    pi.registerTool({
      name: ytTranscriptTool.name,
      label: ytTranscriptTool.label,
      description: ytTranscriptTool.description,
      promptSnippet: ytTranscriptTool.promptSnippet,
      promptGuidelines: [...ytTranscriptTool.promptGuidelines],
      parameters: YtTranscriptParamsSchema,
      async execute(_toolCallId, params, signal) {
        return await executeYtTranscript({ pi, params, signal });
      },
      renderCall(args, theme, context) {
        return renderYtTranscriptCall(args, theme, context);
      },
      renderResult(result, options, theme, context) {
        return renderYtTranscriptResult(result, options, theme, context);
      },
    });
  },
};

export default ytTranscriptTool;
