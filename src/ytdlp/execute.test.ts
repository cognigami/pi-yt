import { expect, test } from "bun:test";
import type {
  NormalizedYtTranscriptRequest,
  SelectedSubtitleTrack,
} from "./contracts";
import {
  buildMetadataArgs,
  buildSubtitleDownloadArgs,
  fetchSubtitleWithYtDlp,
  type PiExecResult,
  type YtDlpExecHost,
} from "./execute";

test("metadata command uses fixed safe one-resource arguments", () => {
  expect(buildMetadataArgs("https://example.com/v")).toEqual([
    "--dump-single-json",
    "--skip-download",
    "--no-playlist",
    "--no-warnings",
    "https://example.com/v",
  ]);
});

test("subtitle command disables playlist traversal and never accepts raw args", () => {
  const track: SelectedSubtitleTrack = {
    language: "en",
    source: "auto",
    ext: "vtt",
  };
  expect(buildSubtitleDownloadArgs("https://example.com/v", track)).toEqual([
    "--skip-download",
    "--no-playlist",
    "--no-warnings",
    "--write-auto-subs",
    "--sub-langs",
    "en",
    "--sub-format",
    "vtt",
    "--output",
    "%(id)s.%(ext)s",
    "https://example.com/v",
  ]);
});

test("returns no_subtitles with available language metadata", async () => {
  const calls: Array<{ binary: string; args: string[] }> = [];
  const pi = fakePi(async (binary, args) => {
    calls.push({ binary, args });
    return {
      stdout: JSON.stringify({
        id: "abc",
        title: "No French",
        subtitles: { en: [{ ext: "vtt", url: "manual" }] },
        automatic_captions: { es: [{ ext: "vtt", url: "auto" }] },
      }),
      code: 0,
    };
  });

  const result = await fetchSubtitleWithYtDlp({
    pi,
    request: request({ languages: ["fr"] }),
  });

  expect(result.status).toBe("no_subtitles");
  expect(result.availability).toEqual({
    requestedLanguages: ["fr"],
    availableManualLanguages: ["en"],
    availableAutoLanguages: ["es"],
  });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.args).toContain("--no-playlist");
});

test("missing yt-dlp binary produces an actionable error", async () => {
  const error = new Error("spawn yt-dlp ENOENT") as NodeJS.ErrnoException;
  error.code = "ENOENT";
  await expect(
    fetchSubtitleWithYtDlp({
      pi: fakePi(async () => {
        throw error;
      }),
      request: request(),
    })
  ).rejects.toThrow('Could not execute "yt-dlp"');
});

test("non-zero exits surface stderr without media fallback", async () => {
  await expect(
    fetchSubtitleWithYtDlp({
      pi: fakePi(async () => ({
        stderr: "network unavailable",
        code: 1,
      })),
      request: request(),
    })
  ).rejects.toThrow("network unavailable");
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

function fakePi(
  exec: (binary: string, args: string[]) => Promise<PiExecResult>
): YtDlpExecHost {
  return {
    async exec(binary, args) {
      return await exec(binary, args);
    },
  };
}
