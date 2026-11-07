import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve, relative, join } from "node:path";
import { randomBytes } from "node:crypto";

const root = resolve(import.meta.dirname, "..");
const privateRoot = join(root, ".spike-tools/cloudflare");
const state = JSON.parse(readFileSync(join(privateRoot, "current.json"), "utf8"));
const backup = resolve(root, state.backup_dir);
const settings = JSON.parse(readFileSync(join(backup, "settings.json"), "utf8")).result;
const sourceName = state.modules.find(name => name.endsWith(".js"));
if (!sourceName) throw new Error("The saved Worker source is missing.");
const source = readFileSync(join(backup, "modules", sourceName), "utf8");
for (const name of ["FEED_PATH", "EPISODE_DETAILS", "REPLACEMENTS"]) {
    if (!new RegExp(`(?:var|let|const) ${name} =`).test(source)) throw new Error("The legacy upload configuration needs review.");
}
const generated = join(privateRoot, "generated");
mkdirSync(generated, { recursive: true });
writeFileSync(join(generated, "legacy.mjs"), source.replace(/^\/\/# sourceMappingURL=.*$/m, "") +
    "\nexport { FEED_PATH, EPISODE_DETAILS, REPLACEMENTS };\n");
let integration = relative(generated, join(root, "cloudflare-worker/src/index.mjs")).replaceAll("\\", "/");
if (!integration.startsWith(".")) integration = "./" + integration;
writeFileSync(join(generated, "entry.mjs"), `import legacy, { FEED_PATH, EPISODE_DETAILS, REPLACEMENTS } from "./legacy.mjs";
import { integrate } from ${JSON.stringify(integration)};
export default integrate(legacy, { feedPath: FEED_PATH, episodeDetails: EPISODE_DETAILS, replacements: REPLACEMENTS,
    publicOrigin: ${JSON.stringify(state.public_origin)} });
`);
const secretPath = join(privateRoot, "secrets.json");
if (!existsSync(secretPath)) {
    writeFileSync(secretPath, JSON.stringify({ PACEJAMS_WATCH_TOKEN: randomBytes(32).toString("base64url"),
        PACEJAMS_ADMIN_TOKEN: randomBytes(32).toString("base64url"),
        POCKET_CASTS_SESSION_KEY: randomBytes(32).toString("base64") }), { mode: 0o600 });
}
const secrets = JSON.parse(readFileSync(secretPath, "utf8"));
writeFileSync(join(generated, ".dev.vars"), Object.entries(secrets).map(([name, value]) => name + "=" + JSON.stringify(value)).join("\n") + "\n");
const r2 = settings.bindings.filter(binding => binding.type === "r2_bucket").map(binding => ({
    binding: binding.name, bucket_name: binding.bucket_name,
    ...(binding.jurisdiction ? { jurisdiction: binding.jurisdiction } : {}),
}));
if (!r2.some(binding => binding.binding === "PODCASTS")) throw new Error("The existing PODCASTS binding is missing.");
const config = { name: state.worker_name, account_id: state.account_id, main: "entry.mjs",
    compatibility_date: settings.compatibility_date, compatibility_flags: settings.compatibility_flags ?? [],
    r2_buckets: r2, d1_databases: [{ binding: "PACEJAMS_DB", database_name: "pacejams-sync",
        database_id: state.database_id ?? "00000000-0000-0000-0000-000000000000" }],
    vars: { POCKET_CASTS_WRITEBACK_ENABLED: "false" } };
writeFileSync(join(generated, "wrangler.jsonc"), JSON.stringify(config, null, 2));
const schema = ["backend-core/schema.sql", "cloudflare-worker/schema.sql"].map(file => readFileSync(join(root, file), "utf8")).join("\n");
writeFileSync(join(generated, "schema.sql"), schema);
console.log("Prepared the private legacy wrapper, bindings, local schema, and credentials.");
console.log(state.database_id ? "Remote database ID is configured." : "Local database is ready. Remote database approval is pending.");
