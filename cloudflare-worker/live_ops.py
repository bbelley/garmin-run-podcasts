"""Operate the existing Worker using ignored local configuration. Python 3.11+."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import tomllib
from urllib.error import HTTPError, URLError
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parent.parent
PRIVATE = ROOT / ".spike-tools/cloudflare"


class OperationError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def exchange(url, *, method=None, data=None, token=None, content_type=None, headers=None):
    headers = {"Accept": "application/json", "User-Agent": "PaceJams integration check", **(headers or {})}
    if token:
        headers["Authorization"] = "Bearer " + token
    if content_type:
        headers["Content-Type"] = content_type
    request = Request(url, data=data, headers=headers, method=method)
    try:
        return build_opener(NoRedirect()).open(request, timeout=90)
    except HTTPError as error:
        # The body and URL can contain private account or media information.
        raise OperationError(f"HTTP {error.code}") from None
    except (URLError, OSError):
        raise OperationError("Connection failed") from None


def load_config():
    state = json.loads((PRIVATE / "current.json").read_text())
    secrets = json.loads((PRIVATE / "secrets.json").read_text())
    if not state["public_origin"].startswith("https://"):
        raise OperationError("A canonical HTTPS origin is required")
    return state, secrets


def cf_token():
    path = Path(os.environ["APPDATA"]) / "xdg.config/.wrangler/config/default.toml"
    return tomllib.loads(path.read_text())["oauth_token"]


def cf(state, path, body=None, *, method=None, content_type=None):
    data = body if isinstance(body, bytes) else None if body is None else json.dumps(body).encode()
    url = "https://api.cloudflare.com/client/v4/accounts/" + state["account_id"] + path
    with exchange(url, method=method, data=data, token=cf_token(),
                  content_type=content_type or ("application/json" if data is not None else None)) as response:
        result = json.load(response)
    if not result.get("success"):
        raise OperationError("Cloudflare rejected the operation")
    return result["result"]


def script_path(state):
    return "/workers/scripts/" + state["worker_name"]


def versions(state):
    return cf(state, script_path(state) + "/deployments")["deployments"][0]["versions"]


def feed_url(state):
    source = (PRIVATE / "generated/legacy.mjs").read_text()
    match = re.search(r'var FEED_PATH = "([^"\\]+)";', source)
    if not match:
        raise OperationError("Review the saved feed configuration")
    return state["public_origin"] + "/" + match[1] + "/feed.xml"


def feed_snapshot(state):
    with exchange(feed_url(state)) as response:
        body = response.read(2097152)
    parsed = ET.fromstring(body)
    items = parsed.findall("./channel/item")
    return body, items


def save(name, data):
    (PRIVATE / name).write_text(json.dumps(data, indent=2))


def baseline(state):
    path = PRIVATE / "feed-baseline.json"
    if path.exists():
        raise OperationError("Baseline already exists; review it before replacing it")
    body, items = feed_snapshot(state)
    (PRIVATE / "feed-baseline.xml").write_bytes(body)
    save("feed-baseline.json", {"sha256": hashlib.sha256(body).hexdigest(),
                               "items": len(items), "versions": versions(state)})
    print("Saved the existing feed and active version before deployment.")


def deploy(state, secrets, bundle):
    baseline_data = json.loads((PRIVATE / "feed-baseline.json").read_text())
    previous = PRIVATE / "deployment.json"
    expected = json.loads(previous.read_text())["versions"] if previous.exists() else baseline_data["versions"]
    if versions(state) != expected:
        raise OperationError("The live Worker changed; take a new reviewed backup before deploying")
    settings = json.loads((ROOT / state["backup_dir"] / "settings.json").read_text())["result"]
    if any(binding["type"] != "r2_bucket" for binding in settings["bindings"]):
        raise OperationError("Review additional legacy bindings before deployment")
    bindings = settings["bindings"] + [{"type": "d1", "name": "PACEJAMS_DB", "database_id": state["database_id"]}]
    bindings += [{"type": "secret_text", "name": name, "text": value} for name, value in secrets.items()]
    bindings.append({"type": "plain_text", "name": "POCKET_CASTS_WRITEBACK_ENABLED", "text": "false"})
    metadata = {key: settings[key] for key in ("compatibility_date", "compatibility_flags", "usage_model",
                "tags", "tail_consumers", "logpush", "observability") if key in settings}
    if settings.get("placement", {}).get("mode"):
        metadata["placement"] = settings["placement"]
    metadata.update(main_module="entry.js", bindings=bindings)
    boundary = "pacejams-" + uuid.uuid4().hex
    body = (f'--{boundary}\r\nContent-Disposition: form-data; name="metadata"\r\n'
            'Content-Type: application/json\r\n\r\n').encode() + json.dumps(metadata).encode()
    body += (f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="entry.js"; filename="entry.js"\r\n'
             'Content-Type: application/javascript+module\r\n\r\n').encode() + bundle.read_bytes()
    body += f"\r\n--{boundary}--\r\n".encode()
    cf(state, script_path(state), body, method="PUT", content_type="multipart/form-data; boundary=" + boundary)
    save("deployment.json", {"previous_versions": expected, "versions": versions(state),
                             "bundle_sha256": hashlib.sha256(bundle.read_bytes()).hexdigest()})
    print("Deployed the integration to the existing Worker with its existing R2 binding.")


def app(state, secrets, path, body=None, *, admin=False, authenticate=True):
    token = secrets["PACEJAMS_ADMIN_TOKEN" if admin else "PACEJAMS_WATCH_TOKEN"] if authenticate else None
    with exchange(state["public_origin"] + path, data=None if body is None else json.dumps(body).encode(),
                  token=token, content_type="application/json" if body is not None else None) as response:
        return json.load(response)


def sync_input(events=None):
    # Simulated capacity is only for server verification, never a watch measurement.
    return {"protocol_version": 1, "events": events or [], "downloads": [],
            "storage": {"capacityBytes": 1073741824, "usedBytes": 0,
                        "budgetBytes": 536870912, "reserveBytes": 67108864}}


def expect_http(code, function):
    try:
        function()
    except OperationError as error:
        if str(error) == f"HTTP {code}":
            return
        raise
    raise OperationError("An authorization or conflict check unexpectedly succeeded")


def verify(state, secrets):
    body, items = feed_snapshot(state)
    old = json.loads((PRIVATE / "feed-baseline.json").read_text())
    if hashlib.sha256(body).hexdigest() != old["sha256"]:
        raise OperationError("The existing RSS differs from the saved baseline; review before proceeding")
    health = app(state, secrets, "/v1/health", authenticate=False)
    if health.get("protocol_version") != 1:
        raise OperationError("Unexpected health response")
    expect_http(401, lambda: app(state, secrets, "/v1/watch/sync", sync_input(), authenticate=False))
    expect_http(401, lambda: app(state, secrets, "/v1/admin/status"))
    first = app(state, secrets, "/v1/watch/sync", sync_input())
    second = app(state, secrets, "/v1/watch/sync", sync_input())
    if first["sources"]["uploads_stale"] or second["sources"]["uploads_stale"]:
        raise OperationError("The R2 source failed to refresh")
    if [item["id"] for item in first["queue"]["items"]] != [item["id"] for item in second["queue"]["items"]]:
        raise OperationError("Queue identity changed between requests")
    if items:
        url = items[0].find("enclosure").attrib["url"]
        with exchange(url, headers={"Range": "bytes=0-1023"}) as response:
            if response.status != 206 or len(response.read(1024)) != 1024:
                raise OperationError("Existing audio range playback failed")
    report = {"rss_unchanged": True, "rss_items": len(items), "audio_range": bool(items),
              "watch_auth": True, "admin_separation": True, "stable_queue": True,
              "queue_items": len(first["queue"]["items"]), "sources": second["sources"],
              "pocket_casts_connection": second["pocket_casts_connection"]}
    save("live-verification.json", report)
    # Save private manifests for inspection without exposing titles or audio URLs in logs.
    save("manifest.json", second)
    print(json.dumps(report))


def d1(state, sql, params=None):
    return cf(state, "/d1/database/" + state["database_id"] + "/query", {"sql": sql, "params": params or []})


def ledger_test(state, secrets):
    # A synthetic, unmapped personal item cannot mark a real account episode played.
    event_id = "integration-" + uuid.uuid4().hex
    item_id = "pj_" + hashlib.sha256(event_id.encode()).hexdigest()
    payload = {"id": item_id, "aliases": [item_id], "source": "upload", "title": "Integration fixture",
               "audioUrl": "https://audio.example.com/fixture.mp3", "sizeBytes": 1,
               "durationSeconds": 1, "played": False, "pocketCasts": None}
    d1(state, "INSERT INTO catalog_items(id,canonical_id,payload_json) VALUES(?,?,?)",
       [item_id, item_id, json.dumps(payload)])
    try:
        event = {"event_id": event_id, "item_id": item_id, "reason": "natural_end", "occurred_at": 100}
        first = app(state, secrets, "/v1/watch/sync", sync_input([event]))
        second = app(state, secrets, "/v1/watch/sync", sync_input([event]))
        if first["acknowledged_event_ids"] != [event_id] or second["acknowledged_event_ids"] != [event_id]:
            raise OperationError("Durable replay acknowledgement failed")
        event["occurred_at"] = 101
        expect_http(409, lambda: app(state, secrets, "/v1/watch/sync", sync_input([event])))
        count = d1(state, "SELECT COUNT(*) AS n FROM watch_events WHERE event_id=?", [event_id])[0]["results"][0]["n"]
        if count != 1:
            raise OperationError("Duplicate event persistence failed")
        save("live-ledger-verification.json", {"durable_ack": True, "replay": True, "conflict": True, "one_event": True})
        print("Live D1: durable acknowledgement, replay, conflict rejection, and single-event persistence passed.")
    finally:
        # Only remove the randomly named fixture created by this invocation.
        d1(state, "DELETE FROM completions WHERE item_id=?", [item_id])
        d1(state, "DELETE FROM watch_events WHERE event_id=? AND item_id=?", [event_id, item_id])
        d1(state, "DELETE FROM catalog_items WHERE id=?", [item_id])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["baseline", "deploy", "verify", "ledger-test"])
    parser.add_argument("--bundle", type=Path, default=PRIVATE / "bundle/entry.js")
    args = parser.parse_args()
    try:
        state, secrets = load_config()
        if args.action == "baseline":
            baseline(state)
        elif args.action == "deploy":
            deploy(state, secrets, args.bundle)
        elif args.action == "verify":
            verify(state, secrets)
        else:
            ledger_test(state, secrets)
    except OperationError as error:
        print(f"Cloudflare operation: {error}.", file=sys.stderr)
        return 1
    except (OSError, ValueError, KeyError):
        print("Cloudflare operation failed. Review the private configuration and connection; no private response was logged.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
