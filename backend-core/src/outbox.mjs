export class PocketCastsError extends Error {
    constructor(code, retryAfterSeconds = 0) {
        super(code);
        this.code = code;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

async function playedState(adapter, item) {
    const played = await adapter.isPlayed(item.episode_uuid, item.podcast_uuid);
    if (typeof played !== "boolean") throw new PocketCastsError("invalid_played_state");
    return played;
}

export async function deliverOne(store, adapter, now) {
    const item = await store.claimDelivery(now);
    if (!item) return { status: "idle" };
    try {
        if (!(await playedState(adapter, item))) {
            let writeFailure;
            try {
                await adapter.markPlayed(item.episode_uuid, item.podcast_uuid);
            } catch (error) {
                writeFailure = error;
            }
            let played;
            try {
                played = await playedState(adapter, item);
            } catch (error) {
                throw writeFailure ?? error;
            }
            if (!played) throw writeFailure ?? new PocketCastsError("readback_unplayed");
        }
        await store.finishDelivery(item, now);
        return { status: "delivered" };
    } catch (error) {
        const needsAuth = error instanceof PocketCastsError && error.code === "auth_required";
        const code = needsAuth ? "auth_required" : "retry_required";
        const retryAfter = error instanceof PocketCastsError && Number.isFinite(error.retryAfterSeconds)
            ? Math.max(0, error.retryAfterSeconds) : 0;
        // Persist only a safe category. Upstream errors may contain credentials or private URLs.
        await store.failDelivery(item, now, code, retryAfter);
        return { status: code };
    }
}
