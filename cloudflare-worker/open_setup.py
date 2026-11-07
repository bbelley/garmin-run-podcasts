"""Open a single-use private setup link without exposing the admin credential."""

import webbrowser
import re

from live_ops import OperationError, app, load_config


def main():
    try:
        state, secrets = load_config()
        ticket = app(state, secrets, "/v1/admin/setup-links", {}, admin=True)
        code = ticket["code"]
        if not isinstance(code, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}\.[a-f0-9]{64}", code):
            raise OperationError("The Worker did not return a valid setup link")
        if not webbrowser.open(state["public_origin"] + "/setup#code=" + code, new=2):
            raise OperationError("The default browser could not be opened")
        print("Opened a private PaceJams setup link. It works once and expires after five minutes.")
    except (OperationError, OSError, ValueError, KeyError):
        print("Could not open setup. Check the private configuration and Worker connection.")
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
