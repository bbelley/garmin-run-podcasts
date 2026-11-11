import { HttpError } from "./http.mjs";

export async function phoneHandoff(browsers, origin) {
    const url = new URL(origin);
    const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(loopback && url.protocol === "http:")) ||
        url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
        throw new HttpError(503, "setup_origin_invalid");
    }
    const ticket = await browsers.createTicket();
    const setupUrl = url.origin + "/setup#code=" + encodeURIComponent(ticket.code);
    return { ...ticket, setup_url: setupUrl };
}
