"""Read a manual Pocket Casts playlist and its episode details. Python 3.10+."""

import argparse
import base64
from datetime import datetime, timezone
import getpass
import json
import os
import sys
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlsplit
from urllib.request import HTTPRedirectHandler, Request, build_opener
import uuid
import warnings


API = "https://api.pocketcasts.com"
STATUSES = {1: "unplayed", 2: "in progress", 3: "played"}


class ProbeError(Exception):
    pass


class NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never let an API bearer token or login body follow a redirect.
        return None


def request(path, *, token=None, body=None):
    headers = {"Accept": "application/json"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    if body is not None:
        headers["Content-Type"] = "application/json"
    data = None if body is None else json.dumps(body).encode("utf-8")
    try:
        with build_opener(NoRedirect()).open(Request(API + path, data, headers), timeout=20) as response:
            result = json.load(response)
    except HTTPError as exc:
        hint = ""
        if exc.code in (401, 403):
            hint = " (authentication rejected or access restricted)"
        elif exc.code == 429:
            hint = " (rate limited, retry later)"
        raise ProbeError(f"{path} returned HTTP {exc.code}{hint}") from None
    except (URLError, OSError):
        raise ProbeError(f"{path} connection failed") from None
    except (ValueError, UnicodeError):
        raise ProbeError(f"{path} did not return valid JSON") from None
    if not isinstance(result, dict):
        raise ProbeError(f"{path} returned an unexpected JSON type")
    return result


def read_secret(prompt):
    with warnings.catch_warnings():
        warnings.simplefilter("error", getpass.GetPassWarning)
        try:
            return getpass.getpass(prompt).strip()
        except (getpass.GetPassWarning, EOFError, OSError):
            raise ProbeError("Run the probe from an interactive terminal for hidden input") from None


def checked_token(token):
    if not isinstance(token, str) or not token or any(c.isspace() for c in token):
        raise ProbeError("Supply just the bearer token, without the 'Bearer ' prefix")
    return token


def read_bearer_token():
    return checked_token(os.environ.get("POCKET_CASTS_TOKEN") or read_secret("Pocket Casts bearer token: "))


def token_expiry(token):
    """Report the unverified expiry hint if this token happens to be a JWT."""
    try:
        _, payload, _ = token.split(".")
        claims = json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))
        return datetime.fromtimestamp(claims["exp"], timezone.utc).isoformat()
    except (ValueError, KeyError, TypeError, OverflowError, OSError):
        return None


def checked_uuid(value, field):
    if isinstance(value, str):
        try:
            return str(uuid.UUID(value))
        except ValueError:
            pass
    raise ProbeError(f"Missing or invalid {field}")


def ordered_entries(playlist):
    entries = playlist.get("episodes")
    order = playlist.get("episodeOrder")
    if not isinstance(entries, list) or not isinstance(order, list):
        raise ProbeError("Expected arrays for episodes and episodeOrder")

    by_uuid = {}
    for entry in entries:
        if not isinstance(entry, dict):
            raise ProbeError("Expected a playlist episode object")
        episode_id = checked_uuid(entry.get("episode"), "playlist episode UUID")
        if episode_id in by_uuid:
            raise ProbeError("Duplicate episode in playlist episodes")
        by_uuid[episode_id] = entry

    ids = [checked_uuid(value, "episodeOrder UUID") for value in order]
    if len(ids) != len(by_uuid) or set(ids) != set(by_uuid):
        raise ProbeError("Playlist episodes and episodeOrder differ. Compare with the app before inferring order.")
    return [(episode_id, by_uuid[episode_id]) for episode_id in ids]


def select_playlist(token, name, playlist_id):
    result = request("/user/playlists", token=token)
    playlists = result.get("playlists")
    if not isinstance(playlists, list) or any(not isinstance(p, dict) for p in playlists):
        raise ProbeError("Expected a playlists array of objects from /user/playlists")
    selected = [
        p for p in playlists if p.get("manual") and not p.get("isDeleted")
        and (p.get("uuid") == playlist_id if playlist_id else p.get("title") == name)
    ]
    if not selected:
        raise ProbeError("No matching manual playlist. Check its name and that the app has synced.")
    if len(selected) > 1:
        ids = [checked_uuid(p.get("uuid"), "playlist UUID") for p in selected]
        raise ProbeError(f"Multiple matching playlists. Run again with --playlist-id from {', '.join(ids)}")
    return selected[0]


def read_episode(token, episode_id, entry, show_urls):
    # POST is a read here. Send only the UUID, with no progress or status fields.
    detail = request("/user/episode", token=token, body={"uuid": episode_id})
    if checked_uuid(detail.get("uuid"), "detail episode UUID") != episode_id:
        raise ProbeError("Episode detail returned a different UUID")
    podcast_id = checked_uuid(detail.get("podcastUuid") or entry.get("podcast"), "podcast UUID")
    if entry.get("podcast") and checked_uuid(entry["podcast"], "playlist podcast UUID") != podcast_id:
        raise ProbeError("Episode detail and playlist disagree on the podcast UUID")

    status = detail.get("playingStatus")
    if type(status) is not int or status not in STATUSES:
        raise ProbeError("Episode detail has a missing or unknown playingStatus")
    url = detail.get("url") or entry.get("url")
    try:
        enclosure = urlsplit(url) if isinstance(url, str) else None
        if not enclosure or enclosure.scheme not in ("https", "http") or not enclosure.hostname:
            raise ValueError
    except ValueError:
        raise ProbeError("Episode has no usable enclosure URL") from None

    row = {
        "episode_uuid": episode_id,
        "podcast_uuid": podcast_id,
        "title": detail.get("title") or entry.get("title"),
        "playing_status": status,
        "state": STATUSES[status],
        "played_up_to_seconds": detail.get("playedUpTo"),
        "duration_seconds": detail.get("duration"),
        "enclosure_scheme": enclosure.scheme,
    }
    if show_urls:
        row["enclosure_url"] = url
    return row


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--playlist", default="Run", help="exact title (default: Run)")
    parser.add_argument("--playlist-id", help="select a manual playlist by UUID")
    parser.add_argument("--login", action="store_true", help="prompt for email and password instead of a bearer token")
    parser.add_argument("--show-urls", action="store_true", help="print full enclosure URLs in local output")
    args = parser.parse_args()

    try:
        playlist_id = checked_uuid(args.playlist_id, "--playlist-id") if args.playlist_id else None
        if args.login:
            email = input("Pocket Casts email: ").strip()
            password = read_secret("Pocket Casts password: ")
            token = request("/user/login", body={"email": email, "password": password}).get("token")
            token = checked_token(token)
        else:
            token = read_bearer_token()

        playlist = select_playlist(token, args.playlist, playlist_id)
        ordered = ordered_entries(playlist)
        episodes = []
        for position, (episode_id, entry) in enumerate(ordered, 1):
            time.sleep(0.25)
            try:
                row = read_episode(token, episode_id, entry, args.show_urls)
            except ProbeError as exc:
                raise ProbeError(f"Episode at playlist position {position}: {exc}") from None
            episodes.append({"position": position, **row})
        print(json.dumps({
            "playlist_uuid": checked_uuid(playlist.get("uuid"), "playlist UUID"),
            "playlist_title": playlist.get("title"),
            "token_expiry_hint_utc": token_expiry(token),
            "episodes": episodes,
        }, indent=2))
    except ProbeError as exc:
        print(f"Pocket Casts probe: {exc}", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("Pocket Casts probe canceled", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
