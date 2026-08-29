import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ytTranscriptTool, { executeYtTranscript } from "./yt-transcript";

test("tool registration exposes prompt guidance and no raw yt-dlp argv schema", () => {
  const registered: unknown[] = [];
  const api = {
    registerTool(tool: unknown) {
      registered.push(tool);
    },
  } as unknown as ExtensionAPI;

  ytTranscriptTool.register(api);
  expect(registered).toHaveLength(1);
  const tool = registered[0] as {
    name: string;
    label: string;
    promptGuidelines: string[];
    parameters: { properties: Record<string, unknown> };
  };
  expect(tool.name).toBe("yt_transcript");
  expect(tool.label).toBe("yt-transcript");
  expect(tool.promptGuidelines.join("\n")).toContain("no raw argv passthrough");
  expect(Object.keys(tool.parameters.properties).sort()).toEqual([
    "includeTimestamps",
    "languages",
    "sourcePreference",
    "timeoutSec",
    "url",
  ]);
});

test("rejects unsupported URL schemes before executing yt-dlp", async () => {
  let fetchCalled = false;
  await expect(
    executeYtTranscript({
      pi: fakePi(),
      params: { url: "file:///tmp/video" },
      fetchSubtitles: async () => {
        fetchCalled = true;
        throw new Error("should not execute");
      },
    })
  ).rejects.toThrow("Unsupported URL scheme: file:");
  expect(fetchCalled).toBe(false);
});

test("mocked end-to-end pipeline parses fixture subtitles and returns details", async () => {
  const rawSubtitleContent = await readFile(
    join(import.meta.dir, "../ytdlp/fixtures/simple.vtt"),
    "utf8"
  );
  const result = await executeYtTranscript({
    pi: fakePi(),
    params: { url: "https://www.youtube.com/watch?v=abc123" },
    fetchSubtitles: async ({ request }) => ({
      status: "success",
      request,
      metadata: {
        id: "abc123",
        title: "Fixture Video",
        original_url: request.url,
        webpage_url: "https://www.youtube.com/watch?v=abc123",
        duration: 7,
      },
      selectedTrack: { language: "en", source: "manual", ext: "vtt" },
      rawSubtitleContent,
      rawSubtitleFileName: "en.manual.vtt",
      availability: {
        requestedLanguages: request.languages,
        availableManualLanguages: ["en"],
        availableAutoLanguages: [],
      },
      warnings: [],
    }),
    stageArtifacts: async ({ fetch, segments }) => ({
      contentText: `segments: ${segments.length}`,
      details: {
        status: "success",
        title: fetch.metadata.title,
        originalUrl: fetch.request.url,
        webpageUrl: fetch.metadata.webpage_url,
        videoId: fetch.metadata.id,
        duration: fetch.metadata.duration,
        requestedLanguages: fetch.request.languages,
        selectedLanguage: fetch.selectedTrack.language,
        subtitleSource: fetch.selectedTrack.source,
        segmentCount: segments.length,
        cleanSegmentCount: segments.length,
        cleaning: {
          rawSegmentCount: segments.length,
          cleanedSegmentCount: segments.length,
          exactDuplicateMerges: 0,
          progressiveDuplicateMerges: 0,
          overlapMerges: 0,
          readableChunkMerges: 0,
          heuristic: false,
          warnings: [],
        },
        previewText: segments.map((segment) => segment.text).join("\n"),
        previewTruncated: false,
        warnings: [],
        artifacts: {
          transcriptTextPath: "/tmp/transcript.txt",
          transcriptJsonPath: "/tmp/transcript.json",
          cleanTranscriptTextPath: "/tmp/transcript.clean.txt",
          cleanTranscriptJsonPath: "/tmp/transcript.clean.json",
          rawSubtitlePath: "/tmp/en.manual.vtt",
          metadataJsonPath: "/tmp/metadata.json",
        },
      },
    }),
  });

  expect(result.content[0]?.text).toBe("segments: 3");
  expect(result.details).toMatchObject({
    status: "success",
    selectedLanguage: "en",
    subtitleSource: "manual",
    segmentCount: 3,
  });
});

function fakePi(): Pick<ExtensionAPI, "exec"> {
  return {
    async exec() {
      throw new Error("unexpected exec");
    },
  } as Pick<ExtensionAPI, "exec">;
}
