import test from "node:test";
import assert from "node:assert/strict";
import { itemId, normalizePocketCasts, normalizeUploads, mergeSources, planQueue } from "../src/queue.mjs";
import { episodeUuid, podcastUuid, fixtureItems, storage } from "./support.mjs";

test("opaque identities remain stable across title and enclosure changes", async () => {
    const { uploads } = await fixtureItems();
    const updated = await normalizeUploads("fixture-feed", [{ guid: "upload-one", title: "Edited title",
        enclosureUrl: "https://audio.example.com/replaced.mp3", enclosureBytes: 120 }]);
    assert.equal(updated[0].id, uploads[0].id);
    assert.match(updated[0].id, /^pj_[a-f0-9]{64}$/);
    assert.notEqual(await itemId("upload", ["different-feed", "upload-one"]), uploads[0].id);
});

test("Pocket Casts uses episodeOrder rather than response array order", async () => {
    const second = "00000000-0000-0000-0000-000000000003";
    const details = [episodeUuid, second].map(uuid => ({ uuid, podcastUuid, title: "Fixture", playingStatus: 1,
        url: "https://audio.example.com/episode.mp3" }));
    const items = await normalizePocketCasts({ episodes: [{ uuid: episodeUuid }, { uuid: second }],
        episodeOrder: [second, episodeUuid] }, details);
    assert.deepEqual(items.map(item => item.pocketCasts.episodeUuid), [second, episodeUuid]);
    await assert.rejects(normalizePocketCasts({ episodes: [{ uuid: episodeUuid }], episodeOrder: [second] }, details));
});

test("source validation rejects ambiguous identity, unsafe URLs, and malformed metadata", async () => {
    const base = { guid: "one", title: "Fixture", enclosureUrl: "https://audio.example.com/a.mp3" };
    for (const change of [{ enclosureUrl: "http://audio.example.com/a.mp3" }, { enclosureUrl: "https://" + "user:pass@" + "audio.example.com/a.mp3" },
        { enclosureUrl: "https://audio.example.com/a.mp3#fragment" }, { enclosureBytes: -1 }, { title: " " },
        { pocketCastsMatch: { verified: false, episodeUuid, podcastUuid } }]) {
        await assert.rejects(normalizeUploads("fixture", [{ ...base, ...change }]));
    }
    await assert.rejects(normalizeUploads("fixture", [base, base]), /duplicate_upload/);
});

test("explicit verified matches deduplicate while preserving old upload identity", async () => {
    const { pocketCasts } = await fixtureItems();
    const uploads = await normalizeUploads("fixture", [{ guid: "match", title: "Edited upload title", pinned: true,
        enclosureUrl: "https://audio.example.com/match.mp3", enclosureBytes: 90,
        pocketCastsMatch: { verified: true, episodeUuid, podcastUuid } }]);
    const items = mergeSources(pocketCasts, uploads);
    assert.equal(items.length, 1);
    assert.equal(items[0].title, "Edited upload title");
    assert.equal(items[0].aliases.length, 2);
    const oldUploadId = await itemId("upload", ["fixture", "match"]);
    assert.equal(planQueue(items, { storage, completedIds: [oldUploadId] }).items.length, 0);
    assert.equal(planQueue(items, { storage, suppressedIds: [oldUploadId] }).items.length, 0);
});

test("equal titles alone do not match uploads to Pocket Casts", async () => {
    const { pocketCasts } = await fixtureItems();
    const uploads = await normalizeUploads("fixture", [{ guid: "unmatched", title: pocketCasts[0].title,
        enclosureUrl: pocketCasts[0].audioUrl, enclosureBytes: 10 }]);
    assert.equal(mergeSources(pocketCasts, uploads).length, 2);
});

