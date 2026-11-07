using Toybox.Application;
using Toybox.Communications;
using Toybox.Lang;
using Toybox.Media;
using Toybox.Test;

function queueTestId(value) {
    var hex = value.format("%x");
    while (hex.length() < 64) { hex = "0" + hex; }
    return "pj_" + hex;
}

function queueTestItem(value) {
    return {"id" => queueTestId(value), "title" => "Fixture episode", "duration_seconds" => 3600,
        "size_bytes" => 100, "audio_url" => "https://audio.example.com/fixture.mp3", "cached_id" => null};
}

function queueTestStore() {
    Application.Storage.deleteValue("queueTestV1");
    var store = new QueueStore("queueTestV1");
    store.addFile(queueTestItem(1), "fixture-ref", 100);
    return store;
}

function queueTestResponse() {
    return {"protocol_version" => 1, "acknowledged_event_ids" => [], "queue" => {
        "items" => [queueTestItem(1)], "evictIds" => [], "retireAfterDownloadIds" => [], "protectedIds" => []}};
}

(:test)
function queueBookmarksAndNoncompletion(logger as Test.Logger) as Lang.Boolean {
    var store = queueTestStore();
    var id = queueTestId(1);
    queueSongEvent(store, id, Media.SONG_EVENT_PAUSE, 1234, 100);
    store = new QueueStore("queueTestV1");
    Test.assertEqual(store.file(id)["position"], 1234);
    queueSongEvent(store, id, Media.SONG_EVENT_START, 0, 101);
    Test.assertEqual(store.file(id)["position"], 1234);
    queueSongEvent(store, id, Media.SONG_EVENT_SKIP_NEXT, 1250, 102);
    Test.assertEqual(store.read()["events"].size(), 0);
    queueSongEvent(store, id, Media.SONG_EVENT_SKIP_BACKWARD, 0, 103);
    Test.assertEqual(new QueueStore("queueTestV1").file(id)["position"], 0);
    return true;
}

(:test)
function queueCompletionAndReplay(logger as Test.Logger) as Lang.Boolean {
    var store = queueTestStore();
    var id = queueTestId(1);
    queueSongEvent(store, id, Media.SONG_EVENT_COMPLETE, 3600, 100);
    var eventId = store.read()["events"][0]["event_id"];
    store = new QueueStore("queueTestV1");
    Test.assert(store.file(id)["done"]);
    Test.assertEqual(store.read()["events"][0]["event_id"], eventId);
    queueSongEvent(store, id, Media.SONG_EVENT_COMPLETE, 3600, 101);
    Test.assertEqual(store.read()["events"].size(), 1);
    Test.assertEqual(store.read()["finished"], 1);
    // A response can acknowledge only events sent with that request.
    store.acknowledge([eventId], []);
    Test.assertEqual(store.read()["events"].size(), 1);
    store.acknowledge([eventId], [eventId]);
    Test.assertEqual(new QueueStore("queueTestV1").read()["events"].size(), 0);
    Test.assert(store.file(id) != null);
    return true;
}

(:test)
function queueDeletionIsNotCompletion(logger as Test.Logger) as Lang.Boolean {
    var store = queueTestStore();
    store.bookmark(queueTestId(1), 800);
    store.hold(queueTestId(1));
    store.removeFile(queueTestId(1));
    store = new QueueStore("queueTestV1");
    Test.assertEqual(store.read()["events"].size(), 0);
    Test.assertEqual(store.read()["finished"], 0);
    Test.assertEqual(store.read()["holds"].size(), 1);
    Test.assert(store.read()["current"] == null);
    store.restoreHolds();
    Test.assertEqual(store.read()["holds"].size(), 0);
    return true;
}

class FailingQueueTestStore extends QueueStore {
    var failWrite = false;
    function initialize() { QueueStore.initialize("queueTestV1"); }
    function write(state) {
        if (failWrite) { throw new Lang.StorageFullException("fixture failure"); }
        QueueStore.write(state);
    }
}

(:test)
function queueStorageFailureRetainsUnfinishedAudio(logger as Test.Logger) as Lang.Boolean {
    queueTestStore();
    var store = new FailingQueueTestStore();
    store.failWrite = true;
    var failed = false;
    try { store.complete(queueTestId(1), "natural_end", 100); } catch (exception) { failed = true; }
    Test.assert(failed);
    var saved = new QueueStore("queueTestV1").read();
    Test.assertEqual(saved["events"].size(), 0);
    Test.assertEqual(saved["finished"], 0);
    Test.assertEqual(saved["files"][0]["done"], false);
    return true;
}

(:test)
function queueRejectsMalformedResponses(logger as Test.Logger) as Lang.Boolean {
    var data = queueTestResponse();
    Test.assert(queueValidResponse(data, []));
    data["acknowledged_event_ids"] = ["unsent-event"];
    Test.assert(!queueValidResponse(data, []));
    data = queueTestResponse(); data["queue"]["items"][0]["size_bytes"] = null;
    Test.assert(!queueValidResponse(data, []));
    data = queueTestResponse(); data["queue"]["items"][0]["audio_url"] = "http://audio.example.com/fixture.mp3";
    Test.assert(!queueValidResponse(data, []));
    data = queueTestResponse(); data["queue"]["items"].add(queueTestItem(1));
    Test.assert(!queueValidResponse(data, []));
    data = queueTestResponse(); data["queue"]["evictIds"].add(queueTestId(1));
    Test.assert(!queueValidResponse(data, []));
    return true;
}

