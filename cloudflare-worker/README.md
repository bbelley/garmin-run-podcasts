# PaceJams Cloudflare integration

The Worker adds authenticated queue sync to the existing private RSS Worker and R2 bucket. Existing feed, cover, audio, and byte-range routes continue through the saved original handler. A D1 database stores the retained catalog, source snapshots, completion ledger, delivery outbox, and encrypted Pocket Casts session. The [Garmin queue client](../garmin-spike/README.md#live-queue-build-and-watch-test) consumes this manifest and has passed local simulator checks; its physical-watch integration remains to be verified.

The Worker is needed for account renewal, queue planning, and durable completion acknowledgements. R2 supplies an independent custom-audio source. Pocket Casts Files could become another source after a separate API/download feasibility check. Files currently cannot be added to a regular playlist. A new upload interface is deferred while the existing upload workflow works. [Pocket Casts Files](https://support.pocketcasts.com/knowledge-base/files/)

## Local checks

Use Node 24.4+ and Python 3.11+ for the integration tools.

```powershell
npm --prefix cloudflare-worker ci
npm --prefix backend-core test
npm --prefix cloudflare-worker test
python tools/test_privacy.py
```

Tests use synthetic account data, SQLite, and mocked outbound requests. They cover endpoint authentication, body limits, R2 metadata and replacements, encrypted sessions, refresh leases and rotation, the account API's episode field, reconnect status, native fetch receivers, MP3 size discovery, and completion-only write payloads. The backend-core suite covers queue policy and delivery recovery.

## Private deployment configuration

Live configuration lives under ignored `.spike-tools/cloudflare/`. Never commit its files or the generated bundle. `current.json` names the existing account, Worker, canonical HTTPS origin, original backup directory/modules, and approved D1 database. `secrets.json` contains separate random watch/admin tokens and the AES-GCM session key. Back up these files privately: losing the encryption key requires reconnecting Pocket Casts.

Before the first deployment, export the existing Worker source, settings, and deployments into an immutable ignored backup. Review its module and bindings. `prepare.mjs` currently supports the inspected legacy handler with `FEED_PATH`, `EPISODE_DETAILS`, and `REPLACEMENTS` constants and a `PODCASTS` R2 binding. It deliberately stops for an unfamiliar layout. It generates a private wrapper, Wrangler configuration, combined schema, and local development secrets. Subsequent builds retain the saved legacy code and metadata overrides; review external changes before replacing that backup.

```powershell
node cloudflare-worker/prepare.mjs
$cfg = '.spike-tools/cloudflare/generated/wrangler.jsonc'
$wrangler = '.\cloudflare-worker\node_modules\.bin\wrangler.cmd'
& $wrangler d1 execute pacejams-sync --local --config $cfg --file .spike-tools/cloudflare/generated/schema.sql
& $wrangler dev --local --config $cfg
```

Local bindings are isolated from production. Test fixtures belong only in local R2/D1. Applying the schema remotely uses `--remote` with the same reviewed configuration and the approved database.

Build and inspect before deployment. The helper uses the existing Wrangler OAuth sign-in, uploads code and bindings through Cloudflare's Worker API, and leaves route/domain management alone. It refuses to replace a concurrently changed active version. All source containing private feed configuration stays local. [Worker upload API](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)

```powershell
$bundle = Join-Path (Get-Location) '.spike-tools/cloudflare/bundle'
& $wrangler deploy --dry-run --config $cfg --outdir $bundle
python cloudflare-worker/live_ops.py baseline
python cloudflare-worker/live_ops.py deploy
python cloudflare-worker/live_ops.py verify
python cloudflare-worker/live_ops.py ledger-test
```

Create the feed baseline once before the first deployment. Verification checks that RSS is unchanged, an existing audio range works, unauthenticated sync and watch access to admin routes fail, and consecutive manifests have stable IDs. It uses simulated storage capacity, not a physical watch measurement. `ledger-test` seeds one randomly named, unmapped synthetic item, checks durable acknowledgement/replay/conflict through the live endpoint, and removes only its own fixture rows. It never marks a real episode played.

The immutable original backup and `deployment.json` retain rollback versions. To undo a deployment, use Cloudflare's deployment/version rollback controls for the recorded previous version; keep the D1 database and R2 objects. Do not overwrite a newer externally changed Worker without reviewing it first.

## Connect or reconnect Pocket Casts

Run the following in an interactive local terminal, supplying the exact manual playlist name.

```powershell
python cloudflare-worker/connect_account.py --playlist Run
```

The password is hidden and stays in the local process. The script signs into Pocket Casts, resolves the playlist's stable ID, verifies renewal, then sends the access/refresh session to the configured Worker using the admin credential. The Worker encrypts it with AES-GCM before storing it in D1. The script also forces one server-side renewal and playlist read. Its local report contains counts/status only. A phone/browser account setup page can replace this developer command later.

The adapter isolates the unofficial account endpoints. It refreshes access tokens before expiry, saves rotated refresh tokens with a fenced lease, and exposes reconnect status after rejected authentication. A failed source refresh uses the last good snapshot; R2 uploads remain usable independently. The current account read is capped at 32 playlist entries and size-probes up to three unplayed items per refresh. Larger playlists and request caching need another pass before broader distribution.

## Endpoints and completion delivery

| Endpoint | Credential | Purpose |
| --- | --- | --- |
| `GET /v1/health` | None | App/protocol version only |
| `POST /v1/watch/sync` | Watch | Completion ingestion and budgeted queue |
| `GET /v1/admin/status` | Admin | Connection and delivery counts |
| `POST /v1/admin/pocket-casts/session` | Admin | Store/reconnect an encrypted renewable session |
| `POST /v1/admin/pocket-casts/check` | Admin | Force renewal and read the selected playlist; safe failure category |

Requests use `Authorization: Bearer …`; tokens do not belong in query strings. POST bodies are JSON and limited to 64 KiB. The watch sync uses `protocol_version: 1` plus the [core input fields](../backend-core/README.md). Public queue entries omit account UUID mappings. The watch must retain events until their IDs appear in `acknowledged_event_ids`.

Played-status delivery is deployed **disabled** with `POCKET_CASTS_WRITEBACK_ENABLED=false`. Completion ingestion remains durable; enabling delivery later drains the retained outbox through read-before/write/read-after checks. Keep it disabled until the physical watch's completion, pause, skip, reboot, and cache-recovery checks pass. No Cron Trigger is installed. Delivery currently retries when an authenticated sync schedules one due item.

R2 entries retain edited titles and duration metadata from the existing feed. Custom metadata `addToRun=false` opts an upload out; `pinned=true` puts it ahead of playlist items. Explicit verified Pocket Casts mappings remain server-side; filenames and equal titles never imply a match. Unknown-size audio is deferred. Publisher size probing follows at most six HTTPS requests, sends no account credential, and reads at most the initial MP3 header from generic binary responses. Actual audio compatibility still needs a watch download/playback test.

## Live verification recorded

The deployed integration preserved the existing four-item RSS byte for byte and served an existing MP3 range successfully. Pocket Casts sign-in, server-side refresh, and the four-entry manual playlist read passed. The final manifest selected one unplayed Pocket Casts episode and one R2 upload, with verified byte sizes and stable IDs across consecutive refreshes. Live D1 ingestion, duplicate replay, conflict rejection, and fixture cleanup passed. The D1 session row contains ciphertext; no real completion or played-status write was generated by these integration tests.

The initial server-side check exposed a native fetch receiver error and the live API's `episode` field naming. Both were corrected and covered by regression checks. Media probing also handles the publisher's generic binary MIME type and redirect chain. Offline native Run playback, publisher MP3 download on the Garmin, and watch-to-Worker sync remain hardware work.
