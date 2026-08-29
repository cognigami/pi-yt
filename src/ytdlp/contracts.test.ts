import { expect, test } from "bun:test";
import { normalizeVideoUrl, normalizeYtTranscriptRequest } from "./contracts";

test("normalizes default transcript request contract", () => {
  expect(
    normalizeYtTranscriptRequest({ url: " https://example.com/watch?v=1 " })
  ).toEqual({
    url: "https://example.com/watch?v=1",
    languages: ["en"],
    sourcePreference: "manual_then_auto",
    includeTimestamps: true,
    timeoutSec: 30,
  });
});

test("rejects malformed URLs and unsupported schemes", () => {
  expect(() => normalizeVideoUrl("not a url")).toThrow("Malformed URL");
  expect(() => normalizeVideoUrl("ftp://example.com/video")).toThrow(
    "Unsupported URL scheme: ftp:"
  );
});

test("rejects empty languages and invalid timeouts", () => {
  expect(() =>
    normalizeYtTranscriptRequest({ url: "https://example.com", languages: [] })
  ).toThrow("At least one subtitle language");
  expect(() =>
    normalizeYtTranscriptRequest({ url: "https://example.com", timeoutSec: 0 })
  ).toThrow("timeoutSec must be an integer");
});
