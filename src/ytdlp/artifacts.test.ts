import { expect, test } from "bun:test";
import { withMemoryExtensionFiles } from "pi-extension-kit/testing";
import {
  buildNoSubtitleToolResult,
  buildPreview,
  stageGeneratedTranscriptArtifacts,
  stageTranscriptArtifacts,
} from "./artifacts";
import type {
  SubtitleFetchNoSubtitles,
  SubtitleFetchSuccess,
} from "./contracts";

test("stages raw transcript, clean transcript, raw subtitle, and metadata artifacts", async () => {
  await withMemoryExtensionFiles({ extensionName: "pi-yt" }, async (files) => {
    const result = await stageTranscriptArtifacts({
      fetch: successFetch(),
      segments: [
        { index: 1, start: 0, end: 1, text: "Hello" },
        { index: 2, start: 2, end: 3, text: "World" },
      ],
      stager: files.createArtifactStager({ toolName: "yt_transcript" }),
    });

    expect(result.details).toMatchObject({
      status: "success",
      title: "Fixture Video",
      selectedLanguage: "en",
      subtitleSource: "manual",
      segmentCount: 2,
      cleanSegmentCount: 1,
      warnings: [],
    });
    expect(result.contentText).toContain("clean transcript:");
    expect(result.contentText).toContain("raw transcript:");
    const artifacts = result.details.artifacts;
    expect(
      await files.readText(artifactPath(artifacts, "transcriptText"))
    ).toBe("[00:00:00] Hello\n[00:00:02] World\n");
    expect(
      await files.readText(artifactPath(artifacts, "transcriptJson"))
    ).toContain('"segments"');
    expect(
      await files.readText(artifactPath(artifacts, "cleanTranscriptText"))
    ).toBe("[00:00:00] Hello World\n");
    expect(
      await files.readText(artifactPath(artifacts, "cleanTranscriptJson"))
    ).toContain('"cleaning"');
    expect(await files.readText(artifactPath(artifacts, "rawSubtitle"))).toBe(
      "WEBVTT\n"
    );
    const metadata = await files.readText(artifactPath(artifacts, "metadata"));
    expect(metadata).toContain('"selectedTrack"');
    expect(metadata).toContain('"transcriptQuality"');
  });
});

test("stages Gemini output as a clearly generated transcript", async () => {
  await withMemoryExtensionFiles({ extensionName: "pi-yt" }, async (files) => {
    const result = await stageGeneratedTranscriptArtifacts({
      context: {
        request: {
          url: "https://www.youtube.com/watch?v=abc",
          languages: ["en"],
          sourcePreference: "manual_then_auto",
          includeTimestamps: true,
          timeoutSec: 30,
        },
        metadata: { id: "abc", title: "Generated Fixture" },
        selectedTrack: { language: "en", source: "auto", ext: "vtt" },
        availability: {
          requestedLanguages: ["en"],
          availableManualLanguages: [],
          availableAutoLanguages: ["en"],
        },
      },
      transcriptText: "[00:00:01] Generated speech",
      model: "gemini-test",
      originalFailure: "HTTP Error 429",
      stager: files.createArtifactStager({ toolName: "yt_transcript" }),
    });

    expect(result.details).toMatchObject({
      status: "generated",
      provider: "gemini",
      model: "gemini-test",
      requestedLanguages: ["en"],
    });
    expect(result.details.warnings.join("\n")).toContain("AI-generated");
    expect(result.contentText).toContain(
      "generated transcript: gemini/gemini-test"
    );
    expect(
      await files.readText(
        artifactPath(result.details.artifacts, "generatedTranscriptText")
      )
    ).toBe("[00:00:01] Generated speech\n");
    const metadata = await files.readText(
      artifactPath(result.details.artifacts, "metadata")
    );
    expect(metadata).toContain('"extractionMethod": "gemini_video"');
    expect(metadata).toContain('"originalYtDlpFailure": "HTTP Error 429"');
  });
});

test("long previews are truncated with a marker", () => {
  const preview = buildPreview("a".repeat(50), 25);
  expect(preview.truncated).toBe(true);
  expect(preview.text).toContain("[truncated]");
});

test("no-subtitle result reports available languages", () => {
  const result = buildNoSubtitleToolResult({
    status: "no_subtitles",
    request: {
      url: "https://example.com/video",
      languages: ["fr"],
      sourcePreference: "manual_then_auto",
      includeTimestamps: true,
      timeoutSec: 30,
    },
    metadata: { id: "abc", title: "No French" },
    availability: {
      requestedLanguages: ["fr"],
      availableManualLanguages: ["en"],
      availableAutoLanguages: ["es"],
    },
    warnings: ["No matching subtitles."],
  } satisfies SubtitleFetchNoSubtitles);

  expect(result.details).toMatchObject({
    status: "no_subtitles",
    requestedLanguages: ["fr"],
    availableManualLanguages: ["en"],
    availableAutoLanguages: ["es"],
  });
  expect(result.content[0]?.text).toContain("available manual languages: en");
});

function artifactPath(
  artifacts: readonly { key: string; kind: string; path?: string }[],
  key: string
): string {
  const artifact = artifacts.find((candidate) => candidate.key === key);
  if (artifact?.kind !== "file" || !artifact.path) {
    throw new Error(`missing file artifact: ${key}`);
  }
  return artifact.path;
}

function successFetch(): SubtitleFetchSuccess {
  return {
    status: "success",
    request: {
      url: "https://example.com/video",
      languages: ["en"],
      sourcePreference: "manual_then_auto",
      includeTimestamps: true,
      timeoutSec: 30,
    },
    metadata: {
      id: "abc",
      title: "Fixture Video",
      original_url: "https://example.com/original",
      webpage_url: "https://example.com/video",
      duration: 3,
    },
    selectedTrack: { language: "en", source: "manual", ext: "vtt" },
    rawSubtitleContent: "WEBVTT",
    rawSubtitleFileName: "en.manual.vtt",
    availability: {
      requestedLanguages: ["en"],
      availableManualLanguages: ["en"],
      availableAutoLanguages: [],
    },
    warnings: [],
  };
}
