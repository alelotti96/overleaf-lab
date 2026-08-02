# overleaf-lists-module

Two buttons that build and keep up to date the lists a thesis carries at the front:
the **list of acronyms** and the **list of symbols**.

It is a parser and nothing else. No request leaves the container, no model is asked
anything, and the same project produces the same answer every time. That is why it
is a module of its own and not part of `overleaf-llm-image`: the LLM image is an
optional layer that needs a model server, and there is no reason a deployment that
never builds it should lose a feature that is pure text processing.

```
overleaf-lists-module/
  index.mjs                                 module entry point (LISTS_ENABLED)
  app/src/ListsController.mjs               the whole engine, pure core + handlers
  app/src/ListsRouter.mjs                   three project-scoped routes
  frontend/js/components/lists-button.tsx   the "Lists" toolbar button and its modal
  data/acronyms-master.txt                  DEFAULT definitions, meant to be edited
  data/symbols-master.txt                   DEFAULT descriptions, meant to be edited
  test/run.mjs                              the module's own runner
  test/lists.test.mjs                       the suite
```

## What it does

### It never destroys

* A row already in the list is left **exactly** as it was, byte for byte, whatever
  shape it has and whoever wrote it. Hand-written definitions included.
* A row whose entry no longer appears in the document is **not removed**. It is
  reported ("kept, although the scan could not find them in the text") and left
  alone: "I cannot find it" is not the same as "it is not there", and the author is
  the one who knows which.
* Running the button twice in a row produces **zero** changes the second time. The
  one exception is a press that hit the per-press ceiling of 300 new rows, and the
  panel says so and asks for another press.
* A document it could not read **in full** is never written back. The module reads
  at most 600 000 characters of a file, and it rewrites the whole file it merges
  into, so writing back a document it had only partly read would delete everything
  past that point on a press whose entire promise is that it only adds rows. Both
  the status route and the button say so, and the merge refuses with
  `document_too_large`. Splitting the file into chapters with `\input` is the fix.
* A list this parser cannot **read** is not treated as an empty one. An item list
  written `\item ADCS, the attitude system` carries a key and a definition that
  this code can see neither of, so it is refused rather than filled in underneath:
  inventing rows there added a second entry for one that was plainly already
  listed. One entry written by hand in the shape you want unblocks every later
  press.

### It is gated per file, never per template

Nothing in the code knows the name of any university template. A list exists when a
FILE says it does, either by its name (`simboli.tex`, `symbols.tex`,
`elenco-acronimi.tex`, ...) or by a heading inside it (`\chapter*{Elenco dei
simboli}`, `\section*{List of Acronyms}`, `Nomenclature`, `Abbreviazioni`,
`Sigle`, ...). An internship report that carries no symbols file simply has no
symbols list to update, and the panel says so and offers to create one.

Two things that look like a list are not one:

* **What the document quotes rather than writes.** A heading inside a comment, a
  `verbatim` or an `lstlisting` does not count. A thesis with an appendix showing
  its own LaTeX contains the characters `\chapter*{List of Acronyms}` without
  containing a list of acronyms, and the module used to splice its generated rows
  into the middle of that code listing. The same rule now decides which `\input`
  commands are real includes, which acronyms the document declares, and where the
  maths is.
* **What is not the author's prose.** `.bib`, `.bbl`, `.bst`, `.cls`, `.sty` and
  the build artefacts are not read at all. A bibliography put `IEEE` and `AIAA` in
  the list from its `publisher` field, and forty English titles were enough
  function words to make an Italian thesis detect as English; a university `.sty`
  that builds its front matter inside `\newcommand{\elencosimboli}{...}` was taken
  for the author's own list, and the module wrote rows into the template.

**A list file the main document never includes is still updated.** A use inside a
parked draft is still a use, and refusing would leave the author pressing a button
that does nothing. When a project has both, the included file wins; the panel
always names the path it wrote to, which is how the author sees which one it was.

### The language is the language of the LIST

Read off the heading first, then the file name. A thesis written in Italian with an
English "List of Symbols" heading gets English descriptions in that table, because
that is the language of the page the reader is on. The language decides which column
of the master file is used and, on creation, the heading and the file name.

