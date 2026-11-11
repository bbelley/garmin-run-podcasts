using Toybox.Lang;
using Toybox.Media;
using Toybox.System;
using Toybox.Time;

class QueueContentDelegate extends Media.ContentDelegate {
    var _iterator;
    var _startId;
    var _store as QueueStore;
    function initialize(startId) {
        ContentDelegate.initialize(); _startId = startId;
        _store = new QueueStore("queueV1"); resetContentIterator();
    }
    function getContentIterator() { return _iterator; }
    function resetContentIterator() { _iterator = new QueueIterator(_startId, _store); return _iterator; }
    function onSong(contentRefId, event, position) {
        try {
            var files = _store.read()["files"];
            for (var i = 0; i < files.size(); i += 1) {
                if (!files[i]["ref"].equals(contentRefId.toString())) { continue; }
                queueSongEvent(_store, files[i]["id"], event, position, Time.now().value());
                break;
            }
            System.println("PaceJams queue song event=" + event + " position=" + position +
                " pending=" + _store.read()["events"].size());
        } catch (exception) { System.println("PaceJams playback state could not be saved; download retained"); }
    }
}

function queueSongEvent(store as QueueStore, id, event, position, now) {
    if (event == Media.SONG_EVENT_COMPLETE) { store.complete(id, "natural_end", now); }
    else if (event == Media.SONG_EVENT_START || event == Media.SONG_EVENT_RESUME) {
        var state = store.read();
        var file = queueFind(state["files"], id);
        if (file != null && file["done"] != true) { state["current"] = id; store.write(state); }
    } else if (event == Media.SONG_EVENT_PAUSE || event == Media.SONG_EVENT_STOP ||
        event == Media.SONG_EVENT_SKIP_FORWARD || event == Media.SONG_EVENT_SKIP_BACKWARD ||
        event == Media.SONG_EVENT_SKIP_NEXT || event == Media.SONG_EVENT_SKIP_PREVIOUS) {
        store.bookmark(id, position);
    }
}

class QueueIterator extends Media.ContentIterator {
    var _ids = [];
    var _index = 0;
    var _store as QueueStore;
    function initialize(startId, store) {
        ContentIterator.initialize(); _store = store;
        var files = queuePlayable(store.read(), cachedClipRefs());
        for (var i = 0; i < files.size(); i += 1) {
            _ids.add(files[i]["id"]);
            if (files[i]["id"].equals(startId)) { _index = i; }
        }
    }
    function contentAt(index) {
        if (index < 0 || index >= _ids.size()) { return null; }
        var file = _store.file(_ids[index]);
        if (file == null || file["done"] == true) { return null; }
        var ref = cachedClipRefs()[file["ref"]];
        if (ref == null) { return null; }
        var metadata = new Media.ContentMetadata();
        metadata.title = file["title"];
        metadata.artist = "PaceJams";
        metadata.album = "Running queue";
        return new Media.ActiveContent(ref, metadata, file["position"]);
    }
    function get() { return contentAt(_index); }
    function peekNext() { return contentAt(_index + 1); }
    function peekPrevious() { return contentAt(_index - 1); }
    function next() { _index += 1; return get(); }
    function previous() { if (_index > 0) { _index -= 1; } return get(); }
    function canSkip() { return true; }
    function repeatMode() { return Media.REPEAT_MODE_OFF; }
    function getPlaybackProfile() {
        var profile = new Media.PlaybackProfile();
        profile.playbackControls = [Media.PLAYBACK_CONTROL_PLAYBACK,
            Media.PLAYBACK_CONTROL_SKIP_BACKWARD, Media.PLAYBACK_CONTROL_SKIP_FORWARD];
        return profile;
    }
}
