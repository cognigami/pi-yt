/** Fixed yt-dlp subprocess boundary for transcript/subtitle retrieval. */
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type {
  NormalizedYtTranscriptRequest,
  SelectedSubtitleTrack,
  SubtitleFetchContext,
  SubtitleFetchResult,
  YtDlpMetadata,
} from "./contracts";
import { buildSubtitleAvailability, selectSubtitleTrack } from "./subtitles";

const YT_DLP_BINARY = "yt-dlp";
const DEFAULT_OUTPUT_TEMPLATE = "%(id)s.%(ext)s";

export interface YtDlpExecHost {
  exec(
    binary: string,
    args: string[],
    options: { cwd: string; signal?: AbortSignal; timeout?: number }
  ): Promise<PiExecResult>;
}

export interface PiExecResult {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  exitCode?: number | null;
  killed?: boolean;
}

export interface FetchSubtitlesOptions {
  pi: YtDlpExecHost;
  request: NormalizedYtTranscriptRequest;
  signal?: AbortSignal;
  mkdirTemp?: typeof mkdtemp;
  readDirectory?: typeof readdir;
  readTextFile?: typeof readFile;
  removeDirectory?: typeof rm;
}

interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  killed?: boolean;
}

export async function fetchSubtitleWithYtDlp(
  options: FetchSubtitlesOptions
): Promise<SubtitleFetchResult> {
  const mkdirTemp = options.mkdirTemp ?? mkdtemp;
  const readDirectory = options.readDirectory ?? readdir;
  const readTextFile = options.readTextFile ?? readFile;
  const removeDirectory = options.removeDirectory ?? rm;
  const workDir = await mkdirTemp(join(tmpdir(), "pi-yt-"));

  try {
    const metadataResult = await runYtDlpCommand({
      pi: options.pi,
      args: buildMetadataArgs(options.request.url),
      cwd: workDir,
      signal: options.signal,
      timeoutMs: options.request.timeoutSec * 1000,
    });
    const metadata = parseMetadata(metadataResult.stdout);
    const availability = buildSubtitleAvailability(
      metadata,
      options.request.languages
    );
    const selectedTrack = selectSubtitleTrack(metadata, options.request);
    if (!selectedTrack) {
      return {
        status: "no_subtitles",
        request: options.request,
        metadata,
        availability,
        warnings: [
          `No ${options.request.sourcePreference} subtitles found for requested languages: ${options.request.languages.join(", ")}.`,
        ],
      };
    }

    try {
      await runYtDlpCommand({
        pi: options.pi,
        args: buildSubtitleDownloadArgs(options.request.url, selectedTrack),
        cwd: workDir,
        signal: options.signal,
        timeoutMs: options.request.timeoutSec * 1000,
      });
    } catch (error) {
      if (
        selectedTrack.source === "auto" &&
        isYouTubeUrl(options.request.url) &&
        isHttp429Error(error)
      ) {
        const message = error instanceof Error ? error.message : String(error);
        throw new YtDlpSubtitleRateLimitError(message, {
          request: options.request,
          metadata,
          selectedTrack,
          availability,
        });
      }
      throw error;
    }

    const subtitlePath = await findSubtitleFile(workDir, readDirectory);
    if (!subtitlePath) {
      throw new YtDlpExecutionError(
        "yt-dlp completed without producing a subtitle file. No media fallback was attempted."
      );
    }
    const rawSubtitleContent = await readTextFile(subtitlePath, "utf8");

    return {
      status: "success",
      request: options.request,
      metadata,
      selectedTrack,
      rawSubtitleContent: String(rawSubtitleContent),
      rawSubtitleFileName: safeSubtitleFileName(
        basename(subtitlePath),
        selectedTrack
      ),
      availability,
      warnings: [],
    };
  } finally {
    await removeDirectory(workDir, { recursive: true, force: true });
  }
}

export function buildMetadataArgs(url: string): string[] {
  return [
    "--dump-single-json",
    "--skip-download",
    "--no-playlist",
    "--no-warnings",
    url,
  ];
}

export function buildSubtitleDownloadArgs(
  url: string,
  selectedTrack: SelectedSubtitleTrack
): string[] {
  return [
    "--skip-download",
    "--no-playlist",
    "--no-warnings",
    selectedTrack.source === "manual" ? "--write-subs" : "--write-auto-subs",
    "--sub-langs",
    selectedTrack.language,
    "--sub-format",
    "vtt",
    "--output",
    DEFAULT_OUTPUT_TEMPLATE,
    url,
  ];
}

export class YtDlpExecutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "YtDlpExecutionError";
  }
}

export class YtDlpSubtitleRateLimitError extends YtDlpExecutionError {
  constructor(
    message: string,
    readonly context: SubtitleFetchContext
  ) {
    super(message);
    this.name = "YtDlpSubtitleRateLimitError";
  }
}

