# Pocket Casts account probe

1. In Pocket Casts, create a manual playlist called **Run**, add two or three recognizable episodes, and note the displayed order and played state. Wait for it to sync. [Pocket Casts playlists](https://support.pocketcasts.com/knowledge-base/playlists/)
2. In an interactive terminal, run the following from the repo root. It uses Python 3.10+ and the standard library. The password prompt hides input and the script keeps the resulting token in memory.

   ```powershell
   python .\pocket-casts-spike\probe.py --login
   ```

   If you already use the Pocket Casts web player, the other option is to copy the bearer token from a successful `api.pocketcasts.com` request in DevTools **Network → Headers**. Paste only the value after `Bearer` at the hidden prompt. The probe also accepts `POCKET_CASTS_TOKEN` from a local secret-injection setup. Keep credentials and tokens out of chat, shell commands, and files in the repo.

   ```powershell
   python .\pocket-casts-spike\probe.py
   ```

3. Compare the resulting `episodes` list against **Run**. The probe joins the playlist's `episodes` to `episodeOrder`, then reads each episode's played status and enclosure. `--playlist-id <uuid>` selects the same playlist by stable ID on later runs. `--show-urls` prints full enclosures for local inspection. Open one or two locally to confirm they return playable audio. The default output shows the URL scheme only. `token_expiry_hint_utc` comes from the token's unverified `exp` claim when present. A `401` or `403` is the server's auth/access result. [Playlist reference client](https://github.com/turquoise-turtle/shuffle-spread#playlists) · [Episode and login reference client](https://github.com/music-assistant/server/blob/dev/music_assistant/providers/pocketcasts/api_client.py)
4. Share whether order, played states, and playable enclosures match. If a shape check fails, share the error and sanitized field names. After those reads work, choose one unplayed episode for the separate write test. We will record the pre-write state and whether the episode is in Up Next, perform one played-status update, read it back, and compare the phone's episode, Run playlist, and Up Next. [Pocket Casts queue behavior](https://support.pocketcasts.com/knowledge-base/playing-episodes-and-managing-your-queue/)

The probe uses `GET /user/playlists` and the lookup form of `POST /user/episode`, with a UUID as its entire body. `--login` also calls `POST /user/login`. These are unofficial account endpoints. This script has no playlist or episode mutation command.

Local fixture checks passed for playlist order, request bodies, played state, and enclosure URL redaction. The live playlist endpoint returned HTTP 401 for an invalid token. Authenticated responses and expiry behavior still need to be checked on your account.
