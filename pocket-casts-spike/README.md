# Pocket Casts account probe

1. In Pocket Casts, create a manual playlist called **Run**, add two or three recognizable episodes, and note the displayed order and played state. Wait for it to sync. [Pocket Casts playlists](https://support.pocketcasts.com/knowledge-base/playlists/)
2. In an interactive terminal, run the following from the repo root. It uses Python 3.10+ and the standard library. The password prompt hides input and the script keeps the resulting token in memory.

   ```powershell
   python .\pocket-casts-spike\probe.py --login
   ```

   For Google sign-in, open the Pocket Casts web player, use **Continue with Google**, then copy the bearer token from a successful `api.pocketcasts.com` request under DevTools **Network → Headers → Request Headers**. Paste only the value after `Bearer` at the hidden prompt. The probe also accepts `POCKET_CASTS_TOKEN` from a local secret-injection setup. Keep credentials and tokens out of chat, shell commands, and files in the repo. [Pocket Casts single sign-on](https://support.pocketcasts.com/knowledge-base/single-sign-on-accounts-using-continue-with-google-or-continue-with-apple/)

   ```powershell
   python .\pocket-casts-spike\probe.py
   ```

3. Compare the resulting `episodes` list against **Run**. The probe joins the playlist's `episodes` to `episodeOrder`, then reads each episode's played status and enclosure. `--playlist-id <uuid>` selects the same playlist by stable ID on later runs. `--show-urls` prints full enclosures for local inspection. Open one or two locally to confirm they return playable audio. The default output shows the URL scheme only. `token_expiry_hint_utc` comes from the token's unverified `exp` claim when present. A `401` or `403` is the server's auth/access result. [Playlist reference client](https://github.com/turquoise-turtle/shuffle-spread#playlists) · [Episode and login reference client](https://github.com/music-assistant/server/blob/dev/music_assistant/providers/pocketcasts/api_client.py)
4. Share whether order, played states, and playable enclosures match. If a shape check fails, share the error and sanitized field names.

The probe uses `GET /user/playlists` and the lookup form of `POST /user/episode`, with a UUID as its entire body. `--login` also calls `POST /user/login`. These are unofficial account endpoints. This script has no playlist or episode mutation command.

Local fixture checks passed for playlist order, request bodies, played state, and enclosure URL redaction. The live playlist endpoint returned HTTP 401 for an invalid token. An authenticated test using a web player token returned two episodes in order, both with `playingStatus` 3 and HTTPS enclosures. The token had an expiry hint. A matching episode in the public catalog returned HTTP 206 with `audio/mpeg` from its publisher, and the first minute decoded on a desktop. Token renewal still needs verification.

## Verify one played-status write

1. Choose one unplayed episode you are comfortable marking played. Add it to the manual playlist and use the read-only probe to get its episode UUID. If you want to check the queue side effect, add it to **Up Next** too and note its place there. [Pocket Casts queue behavior](https://support.pocketcasts.com/knowledge-base/playing-episodes-and-managing-your-queue/)
2. Run the separate write test with the UUID you chose. Add `--playlist "Your playlist name"` if the name differs from **Run**. Paste a fresh token if the old session has expired.

   ```powershell
   $episodeId = Read-Host 'Unplayed episode UUID'
   python .\pocket-casts-spike\verify_played.py --episode-id $episodeId
   ```

3. Confirm that the preview shows the intended episode and that its state is unplayed. Type `PLAYED` to send one update to `POST /sync/update_episode`. The test reads back the episode status even if the write response is uncertain. [Music Assistant played update](https://github.com/music-assistant/server/blob/dev/music_assistant/providers/pocketcasts/api_client.py)
4. Refresh Pocket Casts on the phone. Check the episode's played state and whether it remains in the manual playlist and Up Next. Record the outcome with account details removed. If the test cannot verify the write, check the app before retrying.

In a live test, the selected episode changed from `playingStatus` 1 to 3 while `playedUpTo` stayed at zero. After refreshing the web player, the episode's menu showed **Mark as unplayed** and **Remove from Up Next**. It remained in the manual playlist and Up Next. The phone view after sync still needs to be checked.