(:test)
function queueByteLimitsUseLongCapacity(logger as Test.Logger) as Lang.Boolean {
    Test.assertEqual(queueTransferLimit(100, 4000000000l, 200), 200);
    Test.assertEqual(queueTransferLimit(100, 90, 200), 90);
    Test.assertEqual(queueTransferLimit(100, 200, -10), 0l);
    Test.assertEqual(queueTransferLimit(100, 4000000000l, 4000000000l), 65636l);
    Test.assertEqual(queueTransferLimit(100000000, 4000000000l, 4000000000l), 105000000l);
    return true;
}

(:test)
function queueTransferJournalSurvivesRestart(logger as Test.Logger) as Lang.Boolean {
    var store = queueTestStore();
    store.transfer({"before" => ["fixture-ref"], "bytes" => 100l, "id" => queueTestId(2)});
    store = new QueueStore("queueTestV1");
    Test.assertEqual(store.read()["transfer"]["before"][0], "fixture-ref");
    Test.assertEqual(store.file(queueTestId(1))["bytes"], 100);
    store.transfer(null);
    Test.assert(store.read()["transfer"] == null);
    return true;
}

(:test)
function queueDeletionProtectsUnacknowledgedAndCurrent(logger as Test.Logger) as Lang.Boolean {
    var store = queueTestStore();
    var id = queueTestId(1);
    store.bookmark(id, 900);
    Test.assert(!queueMayDelete(store.read(), id, [], [], "retired"));
    Test.assert(!queueMayDelete(store.read(), id, [], [id], "retired"));
    store.complete(id, "natural_end", 100);
    Test.assert(!queueMayDelete(store.read(), id, [], [], "completed"));
    var eventId = store.read()["events"][0]["event_id"];
    store.acknowledge([eventId], [eventId]);
    Test.assert(queueMayDelete(store.read(), id, [], [], "completed"));
    return true;
}

class QueueSyncTestDelegate extends QueueSyncDelegate {
    var cleanup = [];
    var nextStarted = false;
    var finalError = null;
    function initialize(store, sent) { QueueSyncDelegate.initialize(); _store = store; _sent = sent; _active = true; }
    function deleteIds(ids, mode) {
        Test.assertEqual(_store.read()["events"].size(), 0);
        cleanup.add(mode);
    }
    function startNext() { nextStarted = true; }
    function finish(error) { finalError = error; _active = false; }
}

(:test)
function queueSyncAcknowledgesBeforeCleanup(logger as Test.Logger) as Lang.Boolean {
    var store = queueTestStore();
    store.complete(queueTestId(1), "mark_finished", 100);
    var eventId = store.read()["events"][0]["event_id"];
    var sync = new QueueSyncTestDelegate(store, [eventId]);
    var response = queueTestResponse();
    response["acknowledged_event_ids"] = [eventId];
    sync.onManifest(200, response);
    Test.assert(sync.nextStarted);
    Test.assertEqual(sync.cleanup.size(), 2);
    Test.assertEqual(store.read()["events"].size(), 0);
    return true;
}

(:test)
function queueFailedResponseKeepsCompletionAndDownloads(logger as Test.Logger) as Lang.Boolean {
    var store = queueTestStore();
    store.complete(queueTestId(1), "natural_end", 100);
    var eventId = store.read()["events"][0]["event_id"];
    var sync = new QueueSyncTestDelegate(store, [eventId]);
    sync.onManifest(503, null);
    Test.assert(!sync.nextStarted);
    Test.assertEqual(sync.cleanup.size(), 0);
    Test.assertEqual(store.read()["events"].size(), 1);
    Test.assert(store.file(queueTestId(1)) != null);
    sync = new QueueSyncTestDelegate(store, [eventId]);
    var response = queueTestResponse(); response["acknowledged_event_ids"] = ["unknown"];
    sync.onManifest(200, response);
    Test.assertEqual(sync.cleanup.size(), 0);
    Test.assertEqual(store.read()["events"].size(), 1);
    return true;
}

(:test)
function queueMigrationCommitsFileAndBookmarkTogether(logger as Test.Logger) as Lang.Boolean {
    Application.Storage.deleteValue("queueTestV1");
    var store = new QueueStore("queueTestV1");
    store.addFileWithBookmark(queueTestItem(1), "fixture-ref", 100, 901);
    store = new QueueStore("queueTestV1");
    Test.assertEqual(store.read()["current"], queueTestId(1));
    Test.assertEqual(store.file(queueTestId(1))["position"], 901);
    Test.assertEqual(store.read()["events"].size(), 0);
    return true;
}

class QueueCacheTestStats {
    var capacity = 536870912l;
    var size = 100l;
}