For a list that does not exist yet there is no heading to read, so the DOCUMENT
language is detected instead: `babel` or `polyglossia` in the preamble first (with
babel's rule that the last option is the main language), then the `\documentclass`
options, then a count of function words. That answer is only the preselected option
in the dialog; the author picks.

### The formats it reads and imitates

New rows are written in the shape the file already uses. The template is the last
complete row of the list, and the module copies its indentation, its cell
decoration, its spacing and its row terminator:

| shape | example |
| --- | --- |
| two column tabular | `ADCS & Attitude Determination and Control System \\` |
| three column longtable with a gutter | `\textbf{ADCS}&& Attitude Determination and Control System\\` |
| four column longtable, symbol in maths | `& $ \mu $ &  & standard gravitational parameter \\[.1mm]` |
| description list | `\item[ADCS] Attitude Determination and Control System` |

If the list exists but is **empty** there is no row to imitate, and the layout comes
from the column count: 2 columns get `KEY & VALUE`, 3 columns get the gutter shape,
4 columns get the maths shape. Any other column count refuses to invent a layout and
asks the author to write one row by hand, which every later press then copies.

If the existing rows are alphabetical (four fifths of consecutive pairs in order,
which is what a hand-typed list of eighty entries actually looks like) new rows are
inserted at their letter. If they are not (a symbols list grouped by theme, with
comments between the groups) new rows go at the end, where they cannot break the
grouping.

### Creating a list that does not exist

The dialog asks for the language, shows what would be created, and then:

1. Writes a new file. Its name comes from the code (`acronimi.tex` / `acronyms.tex`
   / `simboli.tex` / `symbols.tex`) and from the chosen language, never from
   anything the request carries. It goes beside the other front matter when the
   project has some, next to the main file otherwise.
2. Fills it in with the same scan the merge uses: a starred heading, an
   `\addcontentsline` so the list still appears in the table of contents, and a
   longtable in the reference shape.
3. Hooks it into the document **only where there is exactly one right answer**:

   | case | what happens |
   | --- | --- |
   | the other list is already `\input` somewhere | the new line goes right after it |
   | the document has `\mainmatter`, or a recognisable first chapter | the new line goes immediately before it |
   | anything else | **the main file is not touched**; the exact line to paste is shown in the panel |

   The panel always says which of the three happened. When the `\input` is inserted
   and the preamble does not already load `longtable`, `\usepackage{longtable}` is
   added before `\begin{document}` too, because the generated table needs it; when
   the main file is left alone, that line is shown to paste as well.

The name the new file would take is checked against **every path the project has**
and not against the documents the scan read: the two differ, because a file with
nothing in it is dropped before the scan and so is everything past the project
caps, and a create would have upserted straight over a file it never saw. A file
that is genuinely **empty** is deliberately not an obstacle: an author who made an
empty `simboli.tex` and pressed the button wants it filled in, and refusing there
would mean a dialog offering to create a list and a server answering that the name
is taken.

If a list of that kind turns up between the moment the dialog opened and the moment
the button was pressed, the request fails with a clear message instead of
overwriting anything.

Every write goes through Overleaf's document APIs, so every change is in the project
history and can be undone from the editor.

### What has to be checked on a live instance

The module reads the project from `getAllDocs`, which is the **docstore**, Mongo's
copy. A document open in somebody's editor lives in the document updater's Redis
until it is flushed, so the docstore copy can be behind whatever has been typed
since; and this module rewrites the whole document it merges into. Reading a stale
copy and writing over it would revert those keystrokes, which is the one failure
mode here that an author would experience as data loss rather than as a bad list.

The project is therefore flushed before it is read. **The call is guarded and
cannot be verified outside the container**: this repo does not vendor the Overleaf
core, so whether `DocumentUpdaterHandler.promises.flushProjectToMongo` exists under
that name is not something the suite can answer. If it is absent the module logs a
warning and carries on, because a missing flush is a smaller problem than a feature
that refuses to run. **Post-deploy check, first thing:** open a project, type into a
chapter without waiting for a save, press the button, and confirm both that the
typing survives and that no `no flushProjectToMongo available` warning is in the
web log.

## The master lists

`data/acronyms-master.txt` and `data/symbols-master.txt` are **defaults and
examples, not a standard**. Whoever runs this repo is expected to edit them: add the
vocabulary of your own field, delete what you never use, fix an expansion you
disagree with. Nothing in the module depends on any particular entry, and a missing
or unreadable file is not fatal: every new row simply arrives with an empty cell.

The format is one entry per line, fields separated by `::`:

```
# acronyms-master.txt
ADCS :: Attitude Determination and Control System :: Sistema di determinazione e controllo d'assetto
JAXA :: Japan Aerospace Exploration Agency ::

# symbols-master.txt
\Omega :: right ascension of the ascending node :: ascensione retta del nodo ascendente :: rad
\Delta v :: velocity increment, delta-v :: incremento di velocità, delta-v :: m/s
```

* Blank lines and lines starting with `#` are ignored. Comments are used inside the
  shipped files to record the alternative meaning of an ambiguous key.
* A line that is not an entry costs that line and nothing else: one with no
  separator, one with no key, and one with a key but no definition in either
  language are all skipped, and the number skipped is counted and logged when the
  file is read. A key with only an Italian definition is a legitimate entry.
* The Italian field is optional. For an **acronym** it is deliberately empty most of
  the time: the long form of an acronym stays in English even in an Italian thesis,
  and the Italian column is filled only where a settled Italian wording exists. For
  a **symbol** it is a real translation, because an Italian list of symbols prints
  Italian descriptions. When the field is empty the English text is used.
* Keys are matched **case sensitively**: `SoC` and `SOC` are two different entries.
* A **unit is never a short form**, and a master entry does not get a vote on that:
  the master is consulted before the shape rules, so an entry that was also a unit
  used to walk straight past them. The shipped list no longer carries `AU` for that
  reason, and the code enforces it over whatever an operator adds.
* The unit field of a symbol is printed **only in a list this module creates**, in
  the third column of the table it generates. Merging into a list somebody else
  built, it writes the symbol and the description and leaves every other column
  alone: deciding that a narrow middle column in a table it did not design means
  "unit" would be the same guessing the module refuses everywhere else.
* A symbol key is a **scanner token**, not a formula. The scanner reduces what it
  finds to a base token: it steps over `\mathbf`, `\vec`, `\hat`, `\mathbb`,
  `\mathcal`, `\bar`, `\dot` and friends, and drops subscripts and superscripts. So
  `\mathbf{R}_{ij}`, `\hat{R}` and `R` are all the key `R`, and `q_w` is `q`. The
  one composite is the delta idiom: `\Delta v` is a key because `\Delta v` is read
  as one symbol.

The shipped scope is aerospace, **space** side: orbital mechanics, spacecraft
subsystems, GNC and AOCS, rendezvous and proximity operations, in-orbit servicing,
conjunction assessment and debris, plus the computer vision and machine learning
vocabulary a vision-based navigation laboratory writes every day. 186 acronyms and
72 symbols at the time of writing.

Two editorial rules are worth knowing about:

* **Canonical expansions, not the ones the sources had.** The lists were built from
  three real theses, and three of them carried a wrong expansion of an acronym used
  on every page. Those are corrected here.
* **Ambiguous letters are deliberately absent.** A symbol with three unrelated and
  equally common meanings (`k`, `s`, `w`, `V`, ...) is better left out: a symbol with
  no master entry is written into the list with an **empty** description, which the
  author then fills in. An empty cell is a question; a confidently wrong default is a
  mistake that gets printed. Where a key does have a dominant meaning but a well
  known second one, the entry carries the dominant meaning and a comment above it
  records the alternative.

## Recall over precision, and why

This is the opposite trade-off from the compliance checks in `overleaf-llm-image`.
Those checks are authoritative: they tell a student their document is wrong, so a
false accusation is expensive and they are tuned for precision. This module produces
a **draft the author curates by hand**. An extra row is deleted in two seconds; a
missing row is never noticed at all, and turns up at the viva.

So the scans cast wide. They catch mixed-case forms (`DoF`, `CiA`, `IoU`, `ReLU6`),
short forms carrying digits (`TF2`, `6DOF`, `L2`), plurals folded onto their
singular (`CPOs` becomes `CPO`), forms with an ampersand, a hyphen or a slash
(`TT&C`; `LEO/MEO` proposes `LEO` and `MEO`), occurrences inside `\textbf`,
`\texttt` and `\emph`, and occurrences in captions, footnotes and section titles.
For symbols they read inline maths as well as display maths. Recurrence is used to
**order** the result, never to hide an entry.

The anti-junk filter that survives is small and is written down where it is applied:
a real word set in capitals is not a short form, a long all-capitals word is not a
short form, a unit is not a short form, a repeated letter is not a short form, an
unknown token needs two occurrences, and a lone lowercase latin letter that the
whole document writes once is not a symbol of the work.

Because of all this the panel always says three things after a run, and they are not
optional:

* **which** entries were added, by name, split into the ones a definition was filled
  in for and the ones left blank;
* that the filled-in definitions come from a default list and **have to be
  reviewed**, because the next thesis may mean the other thing;
* that the scan is **heuristic and may have missed entries**;
* and, when a press hit the ceiling of 300 new rows, **how many are left** and that
  another press adds them. A cap that says nothing is a lie about what the button
  did, and it is also where "twice in a row changes nothing" stops being true.

The generated rows carry the same warning in the file, as a single LaTeX comment at
the head of the list. Its wording avoids `TODO`, `FIXME`, `TBD`, `TBU`, `to do:` and
`da fare:` on purpose: the compliance module's `work-markers` check reads comments,
and a generated list that made the reviewer report the document as unfinished would
be a self-inflicted finding. The suite pins the generated text against that exact
pattern.

## Routes

| method | path | authorisation |
| --- | --- | --- |
| `GET` | `/project/:Project_id/lists` | `ensureUserCanReadProject` |
| `POST` | `/project/:Project_id/lists/:kind/update` | `ensureUserCanWriteProjectContent` |
| `POST` | `/project/:Project_id/lists/:kind/create` | `ensureUserCanWriteProjectContent` |

Every error answer is JSON, never a page and never a stack trace: `{ ok: false,
error: <code>, message: <one English sentence> }`, plus the `path` concerned where
there is one. The panel keeps its own longer wording per code and falls back to the
server's sentence for a code it has not been taught, so a new code can never render
as "something went wrong".

All three routes scan the whole project, which is the most expensive thing a
logged-in user can ask of this instance short of a compile, so all three are **rate
limited** per user and route, in memory, with the same fixed-window limiter the
publish module uses: 60 a minute for the status route, which a page load fires by
itself, and **10 a minute for the two that write**, because a hundred presses a
minute is not a person and the second press of a correct one is already a no-op.
Being limited is a `429` with `rate_limited` and an English sentence.

`:kind` is `acronyms` or `symbols`, checked against a fixed set of two names and
never used to build a path. Both `POST` routes accept `{ "dryRun": true }`, which
computes everything and writes nothing: that is what the confirmation dialog shows,
so the preview cannot drift from what the button does. `create` also accepts
`{ "language": "it" | "en" }`, the only thing a request is allowed to decide.

Writing requires **write** access and not merely read access: `ensureUserCanReadProject`
is satisfied by a read-only collaborator and by a link-sharing viewer, neither of
whom may edit somebody else's thesis. There is no public surface at all.

## Enabling it

The module is **on by default** once it is built into the image, unlike the publish
module: publishing puts a document on the open internet and has to be asked for,
while this writes only into a project the user already has write access to, only
when they press a button, and only after they confirm.

```
LISTS_ENABLED=false     # keeps the routes unregistered
```

With the routes unregistered the toolbar button disappears on its own: it probes its
own status route on mount and renders nothing when the route is not there. Read-only
collaborators never see it either.

## Wiring it into an image

The module lives outside `overleaf-llm-image/`, exactly as `overleaf-publish-module/`
does, and enters the build as a named buildx context. **The four edits below are not
part of this directory and have to be applied by whoever owns the image build.**

1. `overleaf-llm-image/Dockerfile`, next to the publish module copy:

   ```dockerfile
   COPY --from=listsmodule / /overleaf/services/web/modules/lists/
   ```

2. `overleaf-llm-image/build.sh`, next to the publish build context:

   ```sh
   --build-context listsmodule="${HERE}/../overleaf-lists-module" \
   ```

   and the same existence check the publish module gets:

   ```sh
   if [ ! -f "$HERE/../overleaf-lists-module/index.mjs" ]; then
     echo "ERROR: overleaf-lists-module/ is missing" >&2
     exit 1
   fi
   ```

3. `overleaf-llm-image/patches/apply-core-patches.mjs`, in the `settings` block, so
   the router is registered. It anchors on the line the publish edit inserts:

   ```js
   strEdit(
     "settings: moduleImportSequence += 'lists'",
     "    'lists',",
     "    'publish',\n",
     "    'publish',\n    'lists',\n"
   ),
   ```

4. The same file, in the `toolbar.tsx` block, so the button renders:

   ```js
   strEdit(
     'toolbar: import ProjectListsButton',
     'modules/lists/frontend/js/components/lists-button',
     "import PublishProjectButton from '../../../../../../modules/publish/frontend/js/components/publish-button'\n",
     "import PublishProjectButton from '../../../../../../modules/publish/frontend/js/components/publish-button'\nimport ProjectListsButton from '../../../../../../modules/lists/frontend/js/components/lists-button'\n"
   ),
   strEdit(
     'toolbar: render ProjectListsButton before Publish',
     '<ProjectListsButton />',
     '        <PublishProjectButton />\n',
     '        <ProjectListsButton />\n        <PublishProjectButton />\n'
   ),
   ```

The button uses the `format_list_bulleted` Material Symbol. Check it is in the
unfilled icon subset the image ships (`core-overrides/material-symbols/`) before
shipping, the way `fact_check` had to be added for the compliance tab; if it is
missing the toolbar shows the literal glyph name.

## Tests

```
node overleaf-lists-module/test/run.mjs        # every suite
node overleaf-lists-module/test/lists.test.mjs # one suite, while working on it
```

No dependencies, no framework, no build. The suite **slices the controller's pure
core out of the real file** and evaluates it, because the controller imports
Overleaf internals that only exist inside the container. That means the tests
exercise the code that actually ships and not a copy of it, and it also means a
suite breaks when the text it anchors on moves: when that happens the fix is to
update the anchor, never to delete the test.

What is covered: the two shipped master lists parse completely with no duplicate
keys and no long dashes; detection and language in Italian, in English, by file name
and by heading, and the absence of a symbols list in an internship report; the four
row shapes, read and written; a merge that leaves every existing line byte for byte
and is byte-identical on the second press and does not write a second notice on a
later one; the recall fixtures for every form listed above; the payload naming the
new entries and splitting them into filled and blank; creation in both languages
with populated rows and empty cells; the three main-file hook-up cases including the
one that must leave the main file alone; and the cross-module contract that the
generated text trips no work marker.

A later abuse round added, in the same suite: a heading inside `lstlisting`,
`verbatim` and a comment; an `\input` shown in a listing; a bibliography and a
style file offered to the scan; CRLF files, accented definitions and keys made of
regex operators (`C++`, `A*`, `$\mu$C`); an item list with no labels; time budgets
on 600 KB of equations, 600 KB of verbatim, a 60 KB table of unterminated rows,
600 KB on one line and 2 MB of nested includes; an orphaned list file, a project
with no `\documentclass`, an empty project and one that is only a `.bib`; a master
list with broken lines and a duplicate key; and the payload fields for a press that
hit the ceiling and for a list carrying the same short form three times.

A security audit then added its own: the ReDoS section above, an oversized listing
whose `\end` is beyond any distance cap together with the real list that follows
it, a document read only in part, an uploaded file occupying a name, a comment
longer than the old strip bound, the rate limiters, the unit rule over master keys,
and the definitions a one-column list has nowhere to put.

Eighteen mutations have been run against the suite and each one turned it red: the
five original ones (removing the "never touch an existing row" guarantee, the
per-file gate, the master parser, the safe-point guard on the main file, and the
guard that writes the notice once), five from the abuse round (letting quoted LaTeX
count as document, letting the scan read `.bib` and `.sty` again, treating an
unlabelled item list as empty, putting back the quadratic environment splice, and
answering the file-name guard from the scanned docs), and eight from the audit
round (restoring one `\s*\*?\s*`, letting a truncated document be rewritten whole,
restoring the environment distance cap, restoring the 4000 character comment bound,
dropping a write route's rate limiter, dropping the unit rule over master keys,
putting `AU` back in the shipped list, and making a dropped definition silent
again).

Two of those mutations survived the first time and the fixtures were the thing at
fault, which is the point of running them: the truncation check was searching the
whole file for a string that also appears in the status route, and the oversized
listing was covered by a second guard that hid the first. Both fixtures were
tightened until the mutation died for the right reason.

The time budgets are deliberately loose, because a busy build box is not a
regression. What they catch is a return to quadratic: every one of them ran for
**seconds** before the splice loops were made linear, on one document a student
produces by accident.

### The whitespace rule, and why the suite enforces it structurally

`\s*\*?\s*\{` reads like "the command, an optional star, the brace" and is a
catastrophic backtracker: on a run of whitespace not followed by a brace the engine
tries every way of splitting the run between the two `\s*`. Ten patterns here had
that shape. It was reachable from `GET /project/:id/lists` with **read access
only**, which a link-sharing viewer has, and four kilobytes of whitespace cost
**31 seconds** of a single-threaded web process; `NON_PROSE_ARGUMENT` was cubic.
`stripComments` manufactures exactly that input, because it blanks a commented-out
block into a solid run of spaces.

Two rules now apply to every pattern in the module:

1. **No optional atom sits between two whitespace runs.** `\s*\*?\s*` is written
   `\s{0,40}(?:\*\s{0,40})?`, where the second run is reachable only after a
   literal star, so there is nothing to split.
2. **Every run is capped**, `{0,40}` between a command and its argument and
   `{0,200}` for indentation the module has to copy back out.

The suite enforces both against the shipped source, not only by timing: it counts
the uncapped runs in the file and requires that the only two left are the anchored
indentation reads, and it rejects the `X?\s{0,N}` shape outright. A pattern added
next year gets caught by the count, not by somebody remembering.

## Known limits

* **The list parsers here and in `overleaf-llm-image` are hand-kept copies of each
  other.** The compliance checks (`acronyms-missing-from-list`, `symbol-list`, the
  hand-written list collectors in `LLMStructuralChecks.mjs`) are the reference
  implementation for how a hand-written list is recognised. This module cannot
  import them, because it has to work on an instance that never builds the LLM
  image. If you change how a list is parsed there, come here; if you change it here,
  go there. The thresholds are not expected to match: see the recall section above.
* **Two symbol collapses are deliberate.** `\mathbb{R}` and `\mathbf{R}_{ij}` both
  reduce to `R`, and `SO(3)` and `SE(3)` both reduce to `S`. The consequence is
  always the same and always the safe one: the module believes the symbol is already
  listed and adds nothing.
* **Composite symbols other than the delta idiom are not proposed.** `I_{sp}` is
  proposed as `I`, and a row for the pair has to be written by hand. It is then
  preserved for ever like any other row.
* **Multi-line table rows are not parsed as rows.** A list whose entries wrap across
  lines keeps them untouched, and new rows are appended rather than interleaved.
* **Only two acronym declaration packages are read** for their own wording (`\acro`
  and `\newacronym`). A project that uses a package to typeset its list does not
  need this module anyway: the package builds the list itself. Since `.sty` and
  `.cls` files are not read at all, a `\newacronym` declared inside a custom style
  file is not read either; that is the price of not writing into the template, and
  it is the right way round.
* **A list with a mixture of labelled and unlabelled items is read only in part.**
  If even one `\item[KEY] value` is there it becomes the template, and the
  `\item value` rows around it stay invisible, which means an entry written that
  way can be proposed a second time. A list with no labels at all is refused
  outright instead; the mixture is rare enough that refusing it would cost more
  than it saves.
* **No admin override in v1.** The two files in `data/` are the only master lists.
  The intended v2 is a pair of textarea fields on a `/admin/lists/settings` page,
  stored in the same Mongo settings document the compliance rubrics use, parsed with
  the same `parseMasterList` and merged over the defaults with the admin entries
  winning per key. The parser already has the "last one wins" semantics that makes
  this a two-line change at the call site; what is missing is the page, its route
  behind the `super_admin` gate, and a cache invalidation on save.
