/** yt_transcript tool registration and end-to-end transcript pipeline. */
import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  buildNoSubtitleToolResult,
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
  type YtTranscriptParams,
  type YtTranscriptToolDetails,
} from "../ytdlp/contracts";
import { fetchSubtitleWithYtDlp } from "../ytdlp/execute";
import {
  renderYtTranscriptCall,
  renderYtTranscriptResult,
} from "../ytdlp/rendering";
import { parseVtt } from "../ytdlp/subtitles";

const YT_TRANSCRIPT_NAME = "yt_transcript";
const YT_TRANSCRIPT_LABEL = "yt-transcript";
const YT_TRANSCRIPT_DESCRIPTION =
  "Fetch video subtitles with yt-dlp, stage raw and cleaned transcript artifacts, and return a compact cleaned preview.";
const YT_TRANSCRIPT_PROMPT_SNIPPET =
  "Use yt_transcript for video transcript extraction instead of shelling out to yt-dlp.";
const YT_TRANSCRIPT_PROMPT_GUIDELINES = [
  "Use yt_transcript when the user provides a video URL and needs readable transcript or subtitle text.",
  "Do not shell out to yt-dlp for transcript extraction when this tool is available.",
  "Pass only http:// or https:// video URLs; unsupported schemes are rejected before external commands run.",
  "Do not request generic yt-dlp arguments; this tool intentionally has no raw argv passthrough.",
  "Read the staged cleaned transcript artifact when the preview is truncated or the full transcript is needed; read the raw transcript when original caption timing/fragments matter.",
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
}

export async function executeYtTranscript(
  options: ExecuteYtTranscriptOptions
): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: YtTranscriptToolDetails;
}> {
  const request = normalizeYtTranscriptRequest(options.params);
  const fetchSubtitles = options.fetchSubtitles ?? fetchSubtitleWithYtDlp;
  const fetch = await fetchSubtitles({
    pi: options.pi,
    request,
    signal: options.signal,
  });

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