class QueueDownloadTestDelegate extends QueueSyncDelegate {
    var refs;
    var stats;
    var nativeSizes = {"fixture-ref" => 100};
    var requested = [];
    var manifestInput;
    var completed = false;
    var error = null;
    var canceled = false;
    function initialize(store, nativeRefs, usage) {
        QueueSyncDelegate.initialize(); _store = store; refs = nativeRefs; stats = usage;
    }
    function cacheRefs() as Lang.Dictionary { return refs; }
    function cacheUsage() { return stats; }
    function requestManifest(input) { manifestInput = input; }
    function requestAudio(item) { requested.add(item["id"]); }
    function emitCompletion(value) { completed = true; error = value; }
    function syncProgress(value) {}
    function cancelRequests() { canceled = true; }
    function removeNative(ref) {
        var id = ref.getId(); stats.size -= nativeSizes[id]; refs.remove(id); nativeSizes.remove(id);
    }
    function addNative(id, bytes) {
        refs[id] = new Media.ContentRef(id, Media.CONTENT_TYPE_AUDIO);
        nativeSizes[id] = bytes; stats.size += bytes;
    }
}

function queueDownloadTestDelegate(store) {
    return new QueueDownloadTestDelegate(store,
        {"fixture-ref" => new Media.ContentRef("fixture-ref", Media.CONTENT_TYPE_AUDIO)}, new QueueCacheTestStats());
}

function queueDownloadTestResponse() {
    var response = queueTestResponse();
    response["queue"]["items"] = [queueTestItem(2), queueTestItem(3)];
    response["queue"]["retireAfterDownloadIds"] = [queueTestId(1)];
    return response;
}

(:test)
function queueSequentialDownloadFailureAndRetry(logger as Test.Logger) as Lang.Boolean {
    var store = queueTestStore();
    var sync = queueDownloadTestDelegate(store);
    sync.onStartSync();
    Test.assertEqual(sync.manifestInput["storage"]["usedBytes"], 100l);
    Test.assertEqual(sync.manifestInput["downloads"].size(), 1);
    sync.onManifest(200, queueDownloadTestResponse());
    Test.assertEqual(sync.requested.size(), 1);
    Test.assertEqual(sync.requested[0], queueTestId(2));
    sync.addNative("download-two", 200);
    sync.onDownload(200, null);
    Test.assertEqual(sync.requested.size(), 2);
    Test.assert(store.file(queueTestId(1)) != null);
    sync.addNative("partial-three", 40);
    sync.onDownload(Communications.STORAGE_FULL, null);
    Test.assert(sync.completed && sync.error != null);
    Test.assert(!sync.refs.hasKey("partial-three"));
    Test.assert(store.file(queueTestId(1)) != null);
    Test.assert(store.file(queueTestId(2)) != null);

    var retry = new QueueDownloadTestDelegate(store, sync.refs, sync.stats);
    retry.nativeSizes = sync.nativeSizes;
    retry.onStartSync();
    var response = queueDownloadTestResponse();
    response["queue"]["items"][0]["cached_id"] = queueTestId(2);
    response["queue"]["items"][0]["size_bytes"] = 200;
    retry.onManifest(200, response);
    Test.assertEqual(retry.requested.size(), 1);
    Test.assertEqual(retry.requested[0], queueTestId(3));
    retry.addNative("download-three", 100);
    retry.onDownload(200, null);
    Test.assert(retry.completed && retry.error == null);
    Test.assert(store.file(queueTestId(1)) == null);
    Test.assert(!retry.refs.hasKey("fixture-ref"));
    Test.assertEqual(store.read()["files"].size(), 2);
    Test.assert(store.read()["lastSync"] > 0);
    return true;
}

(:test)
function queueCancellationCleansLateAudioWithoutDroppingReady(logger as Test.Logger) as Lang.Boolean {
    var store = queueTestStore();
    var sync = queueDownloadTestDelegate(store);
    sync.onStartSync(); sync.onManifest(200, queueDownloadTestResponse());
    sync.onStopSync();
    Test.assert(sync.canceled);
    Test.assert(store.read()["transfer"] != null);
    sync.addNative("late-partial", 40);
    sync.onDownload(200, null);
    Test.assert(!sync.refs.hasKey("late-partial"));
    Test.assert(store.file(queueTestId(1)) != null);
    var retry = new QueueDownloadTestDelegate(store, sync.refs, sync.stats);
    retry.nativeSizes = sync.nativeSizes;
    retry.onStartSync();
    Test.assert(store.read()["transfer"] == null);
    Test.assertEqual(retry.manifestInput["downloads"].size(), 1);
    return true;
}

(:test)
function queueOversizedTransferStopsBeforeReplacingReady(logger as Test.Logger) as Lang.Boolean {
    var store = queueTestStore();
    var sync = queueDownloadTestDelegate(store);
    sync.onStartSync(); sync.onManifest(200, queueDownloadTestResponse());
    sync.onProgress(70000, 70000);
    Test.assert(sync.canceled && sync.completed && sync.error != null);
    Test.assert(store.file(queueTestId(1)) != null);
    Test.assert(store.file(queueTestId(2)) == null);
    return true;
}
