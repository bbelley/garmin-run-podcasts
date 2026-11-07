# PaceJams

A personal project for listening to Pocket Casts selections and uploaded MP3s offline on a Garmin Forerunner 255S Music. The goal is a single watch sync to update the queue, report finished episodes, and reclaim storage.

The [project plan](PROJECT_PLAN.md) starts with two independent feasibility checks.

- [Garmin app](garmin-spike/README.md) covers the live queue client, signed `fr255sm` builds, simulator checks, sideloading, and the remaining offline Run tests. The original one-clip mode remains available.
- [Pocket Casts account probe](pocket-casts-spike/README.md) covers reading the manual **Run** playlist and checking its order, enclosure URLs, and played state.
- [Backend core](backend-core/README.md) contains the locally tested queue policy, durable completion ledger, and Pocket Casts delivery outbox prepared for the Worker integration.
- [Cloudflare integration](cloudflare-worker/README.md) adds the live authenticated manifest, existing R2 uploads, encrypted renewable Pocket Casts sessions, and D1 completion storage. The queue client is ready for physical-watch validation.
- [Private account setup](cloudflare-worker/README.md#private-browser-setup) opens a single-use browser link for Pocket Casts reconnection and delivery status without copying credentials or tokens into chat.

The local checks run with Node 24.4 or newer and Python 3.10 or newer.

```powershell
npm --prefix backend-core test
npm --prefix cloudflare-worker ci
npm --prefix cloudflare-worker test
python tools/test_privacy.py
```

This public repository includes a privacy guard for staged files and every outgoing commit. It checks recognized credentials, private artifacts, account IDs, personal email addresses, and private values from the ignored Garmin and Cloudflare configurations. Reports identify the file and category. Review the staged diff alongside this check.

Enable the included hooks once per checkout.

```powershell
git config core.hooksPath .githooks
```

Run `python tools/check_privacy.py --staged` before a commit and `python tools/check_privacy.py --outgoing origin/main` to review outgoing history manually. The Git hooks run those checks at commit and push time. Local signing keys, builds, private notes, and feed configuration belong in the ignored paths.
