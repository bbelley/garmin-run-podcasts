# PaceJams

A personal project for listening to Pocket Casts selections and uploaded MP3s offline on a Garmin Forerunner 255S Music. The goal is a single watch sync to update the queue, report finished episodes, and reclaim storage.

The [project plan](PROJECT_PLAN.md) starts with two independent feasibility checks.

- [Garmin watch spike](garmin-spike/README.md) covers building and signing for `fr255sm`, sideloading, testing offline during a recorded Run, and reading the callback log.
- [Pocket Casts account probe](pocket-casts-spike/README.md) covers reading the manual **Run** playlist and checking its order, enclosure URLs, and played state.
