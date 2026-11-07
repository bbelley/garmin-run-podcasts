"""Review staged files or outgoing commits before publishing this public repository."""

import argparse
import json
import os
from pathlib import Path
import re
import subprocess
import sys
from urllib.parse import unquote, urlsplit


ZERO = "0" * 40
UUID = re.compile(r"\b[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\b", re.I)
EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b", re.I)
URL = re.compile(r"https?://[^\s<>\]\)\"']+", re.I)
PRIVATE_FILES = re.compile(
    r"(^|/)(\.spike-tools|bin|__pycache__|\.wrangler|node_modules)(/|$)|"
    r"(^|/)(\.env(?:\.[^/]+)?|\.dev\.vars(?:\.[^/]+)?|LocalConfig\.mc)$|"
    r"\.(der|pem|key|prg(?:\.debug\.xml)?|iq|mp3|wav|m4a|sqlite|sqlite3|db|bundle)$", re.I
)
PATTERNS = {
    "private key": re.compile(r"-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----"),
    "access token": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{25,}|github_pat_[A-Za-z0-9_]{25,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{12,})\b"),
    "personal Windows path": re.compile(r"\b[A-Z]:[\\/]{1,2}Users[\\/]{1,2}", re.I),
    "literal credential": re.compile(r'''\b(?:password|access_token|refresh_token|api_key|client_secret|bearer_token)\s*[:=]\s*["'][^"'\r\n]{8,}["']''', re.I),
}
DOC_HOSTS = {"developer.garmin.com", "www8.garmin.com", "forums.garmin.com"}


def git(*args):
    return subprocess.check_output(("git", *args), stderr=subprocess.DEVNULL)


def example_email(domain):
    return domain.lower() in {"example.com", "example.org", "example.net", "users.noreply.github.com"} or domain.lower().endswith(".example")


def scan_text(text, private_values=()):
    reasons = {reason for reason, pattern in PATTERNS.items() if pattern.search(text)}
    if any(not example_email(match[1]) for match in EMAIL.finditer(text)):
        reasons.add("personal email")
    for match in URL.finditer(text):
        try:
            value = urlsplit(match[0])
        except ValueError:
            reasons.add("malformed URL")
            continue
        if value.username or value.password or re.search(r"(?:^|&)(?:token|key|sig|signature|x-amz-signature|password)=", value.query, re.I):
            reasons.add("credential-bearing URL")
    # Device documentation contains public GUIDs. Near-zero fixture IDs are synthetic.
    without_doc_urls = URL.sub(lambda match: "" if urlsplit(match[0]).hostname in DOC_HOSTS else match[0], text)
    if any(not match[0].startswith("00000000-0000-0000-0000-") for match in UUID.finditer(without_doc_urls)):
        reasons.add("account or episode UUID")
    if any(value and value.lower() in text.lower() for value in private_values):
        reasons.add("known local private value")
    return sorted(reasons)


def private_values(root):
    values = []
    profile = os.environ.get("USERPROFILE")
    if profile:
        values.append(profile)
    config = root / "garmin-spike/source/LocalConfig.mc"
    if config.exists():
        match = re.search(r'const MP3_URL = "([^"\r\n]+)";', config.read_text(encoding="utf-8-sig"))
        if match:
            url = urlsplit(match[1])
            if url.hostname != "soniqtools.com":
                values.extend([match[1], url.hostname])
                values.extend(unquote(part) for part in url.path.split("/") if len(part) >= 16)
    cloudflare = root / ".spike-tools/cloudflare"
    secrets = cloudflare / "secrets.json"
    if secrets.exists():
        data = json.loads(secrets.read_text(encoding="utf-8-sig"))
        values.extend(value for value in data.values() if isinstance(value, str))
    state = cloudflare / "current.json"
    if state.exists():
        data = json.loads(state.read_text(encoding="utf-8-sig"))
        values.extend(data.get(name) for name in ("account_id", "database_id", "worker_name", "public_origin"))
    return [value for value in values if value and len(value) >= 8]


def audit_tree(ref, local_values):
    names = git("ls-files", "-z") if ref == "" else git("ls-tree", "-r", "--name-only", "-z", ref)
    failures = []
    count = 0
    for raw_name in names.split(b"\0"):
        if not raw_name:
            continue
        name = raw_name.decode("utf-8")
        count += 1
        is_example = name.endswith((".env.example", ".dev.vars.example"))
        if PRIVATE_FILES.search(name) and not is_example:
            failures.append((name, "private or generated artifact"))
            continue
        blob = git("show", ref + ":" + name)
        try:
            if b"\0" in blob:
                raise UnicodeError()
            text = blob.decode("utf-8")
        except UnicodeError:
            failures.append((name, "binary file requires review"))
            continue
        failures.extend((name, reason) for reason in scan_text(text, local_values))
    for name, reason in failures:
        print(f"{ref[:8] or 'index'} {name}: {reason}")
    if not failures:
        print(f"Privacy check passed for {ref[:8] or 'index'} ({count} files).")
    return not failures


def private_metadata(identities):
    return any(not identity.endswith("@users.noreply.github.com") for identity in identities)


def audit_commits(commits, local_values):
    ok = True
    for commit in dict.fromkeys(commits):
        emails = git("show", "-s", "--format=%ae%n%ce", commit).decode().splitlines()
        if private_metadata(emails):
            print(f"{commit[:8]}: author or committer email requires review.")
            ok = False
        ok = audit_tree(commit, local_values) and ok
    return ok


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--staged", action="store_true")
    mode.add_argument("--outgoing", metavar="BASE", help="inspect every commit in BASE..HEAD")
    mode.add_argument("--pre-push", metavar="REMOTE", help="read Git pre-push refs from stdin")
    args = parser.parse_args()
    root = Path(git("rev-parse", "--show-toplevel").decode().strip())
    os.chdir(root)
    local_values = private_values(root)
    if args.staged:
        for key in ("GIT_AUTHOR_IDENT", "GIT_COMMITTER_IDENT"):
            identity = git("var", key).decode()
            email = re.search(r"<([^>]+)>", identity)
            if not email or private_metadata([email[1]]):
                print("Git author or committer email requires review.")
                return 1
        return 0 if audit_tree("", local_values) else 1
    commits = []
    if args.outgoing:
        commits = git("rev-list", args.outgoing + "..HEAD").decode().splitlines()
    else:
        for line in sys.stdin:
            _, local_sha, _, remote_sha = line.split()
            if local_sha == ZERO:
                continue
            if remote_sha == ZERO:
                commits.extend(git("rev-list", local_sha, "--not", "--remotes=" + args.pre_push).decode().splitlines())
            else:
                commits.extend(git("rev-list", remote_sha + ".." + local_sha).decode().splitlines())
    return 0 if audit_commits(commits, local_values) else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (subprocess.CalledProcessError, ValueError, OSError):
        print("Privacy check could not inspect Git state. Review the repository before publishing.", file=sys.stderr)
        raise SystemExit(1)
