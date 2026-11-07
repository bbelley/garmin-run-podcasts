import { authorized, HttpError } from "./http.mjs";

const COOKIE = "__Host-pacejams_setup";
const TOKEN = /^[A-Za-z0-9_-]{43}\.[a-f0-9]{64}$/;

function randomToken(bytes = 32) {
    return btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(bytes))))
        .replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export function sameOrigin(request) {
    secureTransport(request);
    if (request.headers.get("Origin") !== new URL(request.url).origin) throw new HttpError(403, "same_origin_required");
}

export function secureTransport(request) {
    const url = new URL(request.url);
    if (url.protocol !== "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
        throw new HttpError(403, "https_required");
    }
}

function cookieToken(request) {
    const values = (request.headers.get("Cookie") ?? "").split(";").map(part => part.trim())
        .filter(part => part.startsWith(COOKIE + "=")).map(part => part.slice(COOKIE.length + 1));
    return values.length === 1 && TOKEN.test(values[0]) ? values[0] : null;
}

export function sessionCookie(token, maxAge = 3600) {
    return `${COOKIE}=${token}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${maxAge}`;
}

export class BrowserSessions {
    constructor(db, adminToken, clock = () => Math.floor(Date.now() / 1000)) {
        this.db = db;
        this.adminToken = adminToken;
        this.clock = clock;
    }

    async hash(kind, token) {
        if (typeof this.adminToken !== "string" || this.adminToken.length < 32) throw new HttpError(503, "credential_not_configured");
        const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(this.adminToken),
            { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const digest = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(kind + ":" + token)));
        return Array.from(digest, value => value.toString(16).padStart(2, "0")).join("");
    }

    async createTicket() {
        const nonce = randomToken();
        const code = nonce + "." + await this.hash("ticket-proof", nonce);
        const now = this.clock();
        await this.db.batch([
            this.db.prepare("DELETE FROM setup_tickets WHERE expires_at <= ?").bind(now),
            this.db.prepare("DELETE FROM browser_sessions WHERE expires_at <= ?").bind(now),
            this.db.prepare("INSERT INTO setup_tickets(token_hash,expires_at) VALUES(?,?)")
                .bind(await this.hash("ticket", code), now + 300),
        ]);
        return { code, expires_in: 300 };
    }

    async redeem(request, code) {
        sameOrigin(request);
        if (typeof code !== "string" || !TOKEN.test(code)) throw new HttpError(401, "setup_link_invalid");
        if (!(await this.validProof("ticket-proof", code))) throw new HttpError(401, "setup_link_invalid");
        const ticket = await this.db.prepare("DELETE FROM setup_tickets WHERE token_hash=? AND expires_at>? RETURNING token_hash")
            .bind(await this.hash("ticket", code), this.clock()).first();
        if (!ticket) throw new HttpError(401, "setup_link_invalid");
        const nonce = randomToken();
        const token = nonce + "." + await this.hash("session-proof", nonce);
        const csrf = randomToken(24);
        await this.db.prepare("INSERT INTO browser_sessions(token_hash,csrf_token,expires_at) VALUES(?,?,?)")
            .bind(await this.hash("session", token), csrf, this.clock() + 3600).run();
        return { cookie: sessionCookie(token), csrf_token: csrf };
    }

    async authorize(request) {
        secureTransport(request);
        if (request.headers.has("Authorization")) {
            await authorized(request, this.adminToken);
            return { browser: false, csrf_token: null };
        }
        const token = cookieToken(request);
        if (!token) throw new HttpError(401, "unauthorized");
        if (!(await this.validProof("session-proof", token))) throw new HttpError(401, "unauthorized");
        const hash = await this.hash("session", token);
        const session = await this.db.prepare("SELECT csrf_token FROM browser_sessions WHERE token_hash=? AND expires_at>?")
            .bind(hash, this.clock()).first();
        if (!session) throw new HttpError(401, "unauthorized");
        if (!["GET", "HEAD"].includes(request.method)) {
            sameOrigin(request);
            if (request.headers.get("X-PaceJams-CSRF") !== session.csrf_token) throw new HttpError(403, "csrf_required");
        }
        return { browser: true, csrf_token: session.csrf_token, hash };
    }

    async validProof(kind, token) {
        const [nonce, supplied] = token.split(".");
        const expected = await this.hash(kind, nonce);
        let difference = 0;
        for (let index = 0; index < expected.length; index += 1) difference |= expected.charCodeAt(index) ^ supplied.charCodeAt(index);
        return difference === 0;
    }

    async logout(auth) {
        if (auth.browser) await this.db.prepare("DELETE FROM browser_sessions WHERE token_hash=?").bind(auth.hash).run();
        return sessionCookie("", 0);
    }
}
