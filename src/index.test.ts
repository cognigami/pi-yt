import { expect, test } from "bun:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import piYtExtension from "./index";

test("registers exactly the transcript MVP tool", () => {
  const tools: Array<{ name: string; label?: string }> = [];
  const api = {
    registerTool(tool: { name: string; label?: string }) {
      tools.push({ name: tool.name, label: tool.label });
    },
  } as unknown as ExtensionAPI;

  piYtExtension(api);

  expect(tools).toEqual([{ name: "yt_transcript", label: "yt-transcript" }]);
});
