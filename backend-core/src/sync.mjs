import { mergeSources, planQueue, validateItems } from "./queue.mjs";
import { validateEvents } from "./store.mjs";

async function refreshSource(store, name, load, now) {
    try {
        const items = await load();
        validateItems(items);
        await store.saveSnapshot(name, items, now);
        const snapshot = await store.snapshot(name);
        return { items: snapshot.items, stale: false };
    } catch {
        const snapshot = await store.snapshot(name);
        return { items: snapshot?.items ?? [], stale: true };
    }
}

export async function syncWatch({ store, watchId, input, sources, now }) {
    const events = validateEvents(input.events);
    // Validate the storage report before persisting any events from this request.
    planQueue([], input);
    // A pending completion can refer to an item removed from the latest source selection.
    // The persistent catalog retains it and supplies its server-side mapping.
    const acknowledged = await store.recordCompletions(watchId, events, now);
    const pocketCasts = await refreshSource(store, "pocketcasts", sources.pocketCasts, now);
    const uploads = await refreshSource(store, "uploads", sources.uploads, now);
    const items = mergeSources(pocketCasts.items, uploads.items);
    await store.saveCatalog(items);
    if (input.inProgressId && !items.some(item => item.aliases.includes(input.inProgressId))) {
        const current = await store.item(input.inProgressId);
        if (current) items.unshift(current);
    }
    const queue = planQueue(items, { ...input, completedIds: await store.completedIds() });
    return {
        protocol_version: 1,
        acknowledged_event_ids: acknowledged,
        queue,
        sources: { pocketcasts_stale: pocketCasts.stale, uploads_stale: uploads.stale },
        pocket_casts_delivery: await store.deliveryStatus(),
    };
}
