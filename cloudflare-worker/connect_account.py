"""Connect Pocket Casts to the configured Worker using hidden local password input."""

import argparse
import json
import sys

from live_ops import PRIVATE, ROOT, OperationError, app, load_config

sys.path.insert(0, str(ROOT / "pocket-casts-spike"))
from probe import ProbeError, checked_token, checked_uuid, read_secret, request, select_playlist


def connect(playlist_name):
    state, secrets = load_config()
    print("Connect Pocket Casts to your PaceJams Worker.")
    print("Your password stays in this process. Renewable session tokens are sent to your Worker.")
    email = input("Pocket Casts email: ").strip()
    password = read_secret("Pocket Casts password: ")
    if not email or not password:
        raise ProbeError("Enter the email and password for your existing Pocket Casts account")
    login = request("/user/login_pocket_casts", body={"email": email, "password": password, "scope": "webplayer"})
    password = None
    access = checked_token(login.get("accessToken") or login.get("access_token"))
    refresh = checked_token(login.get("refreshToken") or login.get("refresh_token"))
    playlist = select_playlist(access, playlist_name, None)
    playlist_id = checked_uuid(playlist.get("uuid"), "playlist UUID")
    # Verify the refresh token before storing the session in the Worker.
    renewal = request("/user/token", body={"grant_type": "refresh_token", "refresh_token": refresh, "scope": "webplayer"})
    access = checked_token(renewal.get("accessToken") or renewal.get("access_token"))
    refresh = checked_token(renewal.get("refreshToken") or renewal.get("refresh_token") or refresh)
    select_playlist(access, playlist_name, playlist_id)
    response = app(state, secrets, "/v1/admin/pocket-casts/session", {
        "accessToken": access, "refreshToken": refresh, "playlistId": playlist_id,
    }, admin=True)
    if response.get("connected") is not True:
        raise OperationError("The Worker did not confirm connection")
    checked = app(state, secrets, "/v1/admin/pocket-casts/check", {}, admin=True)
    if checked.get("connected") is not True:
        raise OperationError("The Worker did not verify its renewable session")
    return {"status": "connected", "playlist_read": True, "session_renewal": True,
            "worker_refresh_and_read": True, "playlist_items": checked["playlist_items"]}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--playlist", default="Run")
    args = parser.parse_args()
    report = PRIVATE / "connect-result.json"
    report.write_text(json.dumps({"status": "waiting_for_local_sign_in"}))
    try:
        result = connect(args.playlist)
        report.write_text(json.dumps(result))
        print("Connected. The Worker can now read the selected playlist and renew its session.")
        return 0
    except (ProbeError, OperationError) as error:
        # Both helpers redact private response bodies and URLs.
        report.write_text(json.dumps({"status": "failed"}))
        print(f"Connection: {error}", file=sys.stderr)
    except (KeyboardInterrupt, EOFError):
        report.write_text(json.dumps({"status": "canceled"}))
        print("Connection canceled.", file=sys.stderr)
    except (OSError, ValueError, KeyError):
        report.write_text(json.dumps({"status": "failed"}))
        print("Connection failed; check the private local configuration.", file=sys.stderr)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
