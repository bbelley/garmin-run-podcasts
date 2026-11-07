export class HttpError extends Error {
    constructor(status, code) {
        super(code);
        this.status = status;
    }
}

export async function readJson(message, limit) {
    if (!message.body) throw new HttpError(400, "invalid_json");
    const reader = message.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > limit) {
                await reader.cancel();
                throw new HttpError(413, "body_too_large");
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    try {
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        throw new HttpError(400, "invalid_json");
    }
}

export async function authorized(request, expected) {
    if (typeof expected !== "string" || expected.length < 32) throw new HttpError(503, "credential_not_configured");
    const supplied = request.headers.get("Authorization") ?? "";
    const hash = value => crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
    const a = new Uint8Array(await hash(supplied));
    const b = new Uint8Array(await hash(`Bearer ${expected}`));
    let difference = 0;
    for (let index = 0; index < a.length; index += 1) difference |= a[index] ^ b[index];
    if (difference !== 0) throw new HttpError(401, "unauthorized");
}

export function json(data, status = 200) {
    return Response.json(data, { status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" } });
}
