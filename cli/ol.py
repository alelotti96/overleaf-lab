#!/usr/bin/env python3
"""ol: create, list and clone Overleaf projects without opening a browser.

A single-file client for the overleaf-lab "projects-api" module. It needs
Python 3.9 or newer and nothing else: only the standard library, so it can be
copied to a laptop, a lab PC or a CI runner and just run.

Authentication is the personal access token the user already created for the
Git Bridge (Account Settings, Git integration). The token is sent in an
Authorization header and NEVER put in a URL: a token in a remote URL ends up
written into .git/config, where it outlives every intention of keeping it
secret. The clones this tool makes leave authentication to git, which asks once
and lets the platform credential manager remember the answer.

Commands:
    ol login [--url URL]                store the instance URL and the token
    ol whoami                           print the email and user id of the token
    ol ls [--owned] [--json]            list the projects the token can see
    ol new NAME [options]               create a project, clone it, optionally seed it
    ol clone ID [--dir DIR]             clone a project that already exists

Exit codes: 0 ok, 1 API or network error, 2 duplicate name, 3 git failure.
"""

import argparse
import getpass
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path
from urllib import error, parse, request

APP_NAME = "overleaf-lab"
USER_AGENT = "ol/1.0 (overleaf-lab projects API client)"
TIMEOUT_SECONDS = 30
PROJECT_ID_RE = re.compile(r"^[0-9a-f]{24}$")
TEMPLATES = ("basic", "blank", "example")

EXIT_OK = 0
EXIT_API = 1
EXIT_DUPLICATE = 2
EXIT_GIT = 3


class Fail(Exception):
    """An error already worded for the user, carrying the exit code to use."""

    def __init__(self, message, code=EXIT_API):
        super().__init__(message)
        self.code = code


# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------


def config_path():
    """Where the URL and the token live, per platform convention.

    Windows keeps per-user application data in APPDATA; everywhere else the
    XDG convention is ~/.config. Nothing is ever written next to the script:
    the repository must stay free of secrets.
    """
    if os.name == "nt":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        return Path(base) / APP_NAME / "config.json"
    base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(base) / APP_NAME / "config.json"


def load_config():
    path = config_path()
    try:
        with path.open("r", encoding="utf-8") as handle:
            data = json.load(handle)
    except FileNotFoundError:
        return {}
    except (OSError, ValueError) as exc:
        raise Fail("cannot read %s: %s" % (path, exc))
    return data if isinstance(data, dict) else {}


