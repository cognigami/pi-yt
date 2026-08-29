import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import ytTranscriptTool from "./yt-transcript";

export const ytToolCatalog = [ytTranscriptTool] as const;

export function registerYtTools(pi: ExtensionAPI): void {
  for (const tool of ytToolCatalog) {
    tool.register(pi);
  }
}
