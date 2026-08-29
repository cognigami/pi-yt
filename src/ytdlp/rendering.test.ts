import { expect, test } from "bun:test";
import type { YtTranscriptToolDetails } from "./contracts";
import {
  formatYtToolCall,
  renderYtToolCall,
  renderYtTranscriptResult,
} from "./rendering";

const plainTheme = {
  bold: (text: string) => text,
  fg: (_color: string, text: string) => text,
};

test("formats compact yt_transcript calls", () => {
  expect(
    formatYtToolCall(plainTheme, {
      name: "yt_transcript",
      url: "https://www.youtube.com/watch?v=abc123",
      languages: ["en", "es"],
      sourcePreference: "manual_then_auto",
    })
  ).toBe(
    "yt_transcript https://www.youtube.com/watch?v=abc123 · en,es · manual_then_auto"
  );
});

test("collapsed call rendering stays concise", () => {
  const component = renderYtToolCall(
    plainTheme,
    {},
    {
      name: "yt_transcript",
      url: "https://example.com/video",
    }
  );
  expect(component.render(80)[0]?.trimEnd()).toBe(
    "yt_transcript https://example.com/video"
  );
});

test("renders success results with artifacts in expanded view", () => {
  const details: YtTranscriptToolDetails = {
    status: "success",
    title: "Fixture Video",
    originalUrl: "https://example.com/video",
    webpageUrl: "https://example.com/video",
    videoId: "abc",
    duration: 10,
    requestedLanguages: ["en"],
    selectedLanguage: "en",
    subtitleSource: "manual",
    segmentCount: 4,
    cleanSegmentCount: 2,
    cleaning: {
      rawSegmentCount: 4,
      cleanedSegmentCount: 2,
      exactDuplicateMerges: 0,
      progressiveDuplicateMerges: 1,
      overlapMerges: 1,
      readableChunkMerges: 0,
      heuristic: true,
      warnings: ["minor warning"],
    },
    previewText: "Hello",
    previewTruncated: false,
    warnings: ["minor warning"],
    artifacts: {
      transcriptTextPath: "/tmp/pi-yt/transcript.txt",
      transcriptJsonPath: "/tmp/pi-yt/transcript.json",
      cleanTranscriptTextPath: "/tmp/pi-yt/transcript.clean.txt",
      cleanTranscriptJsonPath: "/tmp/pi-yt/transcript.clean.json",
      rawSubtitlePath: "/tmp/pi-yt/en.vtt",
      metadataJsonPath: "/tmp/pi-yt/metadata.json",
    },
  };

  const collapsed = renderYtTranscriptResult(
    { details },
    { expanded: false },
    plainTheme,
    {}
  )
    .render(100)
    .map((line) => line.trimEnd());
  const expanded = renderYtTranscriptResult(
    { details },
    { expanded: true },
    plainTheme,
    {}
  )
    .render(100)
    .map((line) => line.trimEnd());

  expect(collapsed).toEqual([
    "en/manual: 2 clean segments (4 raw) · Fixture Video",
  ]);
  expect(expanded).toContain("title: Fixture Video");
  expect(expanded).toContain("warning: minor warning");
  expect(expanded).toContain(
    "clean transcript: /tmp/pi-yt/transcript.clean.txt"
  );
  expect(expanded).toContain("raw transcript: /tmp/pi-yt/transcript.txt");
});

test("renders no-subtitle and missing-detail states compactly", () => {
  const noSubtitle: YtTranscriptToolDetails = {
    status: "no_subtitles",
    originalUrl: "https://example.com/video",
    title: "No French",
    videoId: "abc",
    requestedLanguages: ["fr"],
    availableManualLanguages: ["en"],
    availableAutoLanguages: [],
    warnings: ["No matching subtitles."],
  };

  expect(
    renderYtTranscriptResult({ details: noSubtitle }, {}, plainTheme, {})
      .render(80)[0]
      ?.trimEnd()
  ).toBe("no subtitles for fr");
  expect(
    renderYtTranscriptResult(undefined, {}, plainTheme, {})
      .render(80)[0]
      ?.trimEnd()
  ).toBe("No transcript metadata returned.");
});
