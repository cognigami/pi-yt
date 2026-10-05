import { expect, test } from "bun:test";
import {
  buildGeminiTranscriptPrompt,
  generateGeminiTranscript,
  loadGeminiFallbackConfig,
} from "./execute";

test("loads an explicitly configured Gemini fallback", () => {
  expect(
    loadGeminiFallbackConfig({
      GEMINI_API_KEY: " secret ",
      PI_YT_GEMINI_MODEL: "gemini-test",
    })
  ).toEqual({ apiKey: "secret", model: "gemini-test" });
  expect(loadGeminiFallbackConfig({})).toBeUndefined();
  expect(loadGeminiFallbackConfig({ GEMINI_API_KEY: "secret" })).toEqual({
    apiKey: "secret",
    model: "gemini-2.5-flash",
  });
});

test("requests Gemini video understanding without putting the key in the URL", async () => {
  let requestedUrl = "";
  let requestedInit: RequestInit | undefined;
  const result = await generateGeminiTranscript({
    apiKey: "test-secret",
    model: "gemini-test",
    url: "https://www.youtube.com/watch?v=abc123",
    languages: ["en", "es"],
    includeTimestamps: true,
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      requestedInit = init;
      return Response.json({
        candidates: [{ content: { parts: [{ text: "[00:00:01] Hello" }] } }],
        usageMetadata: {
          promptTokenCount: 100,
          candidatesTokenCount: 20,
          totalTokenCount: 120,
        },
      });
    },
  });

  expect(result).toEqual({
    text: "[00:00:01] Hello",
    model: "gemini-test",
    warnings: [],
    usage: {
      input: 100,
      output: 20,
      cacheRead: 0,
      reasoning: 0,
      totalTokens: 120,
    },
  });
  expect(requestedUrl).toBe(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-test:generateContent"
  );
  expect(requestedUrl).not.toContain("test-secret");
  expect(new Headers(requestedInit?.headers).get("x-goog-api-key")).toBe(
    "test-secret"
  );
  const body = JSON.parse(String(requestedInit?.body)) as {
    contents: Array<{ parts: Array<Record<string, unknown>> }>;
  };
  expect(body.contents[0]?.parts[0]).toEqual({
    fileData: { fileUri: "https://www.youtube.com/watch?v=abc123" },
  });
  expect(body.contents[0]?.parts[1]).toMatchObject({
    text: expect.stringContaining("complete spoken transcript"),
  });
});

test("warns when Gemini returns a potentially incomplete transcript", async () => {
  const result = await generateGeminiTranscript({
    apiKey: "test-secret",
    url: "https://www.youtube.com/watch?v=abc123",
    languages: ["en"],
    includeTimestamps: true,
    fetchImpl: async () =>
      Response.json({
        candidates: [
          {
            content: { parts: [{ text: "Partial transcript" }] },
            finishReason: "MAX_TOKENS",
          },
        ],
      }),
  });

  expect(result.warnings.join("\n")).toContain("MAX_TOKENS");
});

test("preserves caller cancellation instead of wrapping it as a provider failure", async () => {
  const controller = new AbortController();
  const cancellation = new Error("cancelled by caller");
  controller.abort(cancellation);
  let caught: unknown;
  try {
    await generateGeminiTranscript({
      apiKey: "test-secret",
      url: "https://www.youtube.com/watch?v=abc123",
      languages: ["en"],
      includeTimestamps: true,
      signal: controller.signal,
      fetchImpl: async () => {
        throw cancellation;
      },
    });
  } catch (error) {
    caught = error;
  }
  expect(caught).toBe(cancellation);
});

test("surfaces bounded Gemini API errors and redacts the API key", async () => {
  await expect(
    generateGeminiTranscript({
      apiKey: "test-secret",
      url: "https://www.youtube.com/watch?v=abc123",
      languages: ["en"],
      includeTimestamps: false,
      fetchImpl: async () =>
        new Response("request rejected for test-secret", { status: 429 }),
    })
  ).rejects.toThrow(
    "Gemini API returned HTTP 429: request rejected for [REDACTED]"
  );
});

test("prompt distinguishes timestamped and untimestamped transcripts", () => {
  expect(buildGeminiTranscriptPrompt(["en"], true)).toContain("[HH:MM:SS]");
  expect(buildGeminiTranscriptPrompt(["en"], false)).toContain(
    "Do not add timestamps"
  );
});
