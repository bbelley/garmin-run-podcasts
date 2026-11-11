// Build-time only: preserve the encoder's license and serve its browser distribution locally.
import { readFileSync } from "node:fs";

export function qrScriptSource() {
    return readFileSync(new URL("qrcode.js", import.meta.resolve("qrcode-generator")), "utf8");
}