test("multiple uploads matched to one episode retain every alias and prefer pinned content", async () => {
    const { pocketCasts } = await fixtureItems();
    const uploads = await normalizeUploads("fixture", [true, false].map((pinned, i) => ({
        guid: "match-" + i, title: pinned ? "Pinned version" : "Other version", pinned,
        enclosureUrl: "https://audio.example.com/" + i + ".mp3", enclosureBytes: 80,
        pocketCastsMatch: { verified: true, episodeUuid, podcastUuid },
    })));
    const merged = mergeSources(pocketCasts, uploads);
    assert.equal(merged.length, 1);
    assert.equal(merged[0].title, "Pinned version");
    assert.equal(merged[0].aliases.length, 3);
});

test("in-progress audio, pinned uploads, and playlist order take priority", async () => {
    const { pocketCasts, uploads } = await fixtureItems();
    const extra = await normalizeUploads("fixture", [
        { guid: "pinned", title: "Pinned", pinned: true, enclosureBytes: 10, enclosureUrl: "https://audio.example.com/p.mp3" },
        { guid: "later", title: "Later", enclosureBytes: 10, enclosureUrl: "https://audio.example.com/l.mp3" },
    ]);
    const items = mergeSources(pocketCasts, [...uploads, ...extra]);
    assert.deepEqual(items.map(item => item.title), ["Pinned", "Fixture episode", "Personal clip", "Later"]);
    const planned = planQueue(items, { storage, inProgressId: uploads[0].id });
    assert.deepEqual(planned.items.map(item => item.title), ["Personal clip", "Pinned", "Fixture episode"]);
    assert.equal(planQueue(items, { storage }).items.length, 2);
});

test("budget defers oversized and unknown audio and can choose a later smaller clip", async () => {
    const { items } = await fixtureItems();
    const unknown = { ...items[0], id: await itemId("fixture", "unknown"), aliases: [], sizeBytes: null };
    const huge = { ...items[0], id: await itemId("fixture", "huge"), aliases: [], sizeBytes: 900 };
    const queue = planQueue([unknown, huge, ...items], { storage });
    assert.deepEqual(queue.deferred.map(item => item.reason), ["unknown_size", "budget"]);
    assert.equal(queue.items.length, 2);
    assert.equal(queue.selectedBytes, 180);
});

test("a cached in-progress episode is retained even when it exceeds the target budget", async () => {
    const { items } = await fixtureItems();
    const planned = planQueue(items, { storage: { ...storage, usedBytes: 700 }, inProgressId: items[0].id,
        downloads: [{ id: items[0].id, bytes: 700 }] });
    assert.equal(planned.items.length, 1);
    assert.equal(planned.items[0].download, false);
    assert.equal(planned.selectedBytes, 700);
    assert.deepEqual(planned.protectedIds, [items[0].id]);
});

test("completed audio reclaims measured space while deletion holds stay unplayed", async () => {
    const { items } = await fixtureItems();
    const planned = planQueue(items, { storage: { ...storage, usedBytes: 950 }, completedIds: [items[0].id],
        downloads: [{ id: items[0].id, bytes: 100 }] });
    assert.deepEqual(planned.evictIds, [items[0].id]);
    assert.equal(planned.items.length, 0);
    assert.equal(planned.deferred[0].reason, "free_space");
    const held = planQueue(items, { storage, suppressedIds: [items[0].id] });
    assert.deepEqual(held.evictIds, []);
    assert.deepEqual(held.items.map(item => item.id), [items[1].id]);
});

test("public queue omits Pocket Casts UUIDs and only evicts completed downloads", async () => {
    const { items } = await fixtureItems();
    const queue = planQueue(items, { storage, downloads: [] });
    const serialized = JSON.stringify(queue);
    assert.equal(serialized.includes(episodeUuid), false);
    assert.equal(serialized.includes(podcastUuid), false);
    assert.deepEqual(queue.evictIds, []);
});

