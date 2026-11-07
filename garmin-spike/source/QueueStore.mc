using Toybox.Application;
using Toybox.Cryptography;
using Toybox.Lang;
using Toybox.Media;
using Toybox.Time;

// One persistent value commits an event, its sequence, and local completion together.
class QueueStore {
    var _key;
    function initialize(key) { _key = key; }

    function read() as Lang.Dictionary {
        var state = Application.Storage.getValue(_key);
        if (state == null) {
            var nonce = "";
            var bytes = Cryptography.randomBytes(16);
            for (var i = 0; i < bytes.size(); i += 1) { nonce += bytes[i].format("%02x"); }
            state = {"version" => 1, "nonce" => nonce, "sequence" => 0,
                "files" => [], "events" => [], "holds" => [], "current" => null,
                "transfer" => null, "lastSync" => 0, "status" => "Not synced", "finished" => 0, "pcPending" => 0};
            write(state);
        }
        if (!(state instanceof Lang.Dictionary) || state["version"] != 1) {
            throw new Lang.InvalidValueException("Queue state needs recovery");
        }
        return state;
    }

    function write(state) { Application.Storage.setValue(_key, state); }

    function file(id) as Lang.Dictionary or Null { return queueFind(read()["files"], id); }

    function complete(id, reason, now) {
        var state = read();
        var item = queueFind(state["files"], id);
        if (item == null || item["done"] == true) { return false; }
        if (state["events"].size() >= 32) { throw new Lang.InvalidValueException("Sync pending finishes first"); }
        state["sequence"] += 1;
        state["events"].add({"event_id" => state["nonce"] + "-" + state["sequence"],
            "item_id" => id, "reason" => reason, "occurred_at" => now});
        item["done"] = true;
        item["position"] = 0;
        state["finished"] += 1;
        if (id.equals(state["current"])) { state["current"] = null; }
        write(state);
        return true;
    }

    function bookmark(id, seconds) {
        if (!(seconds instanceof Lang.Number) || seconds < 0) { return; }
        var state = read();
        var item = queueFind(state["files"], id);
        if (item == null || item["done"] == true) { return; }
        item["position"] = seconds;
        state["current"] = id;
        write(state);
    }

    function acknowledge(ids, sent) {
        var state = read();
        var remaining = [];
        for (var i = 0; i < state["events"].size(); i += 1) {
            var event = state["events"][i];
            if (!queueContains(ids, event["event_id"]) || !queueContains(sent, event["event_id"])) {
                remaining.add(event);
            }
        }
        state["events"] = remaining;
        write(state);
    }

    function pendingFor(state, id) {
        for (var i = 0; i < state["events"].size(); i += 1) {
            if (id.equals(state["events"][i]["item_id"])) { return true; }
        }
        return false;
    }

    function hold(id) {
        var state = read();
        if (!queueContains(state["holds"], id)) {
            if (state["holds"].size() >= 32) { throw new Lang.InvalidValueException("Restore deleted items first"); }
            state["holds"].add(id);
        }
        if (id.equals(state["current"])) { state["current"] = null; }
        write(state);
    }

    function restoreHolds() { var state = read(); state["holds"] = []; write(state); }

    function removeFile(id) {
        var state = read();
        var retained = [];
        for (var i = 0; i < state["files"].size(); i += 1) {
            if (!id.equals(state["files"][i]["id"])) { retained.add(state["files"][i]); }
        }
        state["files"] = retained;
        if (id.equals(state["current"])) { state["current"] = null; }
        write(state);
    }

    function addFile(item, ref, bytes) {
        addFileWithBookmark(item, ref, bytes, 0);
    }

    function addFileWithBookmark(item, ref, bytes, position) {
        var state = read();
        if (state["files"].size() >= 8) { throw new Lang.InvalidValueException("Too many retained downloads"); }
        state["files"].add({"id" => item["id"], "ref" => ref, "bytes" => bytes,
            "title" => item["title"], "duration" => item["duration_seconds"],
            "position" => position, "done" => false});
        if (position > 0) { state["current"] = item["id"]; }
        write(state);
    }

    function transfer(value) { var state = read(); state["transfer"] = value; write(state); }
    function status(text, synced) {
        var state = read(); state["status"] = text;
        if (synced) { state["lastSync"] = Time.now().value(); }
        write(state);
    }
}

function queueContains(values, id) {
    for (var i = 0; i < values.size(); i += 1) { if (values[i].equals(id)) { return true; } }
    return false;
}

function queueFind(files as Lang.Array, id) as Lang.Dictionary or Null {
    for (var i = 0; i < files.size(); i += 1) { if (files[i]["id"].equals(id)) { return files[i]; } }
    return null;
}