async function runYtDlpCommand(options: {
  pi: YtDlpExecHost;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeoutMs: number;
}): Promise<CommandResult> {
  let result: PiExecResult;
  try {
    result = await options.pi.exec(YT_DLP_BINARY, options.args, {
      cwd: options.cwd,
      signal: options.signal,
      timeout: options.timeoutMs,
    });
  } catch (error) {
    throw normalizeSpawnError(error, options.args, options.timeoutMs);
  }

  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  const exitCode = result.code ?? result.exitCode ?? null;
  if (result.killed || exitCode !== 0) {
    throw new YtDlpExecutionError(
      formatCommandFailure({
        args: options.args,
        exitCode,
        killed: result.killed,
        stdout,
        stderr,
        timeoutMs: options.timeoutMs,
      })
    );
  }
  return { stdout, stderr, exitCode, killed: result.killed };
}

function parseMetadata(stdout: string): YtDlpMetadata {
  const trimmed = stdout.trim();
  if (trimmed === "") {
    throw new YtDlpExecutionError("yt-dlp returned empty metadata output.");
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      throw new Error("metadata JSON was not an object");
    }
    return parsed as YtDlpMetadata;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new YtDlpExecutionError(
      `Could not parse yt-dlp metadata JSON: ${message}`
    );
  }
}

async function findSubtitleFile(
  directory: string,
  readDirectory: typeof readdir
): Promise<string | undefined> {
  const entries = await readDirectory(directory, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(directory, entry.name))
    .sort();
  return (
    files.find((file) => file.toLowerCase().endsWith(".vtt")) ??
    files.find((file) => /\.(srt|ttml|srv\d?|json3)$/iu.test(file))
  );
}

function normalizeSpawnError(
  error: unknown,
  args: readonly string[],
  timeoutMs: number
): YtDlpExecutionError {
  const message = error instanceof Error ? error.message : String(error);
  if (isMissingBinaryError(error, message)) {
    return new YtDlpExecutionError(
      'Could not execute "yt-dlp". Install yt-dlp and ensure it is available on PATH.'
    );
  }
  if (isTimeoutError(error, message)) {
    return new YtDlpExecutionError(
      `${formatCommand(args)} timed out after ${timeoutMs}ms.`
    );
  }
  return new YtDlpExecutionError(
    `${formatCommand(args)} failed to start: ${message}`
  );
}

function formatCommandFailure(options: {
  args: readonly string[];
  exitCode: number | null;
  killed?: boolean;
  stdout: string;
  stderr: string;
  timeoutMs: number;
}): string {
  if (options.killed) {
    return `${formatCommand(options.args)} timed out or was killed after ${options.timeoutMs}ms.`;
  }
  const lines = [
    `${formatCommand(options.args)} exited with code ${options.exitCode ?? "unknown"}.`,
  ];
  const stdout = compactOutput(options.stdout);
  const stderr = compactOutput(options.stderr);
  if (stderr) lines.push(`stderr: ${stderr}`);
  if (stdout) lines.push(`stdout: ${stdout}`);
  if (!stderr && !stdout) {
    lines.push("No media fallback or playlist traversal was attempted.");
  }
  return lines.join("\n");
}

function compactOutput(text: string): string | undefined {
  const normalized = text.replace(/\s+/gu, " ").trim();
  if (normalized === "") return undefined;
  return normalized.length > 500
    ? `${normalized.slice(0, 497)}...`
    : normalized;
}

function formatCommand(args: readonly string[]): string {
  return [YT_DLP_BINARY, ...args].join(" ");
}

function isHttp429Error(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /HTTP (?:Error )?429|Too Many Requests/iu.test(message);
}

function isYouTubeUrl(input: string): boolean {
  try {
    const hostname = new URL(input).hostname.toLowerCase();
    return (
      hostname === "youtu.be" ||
      hostname === "youtube.com" ||
      hostname.endsWith(".youtube.com")
    );
  } catch {
    return false;
  }
}

function isMissingBinaryError(error: unknown, message: string): boolean {
  return (
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: unknown }).code === "ENOENT") ||
    /ENOENT|not found|no such file/i.test(message)
  );
}

function isTimeoutError(error: unknown, message: string): boolean {
  return (
    (typeof error === "object" &&
      error !== null &&
      "name" in error &&
      String((error as { name?: unknown }).name)
        .toLowerCase()
        .includes("timeout")) ||
    /timed?\s*out|timeout/i.test(message)
  );
}

function safeSubtitleFileName(
  actualFileName: string,
  selectedTrack: SelectedSubtitleTrack
): string {
  const extension = actualFileName.match(/\.([a-z0-9]+)$/iu)?.[1] ?? "vtt";
  return `${selectedTrack.language}.${selectedTrack.source}.${extension}`.replace(
    /[^a-z0-9._-]+/giu,
    "_"
  );
}