test("storage accounting rejects impossible reports", async () => {
    const { items } = await fixtureItems();
    assert.throws(() => planQueue(items, { storage: { ...storage, usedBytes: 1001 } }), /invalid_storage/);
    assert.throws(() => planQueue(items, { storage, downloads: [{ id: items[0].id, bytes: 1 }] }), /invalid_storage/);
    assert.throws(() => planQueue(items, { storage: { ...storage, budgetBytes: NaN } }), /invalid_storage/);
});

test("superseded downloads are retired only after the selected downloads succeed", async () => {
    const { items } = await fixtureItems();
    const oldId = await itemId("fixture", "superseded");
    const planned = planQueue(items, { storage: { ...storage, usedBytes: 100 }, downloads: [{ id: oldId, bytes: 100 }] });
    assert.deepEqual(planned.evictIds, []);
    assert.deepEqual(planned.retireAfterDownloadIds, [oldId]);
    const protectedQueue = planQueue(items, { storage: { ...storage, usedBytes: 100 },
        downloads: [{ id: oldId, bytes: 100 }], inProgressId: oldId });
    assert.deepEqual(protectedQueue.retireAfterDownloadIds, []);
    const completed = planQueue(items, { storage: { ...storage, usedBytes: 100 },
        downloads: [{ id: oldId, bytes: 100 }], inProgressId: oldId, completedIds: [oldId] });
    assert.deepEqual(completed.protectedIds, []);
    assert.deepEqual(completed.evictIds, [oldId]);
});

test("varied storage and playback states preserve queue safety invariants", async () => {
    const { items } = await fixtureItems();
    const templates = await Promise.all(Array.from({ length: 12 }, async (_, index) => {
        const id = await itemId("generated-fixture", String(index));
        return { ...items[0], id, aliases: [id] };
    }));
    let seed = 28439;
    function random() {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        return seed / 2 ** 32;
    }
    for (let trial = 0; trial < 1000; trial += 1) {
        const candidates = templates.map(item => ({ ...item,
            sizeBytes: random() < 0.2 ? null : 10 + Math.floor(random() * 400), played: random() < 0.1 }));
        const completedIds = candidates.filter(() => random() < 0.15).map(item => item.id);
        const suppressedIds = candidates.filter(() => random() < 0.1).map(item => item.id);
        const downloads = candidates.filter(() => random() < 0.3).map(item => ({ id: item.id, bytes: 20 + Math.floor(random() * 300) }));
        const usedBytes = downloads.reduce((sum, download) => sum + download.bytes, 0) + Math.floor(random() * 100);
        const report = { capacityBytes: usedBytes + Math.floor(random() * 600), usedBytes,
            budgetBytes: Math.floor(random() * 1000), reserveBytes: Math.floor(random() * 200) };
        const current = candidates[Math.floor(random() * candidates.length)];
        const planned = planQueue(candidates, { storage: report, downloads, completedIds, suppressedIds, inProgressId: current.id });
        const blocked = new Set([...completedIds, ...suppressedIds, ...candidates.filter(item => item.played).map(item => item.id)]);
        assert.equal(new Set(planned.items.map(item => item.id)).size, planned.items.length);
        assert.ok(planned.items.every(item => !blocked.has(item.id) && item.size_bytes > 0));
        const hasCurrent = planned.items.some(item => item.id === current.id);
        assert.ok(planned.items.length <= (hasCurrent ? 3 : 2));
        if (!blocked.has(current.id) && downloads.some(item => item.id === current.id)) {
            assert.equal(planned.items[0].id, current.id);
        }
        const reclaimed = downloads.filter(item => planned.evictIds.includes(item.id)).reduce((sum, item) => sum + item.bytes, 0);
        const downloading = planned.items.filter(item => item.download).reduce((sum, item) => sum + item.size_bytes, 0);
        assert.ok(downloading <= Math.max(0, report.capacityBytes - report.usedBytes - report.reserveBytes + reclaimed));
        assert.ok(planned.retireAfterDownloadIds.every(id => !planned.protectedIds.includes(id)));
        assert.ok(planned.evictIds.every(id => !planned.items.some(item => item.id === id)));
    }
});