function queueId(id) {
    if (!(id instanceof Lang.String) || id.length() != 67 || !id.substring(0, 3).equals("pj_")) { return false; }
    for (var i = 3; i < id.length(); i += 1) {
        if ("0123456789abcdef".find(id.substring(i, i + 1)) == null) { return false; }
    }
    return true;
}

function queueNumber(value) { return (value instanceof Lang.Number || value instanceof Lang.Long) && value >= 0; }

function queueDuration(value) {
    return queueNumber(value) || ((value instanceof Lang.Float || value instanceof Lang.Double) && value >= 0);
}

// Reject the complete response before acknowledging events or deleting any audio.
function queueValidResponse(data, sent) {
    if (!(data instanceof Lang.Dictionary) || data["protocol_version"] != 1 ||
        !(data["acknowledged_event_ids"] instanceof Lang.Array) || !(data["queue"] instanceof Lang.Dictionary)) { return false; }
    var acks = data["acknowledged_event_ids"];
    for (var i = 0; i < acks.size(); i += 1) {
        if (!(acks[i] instanceof Lang.String) || !queueContains(sent, acks[i])) { return false; }
    }
    var queue = data["queue"];
    if (!(queue["items"] instanceof Lang.Array) || queue["items"].size() > 3) { return false; }
    var seen = [];
    for (var i = 0; i < queue["items"].size(); i += 1) {
        var item = queue["items"][i];
        if (!(item instanceof Lang.Dictionary) || !queueId(item["id"]) || queueContains(seen, item["id"]) ||
            !(item["title"] instanceof Lang.String) || item["title"].length() > 1024 ||
            !(item["audio_url"] instanceof Lang.String) || item["audio_url"].length() > 4096 ||
            item["audio_url"].find("https://") != 0 || !queueNumber(item["size_bytes"]) || item["size_bytes"] == 0 ||
            (item["duration_seconds"] != null && !queueDuration(item["duration_seconds"])) ||
            (item["cached_id"] != null && !queueId(item["cached_id"]))) { return false; }
        seen.add(item["id"]);
    }
    var names = ["evictIds", "retireAfterDownloadIds", "protectedIds"];
    for (var n = 0; n < names.size(); n += 1) {
        var ids = queue[names[n]];
        if (!(ids instanceof Lang.Array) || ids.size() > 64) { return false; }
        for (var i = 0; i < ids.size(); i += 1) { if (!queueId(ids[i])) { return false; } }
    }
    var selected = [];
    for (var i = 0; i < queue["items"].size(); i += 1) {
        var item = queue["items"][i]; selected.add(item["id"]);
        if (item["cached_id"] != null) { selected.add(item["cached_id"]); }
    }
    var removals = [queue["evictIds"], queue["retireAfterDownloadIds"]];
    for (var n = 0; n < removals.size(); n += 1) {
        for (var i = 0; i < removals[n].size(); i += 1) {
            if (queueContains(selected, removals[n][i]) || queueContains(queue["protectedIds"], removals[n][i])) { return false; }
        }
    }
    return true;
}

function queuePlayable(state, refs) as Lang.Array<Lang.Dictionary> {
    var files = [] as Lang.Array<Lang.Dictionary>;
    var current = queueFind(state["files"], state["current"]);
    if (current != null && current["done"] != true && refs.hasKey(current["ref"]) &&
        !queueContains(state["holds"], current["id"])) { files.add(current); }
    for (var i = 0; i < state["files"].size(); i += 1) {
        var item = state["files"][i];
        if (!item["id"].equals(state["current"]) && item["done"] != true && refs.hasKey(item["ref"]) &&
            !queueContains(state["holds"], item["id"])) { files.add(item); }
    }
    return files;
}

function queueTransferLimit(expected, free, budget) {
    // Leave room for cache overhead or small publisher size variations, within both hard limits.
    var margin = (expected / 20).toLong();
    if (margin < 65536l) { margin = 65536l; }
    if (margin > 8388608l) { margin = 8388608l; }
    var limit = expected + margin;
    if (limit > free) { limit = free; }
    if (limit > budget) { limit = budget; }
    return limit < 0 ? 0l : limit;
}

function queueMayDelete(state as Lang.Dictionary, id, protectedIds, selectedIds, mode) {
    var events = state["events"];
    for (var i = 0; i < events.size(); i += 1) { if (id.equals(events[i]["item_id"])) { return false; } }
    if ("retired".equals(mode) && id.equals(state["current"])) { return false; }
    if (!"held".equals(mode) && (queueContains(protectedIds, id) || queueContains(selectedIds, id))) { return false; }
    return true;
}
