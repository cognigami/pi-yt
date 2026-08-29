import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerYtTools } from "./tools";

/** pi-yt package entrypoint. */
export default function piYtExtension(pi: ExtensionAPI): void {
  registerYtTools(pi);
}
