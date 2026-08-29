import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { NormalizedYtTranscriptRequest, YtDlpMetadata } from "./contracts";
import {
  buildSubtitleAvailability,
  cleanTranscriptSegments,
  parseVtt,
  renderTranscript,
  selectSubtitleTrack,
} from "./subtitles";

test("parses VTT fixtures into deterministic segments", async () => {
  const content = await readFile(
    join(import.meta.dir, "fixtures/simple.vtt"),
    "utf8"
  );
  expect(parseVtt(content)).toEqual([
    { index: 1, start: 0, end: 2, text: "Welcome & hello." },
    { index: 2, start: 2.5, end: 4, text: "This is pi-yt." },
    { index: 3, start: 5, end: 7.25, text: "Thanks for watching." },
  ]);
});

test("renders timestamped and untimestamped transcripts", () => {
  const segments = [
    { index: 1, start: 0, end: 1, text: "Hello" },
    { index: 2, start: 61, end: 62, text: "World" },
  ];

  expect(renderTranscript(segments, { includeTimestamps: true })).toBe(
    "[00:00:00] Hello\n[00:01:01] World"
  );
  expect(renderTranscript(segments, { includeTimestamps: false })).toBe(
    "Hello\nWorld"
  );
});

test("merges adjacent duplicate auto captions", async () => {
  const content = await readFile(
    join(import.meta.dir, "fixtures/auto-duplicates.vtt"),
    "utf8"
  );
  expect(parseVtt(content)).toEqual([
    { index: 1, start: 0, end: 2, text: "hello" },
    { index: 2, start: 2.5, end: 3.5, text: "world" },
  ]);
});

test("cleans progressive YouTube auto-caption duplicates into readable chunks", () => {
  const result = cleanTranscriptSegments(
    [
      {
        index: 1,
        start: 2,
        end: 4,
        text: "Well, good morning folks. How are you? I",
      },
      {
        index: 2,
        start: 4,
        end: 6,
        text: "Well, good morning folks. How are you? I hope you're doing well.",
      },
      { index: 3, start: 6, end: 8, text: "hope you're doing well." },
    ],
    { subtitleSource: "auto" }
  );

  expect(result.segments).toEqual([
    {
      index: 1,
      start: 2,
      end: 8,
      text: "Well, good morning folks. How are you? I hope you're doing well.",
    },
  ]);
  expect(result.stats.progressiveDuplicateMerges).toBe(1);
  expect(result.stats.overlapMerges).toBe(1);
  expect(result.stats.warnings.join("\n")).toContain("auto-generated");
  expect(result.stats.warnings.join("\n")).toContain("heuristics");
});

test("manual_then_auto selects manual subtitles before automatic captions", () => {
  const metadata: YtDlpMetadata = {
    subtitles: { en: [{ ext: "vtt", url: "manual" }] },
    automatic_captions: { en: [{ ext: "vtt", url: "auto" }] },
  };
  expect(selectSubtitleTrack(metadata, request())).toMatchObject({
    language: "en",
    source: "manual",
    url: "manual",
  });
});

test("source preferences can force auto-only selection", () => {
  const metadata: YtDlpMetadata = {
    subtitles: { en: [{ ext: "vtt", url: "manual" }] },
    automatic_captions: { en: [{ ext: "vtt", url: "auto" }] },
  };
  expect(
    selectSubtitleTrack(metadata, request({ sourcePreference: "auto_only" }))
  ).toMatchObject({ source: "auto", url: "auto" });
});

test("subtitle availability reports manual and auto languages", () => {
  const availability = buildSubtitleAvailability(
    {
      subtitles: { en: [{ ext: "vtt" }], es: [{ ext: "vtt" }] },
      automatic_captions: { de: [{ ext: "vtt" }] },
    },
    ["fr"]
  );

  expect(availability).toEqual({
    requestedLanguages: ["fr"],
    availableManualLanguages: ["en", "es"],
    availableAutoLanguages: ["de"],
  });
});

function request(
  overrides: Partial<NormalizedYtTranscriptRequest> = {}
): NormalizedYtTranscriptRequest {
  return {
    url: "https://example.com/video",
    languages: ["en"],
    sourcePreference: "manual_then_auto",
    includeTimestamps: true,
    timeoutSec: 30,
    ...overrides,
  };
}
