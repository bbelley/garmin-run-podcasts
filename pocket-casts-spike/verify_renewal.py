"""Verify a renewable Pocket Casts session with two read-only playlist lookups."""

import argparse
import json
import sys
import time

from probe import (
    ProbeError,
    checked_token,
    checked_uuid,
    read_secret,
    request,
    select_playlist,
    token_expiry,
)


SCOPE = "webplayer"


def verify_renewal(email, password, playlist_name):
    login = request("/user/login_pocket_casts", body={
        "email": email,
        "password": password,
        "scope": SCOPE,
    })
    access = checked_token(login.get("accessToken") or login.get("access_token"))
    playlist = select_playlist(access, playlist_name, None)
    playlist_id = checked_uuid(playlist.get("uuid"), "playlist UUID")
    refresh = login.get("refreshToken") or login.get("refresh_token")
    if not refresh:
        raise ProbeError("The playlist read worked, but sign-in returned no refresh token.")
    refresh = checked_token(refresh)

    # Separate the token issue times even when both requests finish within a second.
    time.sleep(1.1)
    renewal = request("/user/token", body={
        "grant_type": "refresh_token",
        "refresh_token": refresh,
        "scope": SCOPE,
    })
    renewed_access = checked_token(renewal.get("accessToken") or renewal.get("access_token"))
    if renewed_access == access:
        raise ProbeError("Refresh returned the same access token. Renewal remains unverified.")
    select_playlist(renewed_access, playlist_name, playlist_id)

    rotated_refresh = renewal.get("refreshToken") or renewal.get("refresh_token")
    return {
        "playlist_read_before_refresh": True,
        "playlist_read_after_refresh": True,
        "refresh_token_rotated": bool(rotated_refresh and checked_token(rotated_refresh) != refresh),
        "renewed_access_token_expiry_hint_utc": token_expiry(renewed_access),
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--playlist", default="Run", help="exact manual playlist title (default: Run)")
    args = parser.parse_args()

    try:
        email = input("Pocket Casts email: ").strip()
        password = read_secret("Pocket Casts password: ")
        if not email or not password:
            raise ProbeError("Enter the email and password for the existing Pocket Casts account.")
        print(json.dumps(verify_renewal(email, password, args.playlist), indent=2))
    except ProbeError as exc:
        print(f"Pocket Casts renewal: {exc}", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("Pocket Casts renewal canceled", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
