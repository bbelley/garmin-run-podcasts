using Toybox.Communications;
using Toybox.Lang;
using Toybox.Media;
using Toybox.Time;
using Toybox.WatchUi;

function queueConfigurationView() {
    var menu = new QueueMenu();
    menu.refresh();
    return [menu, new QueueMenuDelegate(menu)];
}

class QueueMenu extends WatchUi.Menu2 {
    function initialize() { Menu2.initialize({:title => "PaceJams queue"}); }
    function refresh() {
        rebuild(new QueueStore("queueV1").read(), cachedClipRefs(), cachedClip() != null);
    }
    function rebuild(state, refs, hasLegacy) {
        // Reuse the menu already on the view stack; repainting alone leaves stale rows.
        var hadRows = getItem(0) != null;
        while (getItem(0) != null) { deleteItem(0); }
        var ready = queuePlayable(state, refs);
        var minutes = 0;
        for (var i = 0; i < ready.size(); i += 1) {
            if (ready[i]["duration"] != null) { minutes += (ready[i]["duration"] - ready[i]["position"]) / 60; }
        }
        addItem(new WatchUi.MenuItem("Sync Now", "Wi-Fi", :sync, null));
        addItem(new WatchUi.MenuItem("Ready: " + minutes.toNumber() + " min", ready.size() + " episodes", :ready, null));
        for (var i = 0; i < ready.size(); i += 1) {
            var item = ready[i];
            addItem(new WatchUi.MenuItem(item["title"], item["position"] > 0 ? "Saved at " + item["position"] + " s" : "Ready offline", item["id"], null));
        }
        addItem(new WatchUi.MenuItem("Pending finishes: " + state["events"].size(), "Finished: " + state["finished"], :finishes, null));
        addItem(new WatchUi.MenuItem("Pocket Casts pending: " + state["pcPending"], "Account updates sent separately", :delivery, null));
        var age = state["lastSync"] == 0 ? "Never" : ((Time.now().value() - state["lastSync"]) / 60).toNumber() + " min ago";
        addItem(new WatchUi.MenuItem("Last sync: " + age, state["status"], :lastSync, null));
        if (state["holds"].size() > 0) { addItem(new WatchUi.MenuItem("Restore Deleted", "Allow downloads again", :restore, null)); }
        if (hasLegacy && queueFind(state["files"], LocalConfig.LEGACY_ITEM_ID) == null) {
            addItem(new WatchUi.MenuItem("Previous test clip", "Old bookmark preserved", :legacy, null));
        }
        setFocus(hadRows ? (ready.size() > 0 ? 2 : 1) : 0);
    }
}

class QueueMenuDelegate extends WatchUi.Menu2InputDelegate {
    var _queueMenu;
    function initialize(menu) { Menu2InputDelegate.initialize(); _queueMenu = menu; }
    function onSelect(item) {
        var id = item.getId();
        if (id == :sync) { Communications.startSync(); }
        else if (id == :restore) { new QueueStore("queueV1").restoreHolds(); _queueMenu.refresh(); }
        else if (id == :legacy) { Media.startPlayback({"legacy" => true}); }
        else if (id instanceof Lang.String) {
            var file = new QueueStore("queueV1").file(id);
            if (file == null) { return; }
            var menu = new WatchUi.Menu2({:title => file["title"]});
            menu.addItem(new WatchUi.MenuItem("Play / Resume", null, :play, null));
            menu.addItem(new WatchUi.MenuItem("Skip for now", "Play next ready episode", :skip, null));
            menu.addItem(new WatchUi.MenuItem("Mark Finished", "Record completion", :finish, null));
            menu.addItem(new WatchUi.MenuItem("Delete Download", "Keep unplayed; hold download", :delete, null));
            WatchUi.pushView(menu, new QueueItemDelegate(id, _queueMenu), WatchUi.SLIDE_IMMEDIATE);
        }
    }
}

class QueueItemDelegate extends WatchUi.Menu2InputDelegate {
    var _id; var _queueMenu;
    function initialize(id, menu) { Menu2InputDelegate.initialize(); _id = id; _queueMenu = menu; }
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
            WatchUi.pushView(menu, new QueueConfirmDelegate(_id, action, _queueMenu), WatchUi.SLIDE_IMMEDIATE);
        }
    }
}

class QueueConfirmDelegate extends WatchUi.Menu2InputDelegate {
    var _id; var _action; var _queueMenu;
    function initialize(id, action, menu) { Menu2InputDelegate.initialize(); _id = id; _action = action; _queueMenu = menu; }
    function actionStore() { return new QueueStore("queueV1"); }
    function cacheRefs() { return cachedClipRefs(); }
    function stopPlayback() { Media.stopPlayback(); }
    function deleteCached(ref) { Media.deleteCachedItem(ref); }
    function dismiss(confirmed) {
        WatchUi.popView(WatchUi.SLIDE_IMMEDIATE);
        // Yes closes the obsolete episode actions too; Cancel leaves them open.
        if (confirmed) { WatchUi.popView(WatchUi.SLIDE_IMMEDIATE); }
    }
    function onSelect(item) {
        if (item.getId() == :confirm) {
            var store = actionStore();
            try {
                var file = store.file(_id);
                if (_id.equals(store.read()["current"])) { stopPlayback(); }
                if (_action == :finish) { store.complete(_id, "mark_finished", Time.now().value()); }
                else if (file != null) {
                    store.hold(_id);
                    var ref = cacheRefs()[file["ref"]];
                    if (ref != null) { deleteCached(ref); }
                    store.removeFile(_id);
                }
            } catch (exception) { try { store.status("Could not save action; sync again", false); } catch (saveException) {} }
            _queueMenu.refresh();
            dismiss(true);
            return;
        }
        dismiss(false);
    }
}
