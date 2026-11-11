using Toybox.Communications;
using Toybox.Lang;
using Toybox.Media;
using Toybox.PersistedContent;
using Toybox.System;

class QueueSyncDelegate extends Communications.SyncDelegate {
    var _store as QueueStore;
    var _active = false;
    var _queue as Lang.Dictionary or Null;
    var _sent = [];
    var _index = 0;
    var _item as Lang.Dictionary or Null;
    var _limit = 0l;
    var _notice = "Synced";

    function initialize() { SyncDelegate.initialize(); _store = new QueueStore("queueV1"); }
    function isSyncNeeded() { return true; }

    function onStartSync() {
        _active = true;
        try {
            recoverTransfer(true);
            reconcileFiles();
            adoptLegacy();
            var state = _store.read();
            var stats = cacheUsage();
            var downloads = [];
            for (var i = 0; i < state["files"].size(); i += 1) {
                var file = state["files"][i];
                downloads.add({"id" => file["id"], "bytes" => file["bytes"]});
            }
            _sent = [];
            for (var i = 0; i < state["events"].size(); i += 1) { _sent.add(state["events"][i]["event_id"]); }
            var input = {"protocol_version" => 1, "events" => state["events"], "downloads" => downloads,
                "inProgressId" => state["current"], "suppressedIds" => state["holds"],
                "storage" => {"capacityBytes" => stats.capacity, "usedBytes" => stats.size,
                    "budgetBytes" => LocalConfig.CACHE_BUDGET, "reserveBytes" => LocalConfig.CACHE_RESERVE}};
            _store.status("Fetching queue", false);
            System.println("PaceJams queue sync pending=" + _sent.size() + " capacity=" + stats.capacity + " used=" + stats.size);
            requestManifest(input);
        } catch (exception) { finish("Could not start sync"); }
    }

    // Keep native I/O at this boundary so the same state machine can be fault-tested.
    function cacheRefs() as Lang.Dictionary { return cachedClipRefs(); }
    function cacheUsage() { return Media.getCacheStatistics(); }
    function removeNative(ref) { Media.deleteCachedItem(ref); }
    function cancelRequests() { Communications.cancelAllRequests(); }
    function emitCompletion(error) { Communications.notifySyncComplete(error); }
    function syncProgress(percent) { Communications.notifySyncProgress(percent); }

    function requestManifest(input) {
        Communications.makeWebRequest(LocalConfig.SYNC_URL, input, {
                :method => Communications.HTTP_REQUEST_METHOD_POST,
                :headers => {"Content-Type" => Communications.REQUEST_CONTENT_TYPE_JSON,
                    "Authorization" => "Bearer " + LocalConfig.WATCH_TOKEN},
                :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_JSON
        }, method(:onManifest));
    }

    function onStopSync() {
        if (!_active) { return; }
        _active = false;
        cancelRequests();
        // Keep the transfer journal until cancellation has settled or the next sync recovers it.
        try { recoverTransfer(false); _store.status("Sync canceled; ready audio kept", false); } catch (exception) {}
        emitCompletion(null);
    }

    function onManifest(code as Lang.Number,
        data as Lang.ByteArray or Lang.Dictionary or Lang.String or PersistedContent.Iterator or Null) as Void {
        if (!_active) { return; }
        if (code != 200) { finish(code == 401 ? "Watch connection needs setup" : "Queue request failed (" + code + ")"); return; }
        if (!queueValidResponse(data, _sent)) { finish("Invalid queue; ready audio kept"); return; }
        try {
            var response = data as Lang.Dictionary;
            _store.acknowledge(response["acknowledged_event_ids"], _sent);
            _queue = response["queue"] as Lang.Dictionary;
            deleteIds(_queue["evictIds"], "completed");
            // A local Delete Download hold is independent from played state.
            deleteIds(_store.read()["holds"], "held");
            _index = 0;
            _notice = queueSyncNotice(response);
            var state = _store.read();
            state["pcPending"] = queuePendingDelivery(response);
            _store.write(state);
            _store.status("reconnect_required".equals(response["pocket_casts_connection"]) ? "Pocket Casts reconnect needed" : "Downloading queue", false);
            startNext();
        } catch (exception) { finish("Queue storage or cleanup failed"); }
    }

