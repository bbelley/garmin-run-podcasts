"""Turn the ignored live manifest into a private, network-free Monkey C test."""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def literal(value):
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, int):
        return str(value) + ("l" if value > 2147483647 else "")
    if isinstance(value, float):
        return json.dumps(value, allow_nan=False)
    if isinstance(value, list):
        return "[" + ",".join(literal(item) for item in value) + "]"
    if isinstance(value, dict):
        return "{" + ",".join(literal(key) + "=>" + literal(item) for key, item in value.items()) + "}"
    raise ValueError("Unsupported contract value")


def main():
    manifest = json.loads((ROOT / ".spike-tools/cloudflare/manifest.json").read_text())
    if manifest.get("acknowledged_event_ids"):
        raise ValueError("Refresh the manifest without sending completion events first")
    directory = ROOT / "garmin-spike/bin/private-tests"
    directory.mkdir(parents=True, exist_ok=True)
    source = """using Toybox.Test;
using Toybox.Lang;
(:test)
function queueAcceptsLiveWorkerManifest(logger as Test.Logger) as Lang.Boolean {
    var response = """ + literal(manifest) + """;
    Test.assert(queueValidResponse(response, []));
    return true;
}
"""
    (directory / "LiveContractTest.mc").write_text(source, encoding="utf-8")
    print("Prepared the ignored live manifest fixture. This test makes no network requests.")


if __name__ == "__main__":
    main()
