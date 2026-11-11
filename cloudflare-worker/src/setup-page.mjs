const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow"><title>PaceJams setup</title>
<link rel="stylesheet" href="/setup/style.css"><script src="/setup/qr.js" defer></script><script src="/setup/app.js" defer></script></head>
<body><main><header><div class="brand">PaceJams<span class="dot"></span></div><p>Your listening. Ready to run.</p></header>
<section id="locked" class="card"><p class="eyebrow">Private setup</p><h1>A private link gets you in.</h1>
<p>Open a new setup link from the computer where PaceJams is configured. Links work once and expire after five minutes.</p></section>
<div id="workspace" hidden><section class="card"><div class="row"><div><p class="eyebrow">Account</p><h1>Pocket Casts</h1></div>
<span id="connection" class="badge">Checking</span></div><p id="account-detail">Checking your connection.</p>
<div class="actions"><button id="check" type="button">Check connection</button><button id="refresh" class="secondary" type="button">Refresh status</button></div>
<div class="delivery"><h2>Completion updates</h2><p id="delivery"></p><p id="writeback"></p></div></section>
<section class="card"><p class="eyebrow">Take setup with you</p><h2>Open on your phone.</h2>
<p>Show a private code, then scan it with your phone's camera. It opens this account setup page for one hour.</p>
<button id="phone" class="secondary" type="button">Show phone setup code</button>
<div id="phone-panel" hidden><img id="phone-qr" alt="Private one-time phone setup QR code" width="305" height="305">
<p class="hint">Scan within five minutes. This private link works once.</p>
<label for="phone-link">Private setup link</label><input id="phone-link" type="text" readonly autocomplete="off">
<div class="actions phone-actions"><button id="phone-copy" type="button">Copy private link</button><button id="phone-cancel" class="secondary" type="button">Close code</button></div>
<p class="hint">Closing the code cancels an unused link. A phone that already opened setup stays signed in until you sign out there.</p></div></section>
<section class="card"><p class="eyebrow">Connect or reconnect</p><h2>Keep your running playlist in sync.</h2>
<p>Use your existing Pocket Casts account. Your password is used to connect and is not saved by PaceJams.</p>
<form id="connect-form"><fieldset id="fields"><label for="email">Pocket Casts email</label>
<input id="email" name="email" type="email" maxlength="320" autocomplete="username" required>
<label for="password">Pocket Casts password</label><input id="password" name="password" type="password" maxlength="1024" autocomplete="current-password" required>
<p class="hint">Using Google or Apple? Use the Pocket Casts password added to that same account.</p>
<label for="playlist">Playlist name</label><input id="playlist" name="playlist" type="text" maxlength="256" placeholder="Your manual running playlist" required>
<p class="hint">Enter the exact name of a regular playlist. Up Next and Smart Playlists are separate.</p>
<button id="connect" type="submit">Connect Pocket Casts</button></fieldset></form></section>
<footer><button id="logout" class="text" type="button">Sign out of setup</button>
<p>Signing out closes this setup session. Your watch keeps its Pocket Casts connection.</p></footer></div>
<p id="message" role="status" aria-live="polite"></p><p class="footnote">PaceJams uses an unofficial Pocket Casts connection. Uploads remain available if that connection needs attention.</p>
</main></body></html>`;

const css = `:root{color-scheme:light;--ink:#16342f;--muted:#526960;--green:#1b5945;--line:#dce5dd;--paper:#f5f7f0}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.55 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:44px 22px 28px}header{margin-bottom:30px}.brand{font-size:32px;letter-spacing:-1.5px;font-weight:800}.dot{display:inline-block;width:9px;height:9px;border-radius:50%;background:#d7b74c;margin-left:5px}header p{margin:2px 0;color:var(--muted)}
.card{background:white;border:1px solid var(--line);border-radius:20px;padding:28px;margin:0 0 20px;box-shadow:0 3px 18px #153c2605}.eyebrow{text-transform:uppercase;font-size:11px;letter-spacing:1.8px;font-weight:750;color:var(--green);margin:0 0 8px}h1,h2{line-height:1.2;letter-spacing:-.6px;margin:0 0 14px}h1{font-size:29px}h2{font-size:23px}p{margin:0 0 16px;color:var(--muted)}
.row{display:flex;gap:16px;justify-content:space-between;align-items:center}.badge{border-radius:100px;padding:6px 12px;background:#eef3ed;font-size:13px;white-space:nowrap}.badge[data-state=connected]{background:#dfefdf;color:#215432}.actions{display:flex;flex-wrap:wrap;gap:10px}button{font:inherit;font-weight:650;background:var(--green);border:1px solid var(--green);color:white;border-radius:10px;padding:11px 17px;cursor:pointer}button:hover{filter:brightness(.94)}button:disabled{opacity:.55;cursor:wait}.secondary{background:white;color:var(--green);border-color:var(--line)}.delivery{border-top:1px solid var(--line);padding-top:22px;margin-top:24px}.delivery h2{font-size:17px;margin-bottom:10px}.delivery p{font-size:14px;margin-bottom:7px}
fieldset{border:0;padding:0;margin:0}label{display:block;font-size:14px;font-weight:650;margin:18px 0 7px}input{font:inherit;color:var(--ink);background:#fcfdfb;border:1px solid #bdcfc2;border-radius:9px;padding:11px 13px;width:100%;min-width:0}input:focus{outline:3px solid #d5e8d8;outline-offset:1px}.hint{font-size:13px;margin-top:7px}form button{margin-top:8px}.text{background:none;color:var(--green);border:0;padding:4px 0}footer p,.footnote{font-size:12px;margin:6px 0;color:var(--muted)}#message:not(:empty){padding:15px 18px;background:#e5eddf;border-radius:12px;margin:20px 0}#message[data-error=true]{background:#f9e9de;color:#773d1e}button:focus-visible{outline:3px solid #d7b74c;outline-offset:3px}[hidden]{display:none!important}
#phone-qr{display:block;max-width:100%;height:auto;margin:22px auto 8px;image-rendering:pixelated}#phone-link{font-size:12px}.phone-actions{margin-top:12px}#phone-panel{margin-top:12px}
@media(max-width:480px){main{padding:28px 16px}.card{padding:22px}.row{align-items:flex-start;flex-direction:column;gap:3px}.row h1{margin-bottom:5px}.badge{margin-bottom:12px}.actions button{flex:1}h2{font-size:21px}}`;

// Keep client code as text so the Worker bundler cannot add server-only helpers.
const clientScript = String.raw`(function browserClient() {
    const byId = id => document.getElementById(id);
    let csrf = null;
    let busy = false;
    let phoneCode = null;
    let phoneTimer = null;
    const messages = {
        setup_link_invalid: "This setup link has expired or was already used. Open a new private link.",
        unauthorized: "Your setup session has expired. Open a new private link.",
        account_sign_in_rejected: "Pocket Casts rejected that sign-in. Check the account email and Pocket Casts password.",
        playlist_missing: "No regular playlist matched that name. Check the exact name and that Pocket Casts has synced.",
        playlist_ambiguous: "More than one playlist has that name. Give the intended playlist a unique name and try again.",
        playlist_limit: "This build supports up to 32 entries. Choose a smaller running playlist for now.",
        account_fields_required: "Enter your account email, password, and playlist name.",
        pocket_casts_check_failed: "The account check did not complete. Refresh the status or reconnect your account.",
    };
    function message(text, error = false) { byId("message").textContent = text; byId("message").dataset.error = String(error); }
    function clearPhoneLink() {
        if (phoneTimer) clearTimeout(phoneTimer);
        phoneTimer = null; phoneCode = null;
        byId("phone-panel").hidden = true; byId("phone-qr").removeAttribute("src"); byId("phone-link").value = "";
    }
    async function closePhoneLink() {
        const code = phoneCode;
        if (code) await api("/v1/admin/setup-links/revoke", { code });
        if (phoneCode === code) clearPhoneLink();
    }
    function locked() { csrf = null; clearPhoneLink(); byId("connect-form").reset(); byId("workspace").hidden = true; byId("locked").hidden = false; }
    function setBusy(value) {
        busy = value;
        for (const id of ["check", "refresh", "logout", "connect", "phone", "phone-copy", "phone-cancel"]) byId(id).disabled = value;
        byId("fields").disabled = value;
    }
    async function api(path, body, method, retried = false) {
        const headers = {};
        if (body !== undefined) headers["Content-Type"] = "application/json";
        if (csrf && method !== "GET") headers["X-PaceJams-CSRF"] = csrf;
        const response = await fetch(path, { method: method ?? (body === undefined ? "GET" : "POST"),
            headers, body: body === undefined ? undefined : JSON.stringify(body), credentials: "same-origin", cache: "no-store" });
        const result = await response.json().catch(() => ({ error: "request_failed" }));
        // Another setup tab can replace the same browser's cookie. No mutation occurred
        // when the server rejected the old CSRF value, so refresh it and retry once.
        if (response.status === 403 && result.error === "csrf_required" && !retried) {
            csrf = (await api("/v1/admin/browser-session", undefined, "GET", true)).csrf_token;
            return api(path, body, method, true);
        }
        if (!response.ok || result.error === "request_failed") {
            if (["unauthorized", "setup_link_invalid"].includes(result.error)) locked();
            throw new Error(messages[result.error] ?? "Could not complete that request. Please try again.");
        }
        return result;
    }
    async function refresh() {
        const result = await api("/v1/admin/status");
        const states = { connected: "Connected", setup_required: "Not connected", reconnect_required: "Reconnect needed" };
        byId("connection").textContent = states[result.pocket_casts] ?? "Check needed";
        byId("connection").dataset.state = result.pocket_casts;
        byId("account-detail").textContent = result.pocket_casts === "connected" ?
            "Your account is connected. Check connection to verify renewal and playlist access." : "Connect your account below. Your uploaded audio remains available.";
        const delivery = result.delivery;
        const waiting = (delivery.pending ?? 0) + (delivery.processing ?? 0) + (delivery.auth_required ?? 0);
        byId("delivery").textContent = "Waiting: " + waiting + " · Delivered: " + (delivery.delivered ?? 0);
        byId("writeback").textContent = result.writeback_enabled ?
            "Verified finishes are delivered separately from watch sync acknowledgements." :
            "Played-status updates are paused while the watch integration is tested. Finishes remain queued.";
        byId("workspace").hidden = false; byId("locked").hidden = true;
    }
    async function action(work) {
        if (busy) return;
        setBusy(true); message("");
        try { await work(); } catch (error) { message(error.message, true); } finally { setBusy(false); }
    }
    byId("refresh").addEventListener("click", () => action(refresh));
    byId("check").addEventListener("click", () => action(async () => {
        try { await api("/v1/admin/pocket-casts/check", {}); await refresh(); message("Session renewal and playlist read passed."); }
        catch (error) { await refresh().catch(() => {}); throw error; }
    }));
    byId("logout").addEventListener("click", () => action(async () => {
        await closePhoneLink();
        await api("/v1/admin/browser-session", undefined, "DELETE"); locked(); message("Signed out of setup. Your watch connection is unchanged.");
    }));
    byId("phone").addEventListener("click", () => action(async () => {
        if (typeof qrcode !== "function") throw new Error("Phone setup is unavailable in this build. Reload the page and try again.");
        await closePhoneLink();
        const result = await api("/v1/admin/setup-links", { phone_handoff: true });
        phoneCode = result.code;
        const qr = qrcode(0, "M"); qr.addData(result.setup_url, "Byte"); qr.make();
        byId("phone-qr").src = qr.createDataURL(5, 20); byId("phone-link").value = result.setup_url;
        byId("phone-panel").hidden = false;
        phoneTimer = setTimeout(() => {
            clearPhoneLink(); if (!busy) message("Phone setup code expired. Show a new code to try again.");
        }, result.expires_in * 1000);
    }));
    byId("phone-cancel").addEventListener("click", () => action(async () => {
        await closePhoneLink(); message("Phone setup code closed.");
    }));
    byId("phone-copy").addEventListener("click", () => action(async () => {
        try { await navigator.clipboard.writeText(byId("phone-link").value); message("Private setup link copied. It works once and expires after five minutes."); }
        catch { message("Copy the private link from the field below the code.", true); }
    }));
    byId("connect-form").addEventListener("submit", event => {
        event.preventDefault();
        if (busy) return;
        const input = { email: byId("email").value, password: byId("password").value, playlist_name: byId("playlist").value };
        byId("password").value = "";
        action(async () => {
            try { await api("/v1/admin/pocket-casts/connect", input); await refresh(); message("Pocket Casts connected. Your playlist is ready for the next watch sync."); }
            finally { input.password = ""; }
        });
    });
    // Strip the single-use code before making API requests or loading account state.
    const fragment = new URLSearchParams(location.hash.slice(1));
    let code = fragment.get("code");
    history.replaceState(null, "", location.pathname);
    action(async () => {
        let session;
        try { session = code ? await api("/v1/setup/session", { code }) : await api("/v1/admin/browser-session"); }
        finally { code = null; fragment.delete("code"); }
        csrf = session.csrf_token;
        await refresh();
    });
})();`;

export function setupAsset(request, qrScript) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path !== "/setup" && !path.startsWith("/setup/")) return null;
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        url.protocol = "https:";
        return Response.redirect(url.href, 308);
    }
    const assets = { "/setup": [html, "text/html"], "/setup/": [html, "text/html"],
        "/setup/style.css": [css, "text/css"], "/setup/app.js": [clientScript, "text/javascript"] };
    if (path === "/setup/qr.js" && typeof qrScript === "string") assets[path] = [qrScript, "text/javascript"];
    if (!Object.hasOwn(assets, path)) return null;
    const [body, type] = assets[path];
    const headers = { "Content-Type": type + "; charset=utf-8", "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "X-Frame-Options": "DENY",
        "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" };
    if (!["GET", "HEAD"].includes(request.method)) return new Response("Method not allowed", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
    return new Response(request.method === "HEAD" ? null : body, { headers });
}