    function startNext() {
        if (!_active) { return; }
        while (_index < _queue["items"].size()) {
            _item = _queue["items"][_index];
            var cachedId = _item["cached_id"] == null ? _item["id"] : _item["cached_id"];
            var file = _store.file(cachedId);
            if (file != null && cacheRefs().hasKey(file["ref"])) { _index += 1; continue; }
            var stats = cacheUsage();
            var selectedBytes = 0l;
            for (var j = 0; j < _queue["items"].size(); j += 1) {
                var selected = _queue["items"][j];
                var selectedId = selected["cached_id"] == null ? selected["id"] : selected["cached_id"];
                var ready = _store.file(selectedId);
                if (ready != null) { selectedBytes += ready["bytes"]; }
            }
            _limit = queueTransferLimit(_item["size_bytes"], stats.capacity - stats.size - LocalConfig.CACHE_RESERVE,
                LocalConfig.CACHE_BUDGET - selectedBytes);
            if (_limit < _item["size_bytes"]) { finish("Low space; ready audio kept"); return; }
            var refs = cacheRefs();
            _store.transfer({"before" => refs.keys(), "bytes" => stats.size, "id" => _item["id"]});
            requestAudio(_item);
            return;
        }
        deleteIds(_queue["retireAfterDownloadIds"], "retired");
        reorderFiles();
        finish(null);
    }

    function requestAudio(item) {
        Communications.makeWebRequest(item["audio_url"], null, {
                :method => Communications.HTTP_REQUEST_METHOD_GET,
                :responseType => Communications.HTTP_RESPONSE_CONTENT_TYPE_AUDIO,
                :mediaEncoding => Media.ENCODING_MP3,
                :fileDownloadProgressCallback => method(:onProgress)
        }, method(:onDownload));
    }

    function onProgress(transferred as Lang.Number, size as Lang.Number or Null) as Void {
        if (!_active) { return; }
        if (transferred > _limit || (size != null && size > _limit)) {
            _active = false;
            cancelRequests();
            try { recoverTransfer(false); _store.status("Download size changed; sync again", false); } catch (exception) {}
            emitCompletion("Download size changed; sync again");
            return;
        }
        var expected = size == null || size == 0 ? _item["size_bytes"] : size;
        var percent = ((100.0 * transferred / expected + _index * 100) / _queue["items"].size()).toNumber();
        syncProgress(percent > 99 ? 99 : percent);
    }

    function onDownload(code as Lang.Number,
        data as Lang.ByteArray or Lang.Dictionary or Lang.String or PersistedContent.Iterator or Null) as Void {
        if (!_active) { try { recoverTransfer(false); } catch (exception) {} return; }
        try {
            var journal = _store.read()["transfer"];
            if (journal == null) { finish("Download journal missing"); return; }
            var refs = cacheRefs();
            var ids = refs.keys();
            var added = [];
            for (var i = 0; i < ids.size(); i += 1) { if (!queueContains(journal["before"], ids[i])) { added.add(ids[i]); } }
            var bytes = cacheUsage().size - journal["bytes"];
            System.println("PaceJams queue download response=" + code + " added=" + added.size() + " bytes=" + bytes);
            if (code != 200 || added.size() != 1 || bytes <= 0 || bytes > _limit) {
                recoverTransfer(true);
                finish("MP3 download failed (" + code + "); ready audio kept");
                return;
            }
            var title = _item["title"];
            if (title.length() > 180) { _item["title"] = title.substring(0, 180); }
            _store.addFile(_item, added[0], bytes);
            _store.transfer(null);
            _index += 1;
            startNext();
        } catch (exception) {
            try { recoverTransfer(true); } catch (cleanupException) {}
            finish("Download storage failed; ready audio kept");
        }
    }

    function reconcileFiles() {
        var state = _store.read();
        var refs = cacheRefs();
        var files = state["files"];
        for (var i = 0; i < files.size(); i += 1) {
            if (!refs.hasKey(files[i]["ref"])) { _store.removeFile(files[i]["id"]); }
        }
    }

