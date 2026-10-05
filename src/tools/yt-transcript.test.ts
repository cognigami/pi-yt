import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { YtDlpSubtitleRateLimitError } from "../ytdlp/execute";
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
        artifacts: [
          {
            key: "cleanTranscriptText",
            label: "clean transcript",
            kind: "file",
            path: "/tmp/transcript.clean.txt",
            primary: true,
          },
        ],
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

test("falls back to Gemini only for a classified YouTube subtitle 429", async () => {
  let generatedUrl = "";
  const result = await executeYtTranscript({
    pi: fakePi(),
    params: { url: "https://www.youtube.com/watch?v=abc123&list=WL" },
    geminiFallback: { apiKey: "test-key", model: "gemini-test" },
    fetchSubtitles: async ({ request }) => {
      throw new YtDlpSubtitleRateLimitError("HTTP Error 429", {
        request,
        metadata: { title: "Fallback Fixture" },
        selectedTrack: { language: "en", source: "auto", ext: "vtt" },
        availability: {
          requestedLanguages: ["en"],
          availableManualLanguages: [],
          availableAutoLanguages: ["en"],
        },
      });
    },
    generateTranscript: async (options) => {
      generatedUrl = options.url;
      return {
        text: "[00:00:01] Generated speech",
        model: options.model ?? "unexpected",
        warnings: [],
        usage: {
          input: 100,
          output: 20,
          cacheRead: 0,
          reasoning: 0,
          totalTokens: 120,
        },
      };
    },
    stageGeneratedArtifacts: async (options) => ({
      contentText: `generated: ${options.model}`,
      details: {
        status: "generated",
        title: options.context.metadata.title,
        originalUrl: options.context.request.url,
        videoId: options.context.metadata.id,
        requestedLanguages: options.context.request.languages,
        provider: "gemini",
        model: options.model,
        previewText: options.transcriptText,
        previewTruncated: false,
        warnings: ["AI-generated transcript"],
        artifacts: [],
      },
    }),
  });

  expect(generatedUrl).toBe("https://www.youtube.com/watch?v=abc123");
  expect(result.content[0]?.text).toBe("generated: gemini-test");
  expect(result.details).toMatchObject({
    status: "generated",
    provider: "gemini",
    model: "gemini-test",
  });
  expect(result.usage).toMatchObject({
    input: 100,
    output: 20,
    totalTokens: 120,
  });
});

test("preserves cancellation that arrives during generated artifact staging", async () => {
  const controller = new AbortController();
  const cancellation = new Error("cancelled during staging");
  let caught: unknown;
  try {
    await executeYtTranscript({
      pi: fakePi(),
      params: { url: "https://www.youtube.com/watch?v=abc123" },
      signal: controller.signal,
      geminiFallback: { apiKey: "test-key", model: "gemini-test" },
      fetchSubtitles: async ({ request }) => {
        throw new YtDlpSubtitleRateLimitError("HTTP Error 429", {
          request,
          metadata: { id: "abc123" },
          selectedTrack: { language: "en", source: "auto" },
          availability: {
            requestedLanguages: ["en"],
            availableManualLanguages: [],
            availableAutoLanguages: ["en"],
          },
        });
      },
      generateTranscript: async () => ({
        text: "Generated speech",
        model: "gemini-test",
        warnings: [],
      }),
      stageGeneratedArtifacts: async (options) => {
        controller.abort(cancellation);
        return {
          contentText: "should not be returned",
          details: {
            status: "generated",
            originalUrl: options.context.request.url,
            requestedLanguages: ["en"],
            provider: "gemini",
            model: options.model,
            previewText: options.transcriptText,
            previewTruncated: false,
            warnings: [],
            artifacts: [],
          },
        };
      },
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBe(cancellation);
});

test("tells the operator to retry after both transcript methods fail", async () => {
  await expect(
    executeYtTranscript({
      pi: fakePi(),
      params: { url: "https://www.youtube.com/watch?v=abc123" },
      geminiFallback: { apiKey: "test-key", model: "gemini-test" },
      fetchSubtitles: async ({ request }) => {
        throw new YtDlpSubtitleRateLimitError("HTTP Error 429", {
          request,
          metadata: { id: "abc123" },
          selectedTrack: { language: "en", source: "auto" },
          availability: {
            requestedLanguages: ["en"],
            availableManualLanguages: [],
            availableAutoLanguages: ["en"],
          },
        });
      },
      generateTranscript: async () => {
        throw new Error("Gemini quota exhausted");
      },
    })
  ).rejects.toThrow(
    "Stop and ask the operator to retry later; do not attempt another transcript fallback."
  );
});

test("preserves the yt-dlp 429 when Gemini fallback is not configured", async () => {
  let generated = false;
  await expect(
    executeYtTranscript({
      pi: fakePi(),
      params: { url: "https://www.youtube.com/watch?v=abc123" },
      geminiFallback: null,
      fetchSubtitles: async ({ request }) => {
        throw new YtDlpSubtitleRateLimitError("HTTP Error 429", {
          request,
          metadata: { id: "abc123" },
          selectedTrack: { language: "en", source: "auto" },
          availability: {
            requestedLanguages: ["en"],
            availableManualLanguages: [],
            availableAutoLanguages: ["en"],
          },
        });
      },
      generateTranscript: async () => {
        generated = true;
        return { text: "unexpected", model: "unexpected", warnings: [] };
      },
    })
  ).rejects.toThrow("set GEMINI_API_KEY to opt in");
  expect(generated).toBe(false);
});

function fakePi(): Pick<ExtensionAPI, "exec"> {
  return {
    async exec() {
      throw new Error("unexpected exec");
    },
  } as Pick<ExtensionAPI, "exec">;
}
