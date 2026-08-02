# Installation

## Quick Install

```bash
git clone https://github.com/alelotti96/overleaf-lab.git
cd overleaf-lab
chmod +x *.sh scripts/*.sh
./install.sh
```

The installer asks for:
- Lab name
- Admin email & password
- SMTP credentials (for user activation emails)
- Single sign-on (OIDC) and GitHub synchronization, if you want them
- The optional features below

Then automatically installs everything.

Duration: 10-30 minutes

## Optional Features

Near the end of the questions the installer offers three features that ship with
this repo but stay switched off unless you ask for them. All three are answered
`n` by default, and any answer can be changed later by editing `config.env.local`
and running `./scripts/configure.sh`.

| Question | What you get | What it costs |
|----------|--------------|---------------|
| AI assistant and compliance review | In-editor chat, Ask-AI on a selection, inline completion, and the review that checks a document against a rubric | An OpenAI-compatible endpoint (local llama.cpp, a hosted API, or per-user keys). The installer asks for the URL, the API key and the model name |
| Public PDF publishing | A "Publish" button that serves a project's compiled PDF at a stable public URL, with an optional password | Nothing extra to install. Only publishes what an owner explicitly publishes |
| Symbols and acronyms list generator | A toolbar button that scans a project and keeps its list of symbols and its list of acronyms up to date | Nothing extra to run: no model, no API key, no network |

All three live in **one custom Docker image**. Saying yes to any of them makes
`install.sh` build that image before starting the stack: a one-time build of
about 15-30 minutes that needs at least 8 GB of RAM and network access. Saying no
to all three keeps the stock image and the installation is unchanged.

If you enable the AI assistant, two further checkers are offered for the
compliance review, both off by default:

- **LanguageTool** answers the "no spelling or grammar errors" requirement from a
  rule base instead of from the model: the same answer on every run, in Italian
  and English, with an exact file and line per mistake. It runs as one more
  container next to Overleaf (~700 MB image, ~1 GB RAM). It publishes no port and
  is reachable only from the other containers, because its API has no
  authentication. You can also give a list of domain terms it must not report.
- **Online bibliography verification** compares each `.bib` entry that has a DOI
  with the public Crossref record. It is the only part of the review that leaves
  the machine, so it runs only if you give a contact email address, which is what
  Crossref asks callers to put in the `User-Agent`. Leave it empty to keep it off.

Re-running `./install.sh` on an existing installation does not ask these
questions again: like every other setting, they are asked once and then live in
`config.env.local`.

## Access (Local, before Cloudflare setup)

- Overleaf: `http://localhost`
- Dashboard: `http://localhost:5000`

Done! See [README.md](README.md) for usage.
