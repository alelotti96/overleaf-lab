# Projects API module

Three JSON endpoints that create and list projects with the personal access
token the user already has for the Git Bridge, so a project can be created and
cloned from a script without opening a browser. Opt-in: set
`PROJECTS_API_ENABLED=true`, otherwise the module is not loaded and its routes
do not exist.

It exists because the Git Bridge only exposes projects that already exist, and
creating one means the web UI, which on an OIDC instance cannot be scripted with
a username and a password. The single-file client in `cli/` turns the endpoints
plus `git clone` into one command:

    ol new "cubaco-pdr"

The module owns no token UI, no schema and no frontend. It reuses the git-bridge
module's token store and the core project handlers, so a project created here is
the same object as one created by pressing "New project".

## The token, and why it is the git one

Authentication is `Authorization: Bearer olp_...`, the token from **Account
Settings, Git integration**, validated by the git-bridge module's own manager
(prefix, hash, scope, expiry, and that the user still exists).

Reusing it is a deliberate trust decision: **a git token already grants read and
write on every project the user can access**, so letting it also create and list
projects adds no new capability class. It is one secret to store and one to
revoke, in one place, instead of two.

This is also why the module refuses to load when `GIT_BRIDGE_ENABLED` is not
`true`: without the Git Bridge there are no tokens to accept, and it says so in
one line at startup rather than rejecting every request later.

The API never reads a user id from a request. The owner of a new project and the
subject of every listing is always the token's user, so there is no shape of
request that acts on behalf of somebody else.

## Endpoints

All on the public API router, all JSON. A missing, malformed, expired or unknown
token answers `401 {"error":"unauthorized"}`, the same answer for every failure
kind on purpose: the difference between them is what a caller probing for valid
tokens would want to read.

### `GET /api/v1/whoami`

    {"user_id":"...","email":"...","first_name":"...","last_name":"..."}

What `ol login` calls to prove a token works and to show whose it is.

### `GET /api/v1/projects[?owned=1]`

Every project the user can see, owned first:

```json
[
  { "id": "6a808805537e7ee009597323", "name": "cubaco-pdr", "role": "owner",
    "last_updated": "2026-09-02T21:10:00.000Z", "archived": false, "trashed": false,
    "url": "https://overleaf.unibo-space.org/project/6a808805537e7ee009597323",
    "git_url": "https://overleaf.unibo-space.org/git/6a808805537e7ee009597323" }
]
```

`role` is one of `owner`, `readAndWrite`, `readOnly`, `tokenReadAndWrite`,
`tokenReadOnly`, `review`. `archived` and `trashed` are **per user**: in the
database they are arrays of the ids of the users who filed the project away, and
what the answer reports is whether this user is one of them. A project reachable
in two ways is listed once, with the stronger access. `?owned=1` restricts the
answer to owned projects, and nothing else is filtered.

### `POST /api/v1/projects`

    {"name": "cubaco-pdr", "template": "basic"}

- `name`: required, trimmed and whitespace-collapsed, then validated by core's
  own `validateProjectName`. Anything core refuses is `400` with core's message.
- `template`: optional, one of `blank`, `basic`, `example`, default `basic`.
  Anything else is `400`; there is no silent fallback, so a typo in a script
  cannot quietly create the wrong kind of project.
- Duplicate guard: if the user already **owns** a project with that name and has
  not trashed it, the answer is
  `409 {"error":"a project with this name already exists","id":"<existing id>"}`.
  Upstream enforces no uniqueness at all, so this is a module-level choice: it
  keeps a script retried after a timeout from leaving "notes", "notes", "notes"
  behind. Send `"allow_duplicate": true` to create it anyway.
- Success is `201 {"id","name","url","git_url"}`.

Rate limits, per IP: 30 per minute on the POST, 120 per minute on the two GETs.
The limiter runs before the token check, so a flood of invalid tokens is bounded
too.

## CLI quick start

    py cli/ol.py login --url https://overleaf.unibo-space.org
    py cli/ol.py new "cubaco-pdr"

`login` asks for the token without echoing it and stores it in the user's config
directory. `new` creates the project, clones it over the Git Bridge and prints
the local path. See `cli/README.md`.

## Tests

No dependencies, no framework, plain node against the module's own sources:

    node overleaf-projects-api-module/test/run.mjs

or the single suite while working on it:

    node overleaf-projects-api-module/test/helpers.test.mjs

Everything worth pinning lives in `app/src/ProjectsApiHelpers.mjs`, which imports
nothing from Overleaf, so the suite imports the shipped file instead of slicing
it: no copy of the logic and no text anchor to drift. The router, the controller
and the auth middleware import core files that exist only inside the container,
so all the runner can do for them is `node --check`. What proves their imports
resolve is the smoke test after the image build:

    docker exec sharelatex node -e "import('/overleaf/services/web/modules/projects-api/index.mjs').then(m => console.log(Object.keys(m.default)))"

An empty answer there means the module refused to load: check
`PROJECTS_API_ENABLED` and `GIT_BRIDGE_ENABLED` in the container environment
(`docker exec sharelatex printenv | grep -E 'PROJECTS_API|GIT_BRIDGE'`) and read
the startup line the module logs.
