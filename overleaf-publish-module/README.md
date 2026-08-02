# Publish module

Serves a project's compiled PDF at a stable public URL, optionally behind a
password. Independent of the other modules in this repository and opt-in: set
`PUBLISH_ENABLED=true`, otherwise the module is not loaded and its routes do not
exist.

The public surface is two routes under `/published/`, and both take one key and
nothing else. Publishing requires write access to the project.

## The public link

Every published document gets a random token, and its link is
`/published/<token>.pdf`. The token is unguessable and it never changes.

A publisher can add an optional custom name, so that the link can be read out
loud: `/published/thesis-guide.pdf`. The name is an addition, never a
replacement. Both forms resolve to the same document and the same cached file,
so a link already shared with somebody never breaks, and the panel keeps showing
the permanent token link next to the custom one.

The name is written by hand and is therefore easy to guess, which is exactly what
makes it easy to share. That is a choice the publisher makes: the default stays
the random token, and the panel says so.

Names are canonical: lowercase, ASCII letters and digits, hyphens as separators,
3 to 64 characters. Whatever is typed is transformed once, server-side, and the
result is then validated like any other input. Names are unique across the whole
instance; asking for one that is not available answers `409` with
`That link name is already taken`.

## Guarantee: a released link name never points to somebody else's document

Link names are **never recycled**. When a project lets a name go, by renaming it,
by removing it, or by unpublishing altogether, the name is recorded in a register
it never leaves. Only the project that released it can take it back, which keeps
renaming back and forth or unpublishing and publishing again free of friction.

For everybody else the name is gone for good, and the refusal is identical to the
refusal for a name that is currently in use: from the outside there is no way to
tell a name that is taken from a name that once existed.

So a link somebody wrote down, printed on a handout or sent by mail can lead to
that project's document, or to nothing at all. It can never, at any point in the
future, lead to a different project's document. That is the one failure a
guessable URL makes possible, and the one nobody would notice from the outside.

## Storage

Two collections, both indexed on the name:

- `publishedDocuments`: one document per published project, holding the token,
  the publisher, the optional custom name (`slug`), the password hash and the
  cookie secret. Unique sparse index on `slug`, so live names cannot collide and
  documents without a name are not indexed at all.
- `publishedDocumentNames`: the register of released names, `{ slug, projectId,
  releasedAt }`. Unique index on `slug`. It outlives the published document,
  which is why it is a collection of its own.

Both indexes are created by the module on first use: there is nothing to run by
hand.

Existing published documents need no migration. They simply have no name, so
nothing about them changes, and the register starts empty: entries appear the
first time a name is released after the module is deployed.

## Tests

No dependencies, no framework, plain node against the module's own sources:

    node overleaf-publish-module/test/run.mjs

or a single suite while working on it:

    node overleaf-publish-module/test/slug.test.mjs

The suites slice the controller's source and evaluate it, because it imports
Overleaf internals that only exist inside the container. A suite that can no
longer find what it anchors on fails on purpose: the fix is to update the anchor,
never to delete the test.
