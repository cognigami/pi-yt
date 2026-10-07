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
  YtDlpSubtitleRateLimitError,
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

test("returns no_subtitles without downloading a translated automatic track", async () => {
  const calls: string[][] = [];
  const result = await fetchSubtitleWithYtDlp({
    pi: fakePi(async (_binary, args) => {
      calls.push(args);
      return {
        stdout: JSON.stringify({
          id: "abc",
          automatic_captions: {
            en: [
              {
                ext: "vtt",
                url: "https://www.youtube.com/api/timedtext?lang=de&tlang=en",
              },
            ],
          },
        }),
        code: 0,
      };
    }),
    request: request({
      url: "https://www.youtube.com/watch?v=abc",
      sourcePreference: "auto_only",
    }),
  });

  expect(result.status).toBe("no_subtitles");
  expect(result.warnings.join("\n")).toContain(
    "translated tracks were skipped"
  );
  expect(calls).toHaveLength(1);
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

test("classifies YouTube automatic-subtitle HTTP 429 for optional fallback", async () => {
  let call = 0;
  let caught: unknown;
  try {
    await fetchSubtitleWithYtDlp({
      pi: fakePi(async () => {
        call += 1;
        if (call === 1) {
          return {
            stdout: JSON.stringify({
              id: "abc123",
              title: "Rate Limited",
              automatic_captions: { en: [{ ext: "vtt", url: "auto" }] },
            }),
            code: 0,
          };
        }
        return {
          stderr:
            "ERROR: Unable to download video subtitles for 'en': HTTP Error 429: Too Many Requests",
          code: 1,
        };
      }),
      request: request({
        url: "https://www.youtube.com/watch?v=abc123",
      }),
    });
  } catch (error) {
    caught = error;
  }

  expect(caught).toBeInstanceOf(YtDlpSubtitleRateLimitError);
  expect((caught as YtDlpSubtitleRateLimitError).context).toMatchObject({
    metadata: { id: "abc123" },
    selectedTrack: { language: "en", source: "auto" },
  });
});

test("does not classify unrelated subtitle failures for provider fallback", async () => {
  const cases = [
    {
      name: "manual YouTube subtitle 429",
      url: "https://www.youtube.com/watch?v=abc123",
      metadata: { subtitles: { en: [{ ext: "vtt", url: "manual" }] } },
      stderr: "HTTP Error 429: Too Many Requests",
    },
    {
      name: "non-YouTube automatic subtitle 429",
      url: "https://example.com/video",
      metadata: {
        automatic_captions: { en: [{ ext: "vtt", url: "auto" }] },
      },
      stderr: "HTTP Error 429: Too Many Requests",
    },
    {
      name: "YouTube automatic subtitle non-429",
      url: "https://www.youtube.com/watch?v=abc123",
      metadata: {
        automatic_captions: { en: [{ ext: "vtt", url: "auto" }] },
      },
      stderr: "HTTP Error 500: Internal Server Error",
    },
  ];

  for (const testCase of cases) {
    let call = 0;
    let caught: unknown;
    try {
      await fetchSubtitleWithYtDlp({
        pi: fakePi(async () => {
          call += 1;
          return call === 1
            ? { stdout: JSON.stringify(testCase.metadata), code: 0 }
            : { stderr: testCase.stderr, code: 1 };
        }),
        request: request({ url: testCase.url }),
      });
    } catch (error) {
      caught = error;
    }
    expect(caught, testCase.name).not.toBeInstanceOf(
      YtDlpSubtitleRateLimitError
    );
  }
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