    function adoptLegacy() {
        if (_store.read()["files"].size() != 0 || !queueId(LocalConfig.LEGACY_ITEM_ID)) { return; }
        var clip = cachedClip();
        var refs = cacheRefs();
        if (clip == null || refs.size() != 1) { return; }
        var bytes = cacheUsage().size;
        if (bytes <= 0) { return; }
        _store.addFileWithBookmark({"id" => LocalConfig.LEGACY_ITEM_ID, "title" => "Previous clip",
            "duration_seconds" => null}, clip.getContentRef().getId().toString(), bytes, savedClipPosition(clip));
    }

    function recoverTransfer(clear) {
        var state = _store.read();
        var journal = state["transfer"];
        if (journal == null) { return; }
        var refs = cacheRefs();
        var ids = refs.keys();
        var known = [];
        for (var i = 0; i < state["files"].size(); i += 1) { known.add(state["files"][i]["ref"]); }
        for (var i = 0; i < ids.size(); i += 1) {
            if (!queueContains(journal["before"], ids[i]) && !queueContains(known, ids[i])) { removeNative(refs[ids[i]]); }
        }
        if (clear) { _store.transfer(null); }
    }

    function deleteIds(ids, mode) {
        var state = _store.read();
        var refs = cacheRefs();
        var selected = [];
        for (var i = 0; i < _queue["items"].size(); i += 1) {
            var item = _queue["items"][i]; selected.add(item["id"]);
            if (item["cached_id"] != null) { selected.add(item["cached_id"]); }
        }
        for (var i = 0; i < ids.size(); i += 1) {
            var id = ids[i];
            var file = queueFind(state["files"], id);
            if (file == null || !queueMayDelete(state, id, _queue["protectedIds"], selected, mode)) { continue; }
            if (refs.hasKey(file["ref"])) { removeNative(refs[file["ref"]]); }
            _store.removeFile(id);
        }
    }

    function reorderFiles() {
        var state = _store.read();
        var ordered = [];
        for (var i = 0; i < _queue["items"].size(); i += 1) {
            var item = _queue["items"][i];
            var id = item["cached_id"] == null ? item["id"] : item["cached_id"];
            var file = queueFind(state["files"], id);
            if (file != null) {
                var title = item["title"];
                file["title"] = title.length() > 180 ? title.substring(0, 180) : title;
                file["duration"] = item["duration_seconds"];
                ordered.add(file);
            }
        }
        for (var i = 0; i < state["files"].size(); i += 1) {
            var file = state["files"][i];
            if (queueFind(ordered, file["id"]) == null) { ordered.add(file); }
        }
        state["files"] = ordered;
        _store.write(state);
    }

    function finish(error) {
        if (!_active) { return; }
        _active = false;
        try { _store.status(error == null ? _notice : error, error == null); } catch (exception) {}
        if (error == null) { syncProgress(100); }
        emitCompletion(error);
    }
}

function queuePendingDelivery(response as Lang.Dictionary) {
    var status = response["pocket_casts_delivery"];
    var total = 0;
    if (status instanceof Lang.Dictionary) {
        var names = ["pending", "processing", "auth_required"];
        for (var i = 0; i < names.size(); i += 1) { if (queueNumber(status[names[i]])) { total += status[names[i]]; } }
    }
    return total;
}

function queueSyncNotice(response as Lang.Dictionary) {
    if ("reconnect_required".equals(response["pocket_casts_connection"])) { return "Pocket Casts reconnect needed"; }
    if ("setup_required".equals(response["pocket_casts_connection"])) { return "Pocket Casts setup needed"; }
    var sources = response["sources"];
    if (sources instanceof Lang.Dictionary && (sources["pocketcasts_stale"] == true || sources["uploads_stale"] == true)) {
        return "Synced using saved selection";
    }
    var deferred = response["queue"]["deferred"];
    if (deferred instanceof Lang.Array && deferred.size() > 0) { return "Some episodes deferred"; }
    return "Synced";
}
