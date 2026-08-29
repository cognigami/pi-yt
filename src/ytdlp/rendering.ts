/** Compact TUI rendering helpers for pi-yt tools. */
import {
  formatToolCallRow,
  renderToolCallRow,
  renderToolResultView,
  summarizeItemList,
  summarizeOneLine,
  type ToolCallComponent,
  type ToolCallSegment,
  type ToolCallTheme,
  type ToolResultTheme,
} from "pi-extension-kit/tool-chrome";
import { isYtTranscriptDetails } from "./artifacts";
import type { YtTranscriptParams } from "./contracts";

export interface YtCallRenderOptions {
  name: string;
  url?: string;
  languages?: readonly string[];
  sourcePreference?: string;
  placeholder?: string;
}

export function formatYtToolCall(
  theme: ToolCallTheme,
  options: YtCallRenderOptions
): string {
  return formatToolCallRow(theme, toYtToolCallRow(options));
}

export function renderYtToolCall(
  theme: ToolCallTheme,
  context: { lastComponent?: unknown },
  options: YtCallRenderOptions
): ToolCallComponent {
  return renderToolCallRow(theme, context, toYtToolCallRow(options));
}

export function renderYtTranscriptCall(
  args: Partial<YtTranscriptParams> | undefined,
  theme: ToolCallTheme,
  context: { lastComponent?: unknown }
): ToolCallComponent {
  return renderYtToolCall(theme, context, {
    name: "yt_transcript",
    url: args?.url,
    languages: args?.languages,
    sourcePreference: args?.sourcePreference,
    placeholder: "...",
  });
}

export function renderYtTranscriptResult(
  result: { details?: unknown } | undefined,
  renderOptions: { expanded?: boolean; isPartial?: boolean },
  theme: ToolResultTheme,
  context: { lastComponent?: unknown }
): ToolCallComponent {
  const details = isYtTranscriptDetails(result?.details)
    ? result.details
    : undefined;
  if (!details) {
    return renderToolResultView(theme, context, renderOptions, {
      partial: "Fetching transcript...",
      empty: "No transcript metadata returned.",
    });
  }

  if (details.status === "no_subtitles") {
    return renderToolResultView(theme, context, renderOptions, {
      partial: "Fetching transcript...",
      collapsed: {
        text: `no subtitles for ${details.requestedLanguages.join(", ")}`,
        color: "warning",
        mode: "truncate",
      },
      expanded: [
        details.title
          ? { text: `title: ${details.title}`, mode: "truncate" as const }
          : undefined,
        {
          text: `requested: ${details.requestedLanguages.join(", ")}`,
          color: "muted" as const,
          mode: "truncate" as const,
        },
        {
          text: `manual: ${formatLanguages(details.availableManualLanguages)}`,
          color: "muted" as const,
          mode: "truncate" as const,
        },
        {
          text: `auto: ${formatLanguages(details.availableAutoLanguages)}`,
          color: "muted" as const,
          mode: "truncate" as const,
        },
        ...details.warnings.map((warning) => ({
          text: `warning: ${warning}`,
          color: "warning" as const,
          mode: "wrap" as const,
        })),
      ].filter(isDefined),
    });
  }

  const summary = `${details.selectedLanguage}/${details.subtitleSource}: ${details.cleanSegmentCount} clean segments (${details.segmentCount} raw)`;
  return renderToolResultView(theme, context, renderOptions, {
    partial: "Fetching transcript...",
    collapsed: {
      text: details.title ? `${summary} · ${details.title}` : summary,
      mode: "truncate",
    },
    expanded: [
      details.title
        ? { text: `title: ${details.title}`, mode: "truncate" as const }
        : undefined,
      {
        text: summary,
        color: "success" as const,
        mode: "truncate" as const,
      },
      ...details.warnings.map((warning) => ({
        text: `warning: ${warning}`,
        color: "warning" as const,
        mode: "wrap" as const,
      })),
      {
        kind: "artifacts" as const,
        artifacts: [
          {
            label: "clean transcript",
            path: details.artifacts.cleanTranscriptTextPath,
            primary: true,
          },
          {
            label: "clean json",
            path: details.artifacts.cleanTranscriptJsonPath,
          },
          {
            label: "raw transcript",
            path: details.artifacts.transcriptTextPath,
          },
          { label: "raw json", path: details.artifacts.transcriptJsonPath },
          { label: "subtitle", path: details.artifacts.rawSubtitlePath },
          { label: "metadata", path: details.artifacts.metadataJsonPath },
        ],
        collapsed: "primary" as const,
      },
    ].filter(isDefined),
  });
}

function toYtToolCallRow(options: YtCallRenderOptions) {
  const segments: ToolCallSegment[] = [];
  const url = summarizeOneLine(options.url, 90);
  if (url) segments.push({ text: url, color: "accent" });

  const languages = summarizeItemList(
    options.languages ? [...options.languages] : undefined,
    { maxItems: 4, separator: "," }
  );
  if (languages) segments.push({ text: languages, color: "muted" });

  const sourcePreference = summarizeOneLine(options.sourcePreference, 30);
  if (sourcePreference) segments.push({ text: sourcePreference, color: "dim" });

  return {
    name: options.name,
    segments,
    placeholder: options.placeholder,
  };
}

function formatLanguages(languages: readonly string[]): string {
  return languages.length === 0 ? "none" : languages.join(", ");
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}
