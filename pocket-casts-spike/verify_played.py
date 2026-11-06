"""Test one explicitly confirmed played-status write and read it back."""

import argparse
import json
import sys

from probe import (
    ProbeError,
    checked_uuid,
    ordered_entries,
    read_bearer_token,
    read_episode,
    request,
    select_playlist,
)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--playlist", default="Run", help="exact title (default: Run)")
    parser.add_argument("--episode-id", required=True, help="UUID of one unplayed playlist episode")
    args = parser.parse_args()

    try:
        episode_id = checked_uuid(args.episode_id, "--episode-id")
        token = read_bearer_token()
        playlist = select_playlist(token, args.playlist, None)
        entry = dict(ordered_entries(playlist)).get(episode_id)
        if entry is None:
            raise ProbeError("The selected episode is not in that manual playlist")

        before = read_episode(token, episode_id, entry, show_urls=False)
        if before["playing_status"] != 1:
            raise ProbeError(f"Choose an unplayed episode. The selected episode is {before['state']}.")

        print(json.dumps({"playlist": playlist["title"], "before": before}, indent=2))
        print("Type PLAYED to mark only this episode as played.")
        if input().strip() != "PLAYED":
            print("Canceled before the write.")
            return 1

        current = read_episode(token, episode_id, entry, show_urls=False)
        if current != before:
            raise ProbeError("The episode changed while awaiting confirmation. Recheck its state.")

        # Send one request. If its response is lost, read back before deciding what happened.
        try:
            request("/sync/update_episode", token=token, body={
                "uuid": episode_id,
                "podcast": current["podcast_uuid"],
                "status": 3,
            })
        except ProbeError as exc:
            print(f"Write response could not be confirmed. {exc}", file=sys.stderr)

        try:
            after = read_episode(token, episode_id, entry, show_urls=False)
        except ProbeError as exc:
            raise ProbeError(f"Readback failed after the write attempt. Check the app before retrying. {exc}") from None
        print(json.dumps({"after": after}, indent=2))
        if after["playing_status"] != 3:
            raise ProbeError("Readback did not show played. Check the app before retrying.")
        print("Readback verified played. Compare the episode, playlist, and Up Next in the app.")
    except ProbeError as exc:
        print(f"Pocket Casts write test: {exc}", file=sys.stderr)
        return 1
    except (KeyboardInterrupt, EOFError):
        print("Test interrupted. Check the episode in Pocket Casts before retrying.", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
