# PaceJams backend core

This local library prepares the queue and completion parts of the Cloudflare Worker. The remaining Garmin feasibility checks are tracked in the root project plan. The code uses Web Crypto and a D1 binding interface, with Node's SQLite module providing the database for local tests.

Run the suite with Node 24.4 or newer from the repository root.

```powershell
npm --prefix backend-core test
```

The test suite uses synthetic episodes and an isolated database. It covers queue ordering and capacity, completion replay and persistence, failed source refreshes, and Pocket Casts delivery retries. The SQLite test adapter implements the D1 methods used by this library. A deployed D1 test is part of the integration work.

The source normalizers consume data already read by an adapter. `normalizePocketCasts(playlist, details)` uses the same `episodeOrder`, episode UUID, podcast UUID, `playingStatus`, and enclosure fields as the verified Python probe. `sizeBytes` is optional and should come from verified enclosure metadata. `normalizeUploads(feedKey, entries)` takes parsed RSS entries with `guid`, `title`, `enclosureUrl`, and optional `enclosureBytes`, `durationSeconds`, and `pinned` fields. The caller supplies a stable feed key. Original HTTPS enclosure URLs pass through intact.

An upload can have a server-supplied `pocketCastsMatch` containing `verified: true`, `episodeUuid`, and `podcastUuid`. Verified matches share one queue item. Old upload IDs remain aliases so completion and deletion holds survive a later match. Equal titles and URLs alone do not establish a match. A pinned upload provides the audio and edited title when matched versions overlap.

The queue keeps an eligible in-progress item followed by up to two upcoming items. It prefers pinned uploads, then Pocket Casts order, then other uploads. Unknown-size files wait for verified size metadata unless the watch already has a complete download with a measured size. The storage report uses `capacityBytes`, `usedBytes`, `budgetBytes`, and `reserveBytes`. The watch must populate these from Garmin's media cache measurements.

The sync boundary is `syncWatch({ store, watchId, input, sources, now })`. `watchId` comes from the authenticated watch credential. `now` is server time in whole seconds. Each source loader returns its normalized array or throws. The input contains the following fields.

| Field | Meaning |
| --- | --- |
| `events` | Up to 32 completion records containing `event_id`, `item_id`, `reason`, and `occurred_at`. The reason is `natural_end` or `mark_finished`. |
| `storage` | The measured storage values listed above, in bytes. |
| `downloads` | Complete cached files as `{ id, bytes }`. Partial transfers stay outside this list. |
| `inProgressId` | Optional current item ID. |
| `suppressedIds` | Optional IDs held after Delete Download. These stay filtered until the watch explicitly clears the hold. |

`D1Store.recordCompletions()` commits each event, its completion, and its delivery record together before returning acknowledged IDs. Replaying an identical event returns the same acknowledgement. Reusing an event ID with different content aborts the incoming batch. The persistent catalog retains items removed from the latest playlist, so their pending completions can still be accepted. A later verified match can enqueue a previously completed personal upload for writeback. [D1 transactional batches](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)

The returned queue has `evictIds` for completed downloads and `retireAfterDownloadIds` for superseded downloads. The watch can reclaim completed audio after receiving its durable acknowledgement. It must wait until the selected new downloads succeed before retiring superseded ready audio. `protectedIds` preserves the in-progress file. The public queue contains opaque item IDs and playable metadata. Pocket Casts UUID mappings remain in the private catalog.

`deliverOne(store, adapter, now)` claims one due delivery with a fenced lease. The adapter implements `isPlayed(episodeUuid, podcastUuid)` and `markPlayed(episodeUuid, podcastUuid)`. Delivery reads played state before a write and after the attempt, including when the write response is lost. Transient failures use backoff and respect a supplied retry delay. An `auth_required` error holds delivery until `resumeDeliveries()` is called after reconnecting the account. Error details saved to the database use fixed categories. [Verified Pocket Casts write probe](../pocket-casts-spike/verify_played.py)

Integration work follows the hardware checks and can reuse these tested boundaries.

1. Add live Pocket Casts and RSS loaders, using the verified refresh flow and existing Cloudflare feed. Check the uploader's metadata before choosing any new storage bindings.
2. Wrap the service in an authenticated Worker endpoint with a bounded JSON body and a revocable watch token. Keep account credentials in private server-side storage and source loaders separate from the queue policy.
3. Apply `schema.sql` to a local D1 instance and repeat the event, retry, and persistence checks through the Worker entry point.
4. Connect the watch's pending event log, cache measurements, sequential downloads, and acknowledgement handling to the versioned response. Verify the complete path on the 255S Music before enabling scheduled delivery.