def save_config(config):
    path = config_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        # Written through a fresh file with restrictive permissions rather than
        # chmod'ed afterwards, so the token is never readable by anybody else,
        # not even for the moment between the two calls. Windows ignores the
        # mode and relies on the ACL of the user's own AppData instead.
        fd = os.open(str(path), os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            json.dump(config, handle, indent=2)
            handle.write("\n")
        if os.name != "nt":
            os.chmod(str(path), 0o600)
    except OSError as exc:
        raise Fail("cannot write %s: %s" % (path, exc))
    return path


def normalise_url(url):
    url = (url or "").strip().rstrip("/")
    if url and "://" not in url:
        url = "https://" + url
    return url


def resolve_url_and_token(config, url_override=None):
    """Environment first, then the stored configuration.

    OL_URL and OL_TOKEN exist so that CI can run this without a config file and
    without leaving one behind.
    """
    url = normalise_url(url_override or os.environ.get("OL_URL") or config.get("url") or "")
    token = os.environ.get("OL_TOKEN") or config.get("token") or ""
    return url, token


def require_session(url_override=None):
    config = load_config()
    url, token = resolve_url_and_token(config, url_override)
    if not url or not token:
        raise Fail("not logged in: run `ol login` first (or set OL_URL and OL_TOKEN)")
    return url, token


# ---------------------------------------------------------------------------
# The API
# ---------------------------------------------------------------------------


def call_api(method, url, path, token, payload=None, query=None):
    """One request, one answer, or a Fail worded for the user.

    Returns (status, parsed body). HTTP errors are not raised: the callers need
    the status to tell a duplicate from a refusal, so every answer with a body
    comes back the same way.
    """
    target = url + path
    if query:
        target += "?" + parse.urlencode(query)
    data = None
    headers = {
        "Authorization": "Bearer " + token,
        "Accept": "application/json",
        "User-Agent": USER_AGENT,
    }
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    req = request.Request(target, data=data, headers=headers, method=method)
    try:
        with request.urlopen(req, timeout=TIMEOUT_SECONDS) as response:
            return response.status, parse_body(response.read())
    except error.HTTPError as exc:
        return exc.code, parse_body(exc.read())
    except error.URLError as exc:
        raise Fail("cannot reach %s: %s" % (target, exc.reason))
    except OSError as exc:
        raise Fail("cannot reach %s: %s" % (target, exc))


def parse_body(raw):
    if not raw:
        return None
    try:
        return json.loads(raw.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return {"error": raw.decode("utf-8", "replace")[:200]}


def api_error(status, body, target):
    """The message for an answer that was not the expected one."""
    if status == 401:
        return "unauthorized: the token was refused. Create a new one in Account Settings, Git integration, then run `ol login`"
    if status == 404:
        return "%s: not found (is the projects API module enabled on this instance?)" % target
    if status == 429:
        return "rate limited: too many requests, wait a minute"
    message = ""
    if isinstance(body, dict):
        message = body.get("error") or ""
    return "%s: HTTP %d%s" % (target, status, (" - " + message) if message else "")


def get_projects(url, token, owned=False):
    status, body = call_api("GET", url, "/api/v1/projects", token, query={"owned": "1"} if owned else None)
    if status != 200 or not isinstance(body, list):
        raise Fail(api_error(status, body, "GET /api/v1/projects"))
    return body


def get_whoami(url, token):
    status, body = call_api("GET", url, "/api/v1/whoami", token)
    if status != 200 or not isinstance(body, dict):
        raise Fail(api_error(status, body, "GET /api/v1/whoami"))
    return body


# ---------------------------------------------------------------------------
# git
# ---------------------------------------------------------------------------


def run_git(arguments, cwd=None, capture=False):
    """git, inheriting the terminal unless the output is wanted.

    Inheriting matters for `clone`: the credential prompt has to reach the user,
    and a captured prompt is a hang nobody can explain.
    """
    if shutil.which("git") is None:
        raise Fail("git is not on PATH: install git, or clone by hand from the URL above", EXIT_GIT)
    try:
        if capture:
            done = subprocess.run(["git"] + arguments, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            return done.returncode, done.stdout.decode("utf-8", "replace")
        done = subprocess.run(["git"] + arguments, cwd=cwd)
        return done.returncode, ""
    except OSError as exc:
        raise Fail("could not run git: %s" % exc, EXIT_GIT)


def git_or_fail(arguments, cwd=None, what=""):
    code, _ = run_git(arguments, cwd=cwd)
    if code != 0:
        raise Fail("git %s failed (exit %d)" % (what or arguments[0], code), EXIT_GIT)


def clone_project(git_url, destination):
    if destination.exists() and any(destination.iterdir()):
        raise Fail("%s already exists and is not empty" % destination, EXIT_GIT)
    destination.parent.mkdir(parents=True, exist_ok=True)
    print(
        "Cloning. If git asks for credentials, the username is `git` and the password is your\n"
        "access token; the platform credential manager remembers it after the first time."
    )
    git_or_fail(["clone", git_url, str(destination)], what="clone")
    return destination


# ---------------------------------------------------------------------------
# Seeding
# ---------------------------------------------------------------------------


def seed_clone(destination, seed):
    """Copy a template into the clone, then commit and push it.

    The seed is a directory or a .zip (one of the files in templates/, for
    instance). Existing files are overwritten, main.tex included: the seed is
    what the project is meant to contain, and a blank project's placeholder
    main.tex has nothing in it worth keeping.
    """
    source = Path(seed).expanduser()
    if not source.exists():
        raise Fail("seed not found: %s" % source)
    temporary = None
    try:
        if source.is_file():
            if source.suffix.lower() != ".zip":
                raise Fail("a seed must be a directory or a .zip file: %s" % source)
            temporary = tempfile.mkdtemp(prefix="ol-seed-")
            try:
                with zipfile.ZipFile(str(source)) as archive:
                    archive.extractall(temporary)
            except (zipfile.BadZipFile, OSError) as exc:
                raise Fail("cannot read %s: %s" % (source, exc))
            root = Path(temporary)
            # A zip made by "compress this folder" holds one directory and
            # nothing else; the project wants what is inside it, not the folder.
            entries = list(root.iterdir())
            if len(entries) == 1 and entries[0].is_dir():
                root = entries[0]
        else:
            root = source

        copied = 0
        for entry in sorted(root.iterdir()):
            if entry.name == ".git":
                continue
            target = destination / entry.name
            if entry.is_dir():
                shutil.copytree(str(entry), str(target), dirs_exist_ok=True)
            else:
                shutil.copy2(str(entry), str(target))
            copied += 1
        if copied == 0:
            print("Seed %s is empty, nothing copied." % source.name)
            return
    finally:
        if temporary:
            shutil.rmtree(temporary, ignore_errors=True)

    git_or_fail(["add", "-A"], cwd=str(destination), what="add")
    code, pending = run_git(["status", "--porcelain"], cwd=str(destination), capture=True)
    if code != 0:
        raise Fail("git status failed (exit %d)" % code, EXIT_GIT)
    if not pending.strip():
        print("Seed %s matches the project already, nothing to push." % source.name)
        return
    git_or_fail(["commit", "-m", "Seed from %s" % source.name], cwd=str(destination), what="commit")
    git_or_fail(["push"], cwd=str(destination), what="push")
    print("Seeded from %s and pushed." % source.name)


def open_in_editor(destination):
    editor = shutil.which("code")
    if not editor:
        print("VS Code (`code`) is not on PATH. The project is at: %s" % destination)
        return
    try:
        subprocess.run([editor, str(destination)])
    except OSError as exc:
        print("Could not start `code` (%s). The project is at: %s" % (exc, destination))


def safe_folder_name(name):
    """A project name turned into something a filesystem accepts everywhere."""
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "-", name).strip("-.")
    return cleaned or "project"


# ---------------------------------------------------------------------------
# Commands
# ---------------------------------------------------------------------------


def cmd_login(args):
    config = load_config()
    url, token = resolve_url_and_token(config, args.url)
    if not url:
        url = normalise_url(input("Overleaf URL (e.g. https://overleaf.unibo-space.org): "))
    if not url:
        raise Fail("no URL given")
    if not token:
        print("Create the token in Overleaf: Account Settings, Git integration.")
        token = getpass.getpass("Git access token (not shown): ").strip()
    if not token:
        raise Fail("no token given")

    identity = get_whoami(url, token)
    path = save_config({"url": url, "token": token})
    print("Logged in as %s on %s" % (identity.get("email", "?"), url))
    print("Configuration written to %s" % path)
    return EXIT_OK


def cmd_whoami(args):
    url, token = require_session()
    identity = get_whoami(url, token)
    print(identity.get("email", ""))
    print(identity.get("user_id", ""))
    return EXIT_OK


def cmd_ls(args):
    url, token = require_session()
    projects = get_projects(url, token, owned=args.owned)
    if args.json:
        print(json.dumps(projects, indent=2))
        return EXIT_OK
    if not projects:
        print("No projects.")
        return EXIT_OK
    rows = []
    for project in projects:
        flags = []
        if project.get("archived"):
            flags.append("archived")
        if project.get("trashed"):
            flags.append("trashed")
        name = str(project.get("name", ""))
        if flags:
            name = "%s (%s)" % (name, ", ".join(flags))
        rows.append(
            (
                str(project.get("id", "")),
                str(project.get("role", "")),
                name,
                short_date(project.get("last_updated")),
            )
        )
    widths = [max(len(row[column]) for row in rows) for column in range(3)]
    for row in rows:
        print("%-*s  %-*s  %-*s  %s" % (widths[0], row[0], widths[1], row[1], widths[2], row[2], row[3]))
    return EXIT_OK


def short_date(value):
    if not value:
        return ""
    text = str(value).replace("Z", "")
    return text.replace("T", " ")[:16]


def cmd_new(args):
    url, token = require_session()
    payload = {"name": args.name, "template": args.template}
    if args.allow_duplicate:
        payload["allow_duplicate"] = True
    status, body = call_api("POST", url, "/api/v1/projects", token, payload=payload)

    if status == 409 and isinstance(body, dict):
        print("A project called %r already exists: %s" % (args.name, body.get("id", "?")), file=sys.stderr)
        print("%s/project/%s" % (url, body.get("id", "")), file=sys.stderr)
        print("Use --allow-duplicate to create another one anyway.", file=sys.stderr)
        return EXIT_DUPLICATE
    if status == 400 and isinstance(body, dict):
        raise Fail(body.get("error") or "the server refused the name")
    if status != 201 or not isinstance(body, dict):
        raise Fail(api_error(status, body, "POST /api/v1/projects"))

    project_id = body.get("id", "")
    git_url = body.get("git_url") or ("%s/git/%s" % (url, project_id))
    folder = project_id if args.folder == "id" else safe_folder_name(body.get("name") or args.name)
    destination = Path(args.dir).expanduser() / folder
    project_url = body.get("url") or ("%s/project/%s" % (url, project_id))
    print("Created %s" % project_url)

    clone_project(git_url, destination)
    if args.seed:
        seed_clone(destination, args.seed)
    if args.open:
        open_in_editor(destination)

    print("")
    print("id    %s" % project_id)
    print("url   %s" % project_url)
    print("path  %s" % destination.resolve())
    return EXIT_OK


def cmd_clone(args):
    url, token = require_session()
    project_id = args.id.strip()
    # Accept the full project URL as well: it is what a browser hands over, and
    # asking somebody to cut the last segment out of it by hand is asking for a
    # typo.
    if "/" in project_id:
        project_id = project_id.rstrip("/").rsplit("/", 1)[-1]
    if not PROJECT_ID_RE.match(project_id):
        raise Fail("%r is not a project id (24 hexadecimal characters)" % args.id)
    destination = Path(args.dir).expanduser() / project_id
    clone_project("%s/git/%s" % (url, project_id), destination)
    print("")
    print("path  %s" % destination.resolve())
    return EXIT_OK


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------


def build_parser():
    parser = argparse.ArgumentParser(
        prog="ol",
        description="Create, list and clone Overleaf projects from the command line.",
        epilog="Configuration: %s (override with OL_URL and OL_TOKEN)." % config_path(),
    )
    subparsers = parser.add_subparsers(dest="command")

    login = subparsers.add_parser("login", help="store the instance URL and the git access token")
    login.add_argument("--url", help="instance URL, e.g. https://overleaf.unibo-space.org")
    login.set_defaults(handler=cmd_login)

    whoami = subparsers.add_parser("whoami", help="print the email and user id the token belongs to")
    whoami.set_defaults(handler=cmd_whoami)

    listing = subparsers.add_parser("ls", help="list the projects the token can see")
    listing.add_argument("--owned", action="store_true", help="only the projects owned by this user")
    listing.add_argument("--json", action="store_true", help="print the raw JSON answer")
    listing.set_defaults(handler=cmd_ls)

    new = subparsers.add_parser("new", help="create a project and clone it")
    new.add_argument("name", help="project name")
    new.add_argument("--template", choices=TEMPLATES, default="basic", help="starting content (default: basic)")
    new.add_argument("--dir", default=".", help="where to clone (default: the current directory)")
    new.add_argument(
        "--folder",
        choices=("id", "name"),
        default="id",
        help="name the local folder after the project id (default) or after the project name",
    )
    new.add_argument("--seed", help="a directory or .zip whose content is copied in, committed and pushed")
    new.add_argument("--open", action="store_true", help="open the clone in VS Code if `code` is on PATH")
    new.add_argument("--allow-duplicate", action="store_true", help="create it even if a project of that name exists")
    new.set_defaults(handler=cmd_new)

    clone = subparsers.add_parser("clone", help="clone an existing project through the Git Bridge")
    clone.add_argument("id", help="project id, or the project URL")
    clone.add_argument("--dir", default=".", help="where to clone (default: the current directory)")
    clone.set_defaults(handler=cmd_clone)

    return parser


def main(argv=None):
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "handler", None):
        parser.print_help()
        return EXIT_OK
    try:
        return args.handler(args)
    except Fail as exc:
        print("ol: %s" % exc, file=sys.stderr)
        return exc.code
    except KeyboardInterrupt:
        print("", file=sys.stderr)
        return EXIT_API


if __name__ == "__main__":
    sys.exit(main())
