# `ol`: Overleaf projects from the command line

One file, `ol.py`, Python 3.9 or newer, standard library only. It talks to the
`projects-api` module of this repository (`overleaf-projects-api-module/`) and to
`git`, so that creating a project and having it checked out locally is one
command:

    ol new "cubaco-pdr"

This exists because the Git Bridge only reaches projects that already exist, and
creating one means the web UI, which behind OIDC cannot be scripted.

## Requirements

- Python 3.9 or newer (`py` on Windows, `python3` elsewhere).
- `git` on PATH for `new` and `clone`.
- An instance with `ENABLE_PROJECTS_API_MODULE="true"`.
- A **git access token**: Overleaf, Account Settings, Git integration. The same
  token the Git Bridge uses; the API accepts no other credential.

## Setup

    py cli/ol.py login --url https://overleaf.unibo-space.org

It asks for the token without echoing it, checks it against `/api/v1/whoami` and
stores both values:

| Platform | File |
|---|---|
| Windows | `%APPDATA%\overleaf-lab\config.json` |
| Linux, macOS | `~/.config/overleaf-lab/config.json` (mode 600) |

`OL_URL` and `OL_TOKEN` override the file when they are set, which is how to run
this in CI without leaving a config file behind.

## Commands

| Command | Does |
|---|---|
| `ol login [--url URL]` | asks for the URL and the token, verifies them, stores them |
| `ol whoami` | prints the email and the user id the token belongs to |
| `ol ls [--owned] [--json]` | id, role, name and last update of every visible project |
| `ol new NAME [...]` | creates a project, clones it, optionally seeds and opens it |
| `ol clone ID [--dir DIR]` | clones a project that already exists (the id, or its URL) |

`ol new` options: `--template basic|blank|example` (default `basic`), `--dir`
where to clone (default: here), `--folder id|name` what to call the local folder
(default `id`, this repository's convention), `--seed PATH` a directory or a
`.zip` to fill the project with, `--open` to open it in VS Code, and
`--allow-duplicate` to create a second project with a name that is already used.

Examples:

    ol ls --owned
    ol new "cubaco-pdr" --template blank --dir ~/overleaf
    ol new "tesi Rossi" --seed templates/tesi-triennale.zip --open
    ol clone https://overleaf.unibo-space.org/project/6a808805537e7ee009597323

## Authentication of the clone

The token goes in an HTTP header, **never in the remote URL**: a URL carrying a
token is written into `.git/config` and stays there.

So the first clone asks for credentials. The username is `git` and the password
is the token; the platform credential manager (Windows Credential Manager,
`osxkeychain`, whatever `credential.helper` is set to on Linux) remembers it and
does not ask again.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | done |
| 1 | API or network error, or no configuration |
| 2 | a project with that name already exists (`--allow-duplicate` to override) |
| 3 | git failed, or git is not installed |

Which makes a script honest: `ol new "$NAME" || exit $?`.

## Windows

Call it through the launcher:

    py cli\ol.py new "cubaco-pdr"

To get the short form in a PowerShell profile, define a function, on one line:

```powershell
function ol { py "$HOME\Documents\GitHub\overleaf-lab\cli\ol.py" @args }
```

`Set-Alias` will not do here: an alias resolves to a command name and cannot
carry the script argument, so `Set-Alias ol "py ...\ol.py"` fails with
`CommandNotFoundException` the first time it is used. A function passes `@args`
through and behaves like the real command. Put the line in
`$PROFILE` to keep it.

On Linux and macOS the equivalent is a symlink or an alias:

```bash
alias ol='python3 ~/overleaf-lab/cli/ol.py'
```
