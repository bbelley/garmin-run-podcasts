using Toybox.Communications;
using Toybox.Lang;
using Toybox.Media;
using Toybox.Time;
using Toybox.WatchUi;

function queueConfigurationView() {
    var state = new QueueStore("queueV1").read();
    var ready = queuePlayable(state, cachedClipRefs());
    var minutes = 0;
    for (var i = 0; i < ready.size(); i += 1) {
        if (ready[i]["duration"] != null) { minutes += (ready[i]["duration"] - ready[i]["position"]) / 60; }
    }
    var menu = new WatchUi.Menu2({:title => "PaceJams queue"});
    menu.addItem(new WatchUi.MenuItem("Sync Now", "Wi-Fi", :sync, null));
    menu.addItem(new WatchUi.MenuItem("Ready: " + minutes.toNumber() + " min", ready.size() + " episodes", :status, null));
    for (var i = 0; i < ready.size(); i += 1) {
        var item = ready[i];
        menu.addItem(new WatchUi.MenuItem(item["title"], item["position"] > 0 ? "Saved at " + item["position"] + " s" : "Ready offline", item["id"], null));
    }
    menu.addItem(new WatchUi.MenuItem("Pending finishes: " + state["events"].size(), "Finished: " + state["finished"], :status, null));
    menu.addItem(new WatchUi.MenuItem("Pocket Casts pending: " + state["pcPending"], "Account updates sent separately", :status, null));
    var age = state["lastSync"] == 0 ? "Never" : ((Time.now().value() - state["lastSync"]) / 60).toNumber() + " min ago";
    menu.addItem(new WatchUi.MenuItem("Last sync: " + age, state["status"], :status, null));
    if (state["holds"].size() > 0) { menu.addItem(new WatchUi.MenuItem("Restore Deleted", "Allow downloads again", :restore, null)); }
    if (cachedClip() != null && queueFind(state["files"], LocalConfig.LEGACY_ITEM_ID) == null) {
        menu.addItem(new WatchUi.MenuItem("Previous test clip", "Old bookmark preserved", :legacy, null));
    }
    return [menu, new QueueMenuDelegate()];
}

class QueueMenuDelegate extends WatchUi.Menu2InputDelegate {
    function initialize() { Menu2InputDelegate.initialize(); }
    function onSelect(item) {
        var id = item.getId();
        if (id == :sync) { Communications.startSync(); }
        else if (id == :restore) { new QueueStore("queueV1").restoreHolds(); WatchUi.popView(WatchUi.SLIDE_IMMEDIATE); }
        else if (id == :legacy) { Media.startPlayback({"legacy" => true}); }
        else if (id instanceof Lang.String) {
            var file = new QueueStore("queueV1").file(id);
            if (file == null) { return; }
            var menu = new WatchUi.Menu2({:title => file["title"]});
            menu.addItem(new WatchUi.MenuItem("Play / Resume", null, :play, null));
            menu.addItem(new WatchUi.MenuItem("Skip for now", "Play next ready episode", :skip, null));
            menu.addItem(new WatchUi.MenuItem("Mark Finished", "Record completion", :finish, null));
            menu.addItem(new WatchUi.MenuItem("Delete Download", "Keep unplayed; hold download", :delete, null));
            WatchUi.pushView(menu, new QueueItemDelegate(id), WatchUi.SLIDE_IMMEDIATE);
        }
    }
}

class QueueItemDelegate extends WatchUi.Menu2InputDelegate {
    var _id;
    function initialize(id) { Menu2InputDelegate.initialize(); _id = id; }
    function onSelect(item) {
        var action = item.getId();
        if (action == :play) { Media.startPlayback({"item_id" => _id}); return; }
        if (action == :skip) {
            var files = queuePlayable(new QueueStore("queueV1").read(), cachedClipRefs());
            for (var i = 0; i < files.size(); i += 1) {
                if (files[i]["id"].equals(_id) && i + 1 < files.size()) { Media.startPlayback({"item_id" => files[i + 1]["id"]}); return; }
            }
            return;
        }
        if (action == :finish || action == :delete) {
            var menu = new WatchUi.Menu2({:title => action == :finish ? "Mark Finished?" : "Delete download?"});
            menu.addItem(new WatchUi.MenuItem("Yes", null, :confirm, null));
            menu.addItem(new WatchUi.MenuItem("Cancel", null, :cancel, null));
            WatchUi.pushView(menu, new QueueConfirmDelegate(_id, action), WatchUi.SLIDE_IMMEDIATE);
        }
    }
}

class QueueConfirmDelegate extends WatchUi.Menu2InputDelegate {
    var _id; var _action;
    function initialize(id, action) { Menu2InputDelegate.initialize(); _id = id; _action = action; }
    function onSelect(item) {
        if (item.getId() == :confirm) {
            var store = new QueueStore("queueV1");
            try {
                var file = store.file(_id);
                if (_id.equals(store.read()["current"])) { Media.stopPlayback(); }
                if (_action == :finish) { store.complete(_id, "mark_finished", Time.now().value()); }
                else if (file != null) {
                    store.hold(_id);
                    var ref = cachedClipRefs()[file["ref"]];
                    if (ref != null) { Media.deleteCachedItem(ref); }
                    store.removeFile(_id);
                }
            } catch (exception) { try { store.status("Could not save action; sync again", false); } catch (saveException) {} }
        }
        WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
    }
}
