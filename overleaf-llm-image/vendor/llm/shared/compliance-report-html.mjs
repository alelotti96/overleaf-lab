// overleaf-lab: the ONE renderer of the standalone HTML report, shared verbatim
// between the editor download button (frontend, via webpack) and the archive the
// store writes at completion (backend Node). Extracted from use-llm-compliance.ts
// with esbuild: do not edit the frontend copy back into existence, THIS file is
// the source both sides read, which is what keeps the student's download and the
// dashboard's archived copy the same document.
//
// Input: the stored `result` object of a finished review (items, rubric, model,
// counts, delta, documentFiles...). Output: a self-contained HTML page, printable
// to PDF from any browser. Everything quoted from the document or the model goes
// through escapeHtml.
function escapeHtml(s) {
  return String(s || "").replace(
    /[&<>"']/g,
    (c) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[c] || c
  );
}
// overleaf-lab: THE TWO ENDS OF THE DEEP LINK, DELIBERATELY IN THE SAME FILE.
//
// The downloaded report writes `?llmGoto=<path>:<line>` next to every location; the
// editor reads it on load and jumps there. Writer and reader living apart is how the
// split-vote marker rotted (see warning_marker.test.mjs), so the two are one function
// each, side by side, and neither can be changed without seeing the other.
//
// WHAT THE PARAMETER IS ALLOWED TO BE. A project-relative file path and a line number.
// Not a URL, not a command, not an id. It arrives from an address bar and from files
// that have been forwarded and edited by hand, so it is parsed against a fixed shape
// and nothing else: no scheme, no backslash, no traversal, no empty segment, a line
// that is a positive integer of at most seven digits. Nothing here is ever evaluated,
// fetched or concatenated into markup.
//
// This is the FIRST of two gates. The second is the editor's own file tree: a path that
// survives this function still has to name a real document in this project before
// anything opens, so a well-formed path to a file that is not there does nothing at all.
const GOTO_PARAM = "llmGoto";
const GOTO_MAX_LENGTH = 400;
const GOTO_SHAPE = /^([A-Za-z0-9_ .\-]+(?:\/[A-Za-z0-9_ .\-]+)*):([0-9]{1,7})$/;
function gotoParamValue(path, line) {
  return `${String(path == null ? "" : path)}:${String(line == null ? "" : line)}`;
}
function parseGotoParam(search) {
  let raw = "";
  try {
    raw = new URLSearchParams(String(search || "")).get(GOTO_PARAM) || "";
  } catch (err) {
    return null;
  }
  if (!raw || raw.length > GOTO_MAX_LENGTH) {
    return null;
  }
  // A leading slash is how the review writes project paths; the editor's file tree does
  // not carry one, so it comes off before the path is matched against anything. EXACTLY
  // ONE slash: `//host/x.tex` is what a protocol-relative URL looks like, and a parser
  // that eats both slashes would quietly turn one into a plausible relative path.
  const trimmed = raw.replace(/^\//, "").replace(/^\.\//, "");
  const shaped = GOTO_SHAPE.exec(trimmed);
  if (!shaped) {
    return null;
  }
  const path = shaped[1];
  const line = Number(shaped[2]);
  if (!Number.isInteger(line) || line < 1) {
    return null;
  }
  // `..` is spelled with two characters the shape above happily accepts, so traversal
  // is refused segment by segment rather than by the pattern.
  if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    return null;
  }
  return { path, line };
}
// overleaf-lab: THE REPORT CHROME, IN THE TWO LANGUAGES THIS MODULE SERVES.
//
// Everything the model writes already speaks the rubric's language (the prompts say
// so), and the sentences the controller builds learned it too, so this page was the
// last place where an Italian thesis came back as Italian findings wedged between
// English furniture: "Evidence", "What to do", "3 things to fix".
//
// It is a flat table and not an i18n framework, on purpose: one static page, two
// languages, no catalogue, no loader, no keys that can go missing at runtime. The
// Italian object is MERGED ONTO the English one, so a key nobody translated falls back
// to English by construction rather than rendering "undefined" into a document a
// supervisor reads. Anything with a number in it is a function, because plurals and
// word order are not the same in the two languages and a template with a plural
// hardcoded in it is a translation waiting to be wrong.
//
// The language is READ, never guessed: `result.language` is what the review recorded.
// With no language on the result (an older archived report, a caller that never set
// one) the page is English, which is what it has always been.
const CHROME_EN = {
  htmlLang: "en",
  title: "Compliance review",
  evidence: "Evidence",
  whatToDo: "What to do",
  alsoAt: "Also at",
  // The source excerpt and the deep link back into the editor.
  inTheSource: "In the source",
  openInEditor: "Open this line in the editor",
  excerptShortened: "Long lines are shown shortened.",
  excerptsClipped: n =>
    `${n} ${n === 1 ? "location has" : "locations have"} no source excerpt here: this report keeps its excerpts within a fixed size so it stays small enough to store and to send. Open the file at the line shown to see the rest.`,
  // Guided mode. Every string here belongs to a control, so none of it is printed.
  guideTitle: "Work through it",
  guideProgress: (done, total) => `${done} of ${total} fixed`,
  guidePrev: "Previous",
  guideNext: "Next",
  guideClear: "Clear ticks",
  guideMarkFixed: "Fixed",
  guideHint:
    "Tick a finding once you have fixed it. The ticks are remembered by this browser, for this report only, and are never sent anywhere.",
  status: { ok: "OK", partial: "Partial", missing: "Missing", na: "N/A" },
  chip: { ok: "ok", partial: "partial", missing: "missing", na: "n/a" },
  readingsAgree: (agreeing, total) => `${agreeing} of ${total} readings agree`,
  thingsToFix: (n, places) =>
    `${n} ${n === 1 ? "thing" : "things"} to fix, in ${places} ${places === 1 ? "place" : "places"}`,
  thingsToFixCount: n => `${n} ${n === 1 ? "thing to fix" : "things to fix"}`,
  nothingToFix: "Nothing to fix",
  nothingToFixNote: "Nothing to fix: every requirement was met.",
  requirementsMet: n =>
    `${n} ${n === 1 ? "requirement" : "requirements"} met, nothing to do`,
  filesRead: n => `${n} ${n === 1 ? "file read" : "files read"}`,
  everywhere: "Everywhere and nowhere",
  everywhereNote:
    "These come from checks that look at the whole document, so there is no single line to go to.",
  notReviewed: "Not reviewed:",
  notReviewedNote:
    "These project files could not be read, so any requirement about their content is unverified.",
  notIncluded: "Not part of the document:",
  notIncludedNote:
    "Nothing in the main file pulls these in, so they do not reach the PDF and were left out of the review. If one of them should be in the document, add its <code>\\input</code> and run the review again.",
  model: model => `Model: ${model}`,
  // overleaf-lab: the fast-review banner. It is the first thing under the header
  // because everything below it has to be read in its light: a page with three
  // findings on it means something entirely different when twenty-seven requirements
  // were not looked at, and the n.a. rows say so one by one but only to whoever reads
  // that far.
  fastTitle: "Fast review",
  fastBanner: (checked, total) =>
    `${checked} of ${total} requirements were checked: the ones a program can decide on its own. The rest are marked n.a. and need a full review, which is the one that uses the review model.`,
  fastBannerPlain:
    "Only the requirements a program can decide on its own were checked. The rest are marked n.a. and need a full review, which is the one that uses the review model.",
  promptTokens: n => `about ${n} prompt tokens`,
  took: min => `took ${min} min`,
  deltaFirst:
    "First stored review of this project: there is nothing to compare it with yet.",
  deltaRubricChanged:
    "Not compared with the previous review: the rubric changed in between, so the same requirement may no longer mean the same thing.",
  deltaModelChanged: "Not compared with the previous review: that one ran on a different model.",
  deltaModeChanged:
    "Not compared with the previous review: the two were not run in the same mode, so they do not cover the same requirements.",
  deltaUnchanged: "No verdict changed since the previous review.",
  deltaSince: when => `Since the previous review${when ? ` (${when})` : ""}:`,
  deltaFixed: "fixed:",
  deltaNew: "new:",
  deltaStillOpen: n => `${n} requirements were already open and still are.`,
  // The delta's own honesty line: see buildDelta in LLMComplianceStore.
  deltaNotRechecked: n =>
    `${n} ${n === 1 ? "requirement" : "requirements"} could not be re-checked this run (the answer came back as n.a.), so ${n === 1 ? "it is" : "they are"} counted as neither fixed nor new.`,
  footerTied: (placed, total) => `${placed} of ${total} findings could be tied to a file.`,
  footerNote:
    "A finding with no line number came from a check that read a whole file or chapter, so the exact spot is not known. The amber outlined badge means the quoted passage could not be matched against the source, so that finding is less reliable than the others and is worth checking by hand. Line numbers are those of the source at review time.",
  footerTip:
    "Tip: use your browser's Print dialog to save this report as PDF. Folded sections are printed open, so nothing is lost on paper.",
  notRun: "NOT RUN",
  // Figures
  figuresTitle: "Figure resolution",
  figuresNotRun: "No figure in this project was measured, so nothing here says whether its images are sharp enough.",
  figuresCaveat:
    "Measured by code from the image files and the width each figure is printed at. These are numbers, not verdicts: what resolution is acceptable is for the guidelines to say.",
  figuresCounts: (raster, vector) => `${raster} raster, ${vector} vector`,
  figuresRange: (min, max) => `Lowest ${min} DPI, highest ${max} DPI.`,
  figuresHeadFigure: "Figure",
  figuresHeadPixels: "Pixels",
  figuresHeadWidth: "Printed width",
  figuresHeadDpi: "Resolution",
  figuresExact: "exact",
  figuresEstimated: mm => `estimated: assumes a text width of ${mm} mm`,
  figuresShowing: (shown, total) => `Showing the ${shown} lowest of ${total} measured figures.`,
  figuresUnmeasured: "Raster figures whose resolution could not be computed: treat these as unmeasured, not as low resolution.",
  figuresUnmeasuredShowing: (shown, total) => `Showing the first ${shown} of ${total}.`,
  // Bibliography
  bibTitle: "Bibliography check",
  bibNotRun:
    "No DOI in this project was resolved, so nothing here says whether its references exist.",
  bibCaveat:
    "These are facts about what a public metadata registry answered when the DOIs in this bibliography were resolved, not verdicts about the author. A DOI Crossref does not hold may be registered elsewhere, and those entries are counted as not checked.",
  bibChecked: (checked, total, requests) =>
    `Checked ${checked} of ${total} entries in ${requests} ${requests === 1 ? "request" : "requests"}.`,
  bibUncheckedLabel: "Not checked:",
  bibShowing: (shown, total) => `Showing the first ${shown} of ${total} findings, strongest first.`,
  bibClean:
    "Every DOI that could be checked resolved to a record matching its entry. That is a statement about the checked entries only.",
  bibEntryTitle: "The entry says",
  bibFoundTitle: "The record says",
  bibKind: {
    doi_not_found: "Citations whose DOI resolves nowhere",
    doi_mismatch: "Citations whose DOI resolves to a different work",
    doi_check_uncertain: "Citations whose DOI could not be confirmed either way",
    arxiv_published_version: "Preprints that Crossref also holds as published",
  },
  // The grade travels with every finding so that a suggestion can never be read as a
  // violation: the strongest fact this pipeline can produce about a bibliography and a
  // note about a preprint sit in the same list.
  bibGrade: {
    fact: "verified fact",
    uncertain: "could not tell",
    suggestion: "suggestion, not a violation",
  },
  bibReason: {
    no_doi: "carry no DOI",
    unreadable_doi: "carry a DOI that could not be read",
    doi_registered_outside_crossref:
      "have a DOI registered outside Crossref (DataCite: Zenodo, arXiv, datasets)",
    request_cap_reached: "were past this review's request budget",
    rate_limited: "were refused for rate limiting",
    network_error: "could not be reached",
    cancelled: "were dropped when the review was cancelled",
  },
};
const CHROME_IT = {
  htmlLang: "it",
  title: "Review di conformità",
  evidence: "Riscontro",
  whatToDo: "Cosa fare",
  alsoAt: "Anche in",
  inTheSource: "Nel sorgente",
  openInEditor: "Apri questa riga nell'editor",
  excerptShortened: "Le righe lunghe sono mostrate accorciate.",
  excerptsClipped: n =>
    `${n} ${n === 1 ? "posizione non ha" : "posizioni non hanno"} l'estratto del sorgente: questo report tiene gli estratti entro una dimensione fissa per restare abbastanza piccolo da archiviare e da spedire. Apri il file alla riga indicata per vedere il resto.`,
  guideTitle: "Procedi un punto alla volta",
  guideProgress: (done, total) => `${done} corretti su ${total}`,
  guidePrev: "Precedente",
  guideNext: "Successivo",
  guideClear: "Azzera le spunte",
  guideMarkFixed: "Corretto",
  guideHint:
    "Spunta un rilievo quando lo hai corretto. Le spunte le ricorda questo browser, solo per questo report, e non vengono inviate da nessuna parte.",
  status: { ok: "OK", partial: "Parziale", missing: "Mancante", na: "N/D" },
  chip: { ok: "ok", partial: "parziale", missing: "mancante", na: "n/d" },
  readingsAgree: (agreeing, total) => `${agreeing} letture su ${total} concordi`,
  thingsToFix: (n, places) =>
    `${n} ${n === 1 ? "cosa" : "cose"} da correggere, in ${places} ${places === 1 ? "punto" : "punti"}`,
  thingsToFixCount: n => `${n} ${n === 1 ? "cosa da correggere" : "cose da correggere"}`,
  nothingToFix: "Niente da correggere",
  nothingToFixNote: "Niente da correggere: ogni requisito è soddisfatto.",
  requirementsMet: n =>
    `${n} ${n === 1 ? "requisito soddisfatto" : "requisiti soddisfatti"}, niente da fare`,
  filesRead: n => `${n} ${n === 1 ? "file letto" : "file letti"}`,
  everywhere: "Ovunque e da nessuna parte",
  everywhereNote:
    "Vengono da controlli che leggono l'intero documento, quindi non c'è una riga sola a cui andare.",
  notReviewed: "Non esaminati:",
  notReviewedNote:
    "Questi file del progetto non si sono potuti leggere, quindi ogni requisito sul loro contenuto resta non verificato.",
  notIncluded: "Non fanno parte del documento:",
  notIncludedNote:
    "Nulla nel file principale li include, quindi non arrivano al PDF e sono rimasti fuori dalla review. Se uno di questi deve stare nel documento, aggiungi il suo <code>\\input</code> e rilancia la review.",
  model: model => `Modello: ${model}`,
  fastTitle: "Review rapida",
  fastBanner: (checked, total) =>
    `Sono stati controllati ${checked} requisiti su ${total}: quelli che un programma può decidere da solo. Gli altri sono segnati n.d. e richiedono una review completa, che è quella che usa il modello di revisione.`,
  fastBannerPlain:
    "Sono stati controllati solo i requisiti che un programma può decidere da solo. Gli altri sono segnati n.d. e richiedono una review completa, che è quella che usa il modello di revisione.",
  promptTokens: n => `circa ${n} token di prompt`,
  took: min => `durata ${min} min`,
  deltaFirst:
    "Prima review archiviata di questo progetto: non c'è ancora niente con cui confrontarla.",
  deltaRubricChanged:
    "Nessun confronto con la review precedente: nel frattempo la rubrica è cambiata, quindi lo stesso requisito può non voler dire più la stessa cosa.",
  deltaModelChanged:
    "Nessun confronto con la review precedente: quella è stata eseguita con un altro modello.",
  deltaModeChanged:
    "Nessun confronto con la review precedente: le due non sono state eseguite nella stessa modalità, quindi non coprono gli stessi requisiti.",
  deltaUnchanged: "Nessun verdetto è cambiato rispetto alla review precedente.",
  deltaSince: when => `Rispetto alla review precedente${when ? ` (${when})` : ""}:`,
  deltaFixed: "risolto:",
  deltaNew: "nuovo:",
  deltaStillOpen: n => `${n} requisiti erano già aperti e lo sono ancora.`,
  deltaNotRechecked: n =>
    `${n} ${n === 1 ? "requisito non si è" : "requisiti non si sono"} potuti ricontrollare in questa esecuzione (la risposta è tornata n.d.), quindi non ${n === 1 ? "viene contato" : "vengono contati"} né come risolti né come nuovi.`,
  footerTied: (placed, total) => `${placed} rilievi su ${total} sono stati collegati a un file.`,
  footerNote:
    "Un rilievo senza numero di riga viene da un controllo che ha letto un intero file o capitolo, quindi il punto esatto non è noto. Il contrassegno ambrato bordato significa che il passo citato non è stato ritrovato nel sorgente, quindi quel rilievo è meno affidabile degli altri e vale la pena verificarlo a mano. I numeri di riga sono quelli del sorgente al momento della review.",
  footerTip:
    "Suggerimento: usa la stampa del browser per salvare questo report in PDF. Le sezioni ripiegate vengono stampate aperte, quindi su carta non si perde niente.",
  notRun: "NON ESEGUITO",
  figuresTitle: "Risoluzione delle figure",
  figuresNotRun:
    "Nessuna figura di questo progetto è stata misurata, quindi qui non c'è niente che dica se le immagini sono abbastanza nitide.",
  figuresCaveat:
    "Misurata dal codice a partire dai file immagine e dalla larghezza con cui ogni figura viene stampata. Sono numeri, non verdetti: quale risoluzione sia accettabile lo dicono le linee guida.",
  figuresCounts: (raster, vector) => `${raster} raster, ${vector} vettoriali`,
  figuresRange: (min, max) => `Minimo ${min} DPI, massimo ${max} DPI.`,
  figuresHeadFigure: "Figura",
  figuresHeadPixels: "Pixel",
  figuresHeadWidth: "Larghezza stampata",
  figuresHeadDpi: "Risoluzione",
  figuresExact: "esatta",
  figuresEstimated: mm => `stimata: assume una larghezza del testo di ${mm} mm`,
  figuresShowing: (shown, total) => `Mostrate le ${shown} più basse su ${total} figure misurate.`,
  figuresUnmeasured:
    "Figure raster di cui non si è potuta calcolare la risoluzione: vanno considerate non misurate, non a bassa risoluzione.",
  figuresUnmeasuredShowing: (shown, total) => `Mostrate le prime ${shown} su ${total}.`,
  bibTitle: "Verifica della bibliografia",
  bibNotRun:
    "Nessun DOI di questo progetto è stato risolto, quindi qui non c'è niente che dica se i riferimenti esistono.",
  bibCaveat:
    "Sono fatti su cosa ha risposto un registro pubblico di metadati quando i DOI di questa bibliografia sono stati risolti, non verdetti sull'autore. Un DOI che Crossref non ha può essere registrato altrove, e quelle voci sono contate tra le non controllate.",
  bibChecked: (checked, total, requests) =>
    `Controllate ${checked} voci su ${total} con ${requests} ${requests === 1 ? "richiesta" : "richieste"}.`,
  bibUncheckedLabel: "Non controllate:",
  bibShowing: (shown, total) =>
    `Mostrati i primi ${shown} rilievi su ${total}, dai più solidi.`,
  bibClean:
    "Ogni DOI che si è potuto controllare ha portato a un record che corrisponde alla sua voce. Vale per le sole voci controllate.",
  bibEntryTitle: "La voce dice",
  bibFoundTitle: "Il record dice",
  bibKind: {
    doi_not_found: "Citazioni il cui DOI non porta da nessuna parte",
    doi_mismatch: "Citazioni il cui DOI porta a un lavoro diverso",
    doi_check_uncertain: "Citazioni il cui DOI non si è potuto confermare né smentire",
    arxiv_published_version: "Preprint che Crossref ha anche come pubblicati",
  },
  bibGrade: {
    fact: "fatto verificato",
    uncertain: "non si è potuto stabilire",
    suggestion: "suggerimento, non una violazione",
  },
  bibReason: {
    no_doi: "non hanno DOI",
    unreadable_doi: "hanno un DOI che non si è potuto leggere",
    doi_registered_outside_crossref:
      "hanno un DOI registrato fuori da Crossref (DataCite: Zenodo, arXiv, dataset)",
    request_cap_reached: "erano oltre il budget di richieste di questa review",
    rate_limited: "sono state rifiutate per limite di frequenza",
    network_error: "non sono state raggiungibili",
    cancelled: "sono state lasciate cadere quando la review è stata annullata",
  },
};
function chromeFor(result) {
  const declared = String(
    (result && (result.language || result.reportLanguage)) || ""
  ).toLowerCase();
  return declared.startsWith("it") ? { ...CHROME_EN, ...CHROME_IT } : CHROME_EN;
}
// overleaf-lab: SILENCE MUST NEVER READ AS A PASS.
//
// A check that was configured and did not run is not the same thing as a check that
// ran and found nothing, and the difference is invisible unless the report says it: a
// student who sees no bibliography section concludes the bibliography is fine. So a
// block that carries `enabled: false` renders its own section, with the reason, in
// the same place the findings would have been. Only an ABSENT block renders nothing,
// because that means the check does not exist on this deployment at all.
function buildNotRunHtml(id, heading, consequence, reason, T) {
  return `<section class="facts" id="${id}">
    <h2>${escapeHtml(heading)}</h2>
    <p class="notrun"><strong>${escapeHtml(T.notRun)}</strong>${reason ? ` (${escapeHtml(reason)})` : ""}. ${escapeHtml(consequence)}</p>
  </section>`;
}
// overleaf-lab: the "AI writing signals" section, built from the block
// LLMAISignals.mjs attaches to the result (`result.aiSignals`).
//
// TWO RULES GOVERN THIS FUNCTION AND NEITHER IS NEGOTIABLE.
//
// One: an empty block renders NOTHING. Not a heading, not "no signals found", not an
// empty box. A report that carries the words "AI writing signals" over a clean thesis
// has already put the question in the reader's head, and the student has no way to
// answer it. The section exists only when there is something concrete to look at.
//
// Two: the wording is an invitation to read, never a claim. The numbers here are
// counts and ratios; there is no score, no probability and no verdict, and the caveat
// is inside the section rather than in a footnote, because a section that is forwarded
// or printed alone must carry its own disclaimer.
//
// THREE: EVERY PASSAGE CARRIES ITS ADDRESS. This is the one section of the report that
// asks the reader to go and judge a passage themselves, and until the signals module
// learned to place them it quoted sentences with nowhere to go and look. `chip` is
// injected by the caller so that the same location chip, and the same link back into the
// editor, serve this section and the findings; the default keeps the plain rendering for
// anyone importing this function on its own.
function buildAiSignalsHtml(block, chip = null) {
  const where = chip || ((row) => {
    const file = escapeHtml(String(row?.file || ""));
    const line = typeof row?.line === "number" && row.line > 0 ? `:${row.line}` : "";
    return file ? `<code>${file}${line}</code>` : "";
  });
  // An excerpt used to be a bare string and is now `{ text, file, line }`. Both shapes
  // are read, for ever: a block archived before the change is rendered by today's code,
  // and this section is the last place that should start printing "[object Object]".
  const passage = (entry) =>
    typeof entry === "string" ? { text: entry } : entry && typeof entry === "object" ? entry : { text: "" };
  const artifacts = Array.isArray(block?.artifacts) ? block.artifacts : [];
  const flagged = Array.isArray(block?.flaggedChapters) ? block.flaggedChapters : [];
  const clusters = Array.isArray(block?.clusters) ? block.clusters : [];
  if (!artifacts.length && !flagged.length && !clusters.length) {
    return "";
  }
  const num = (value) => typeof value === "number" && Number.isFinite(value) ? String(Math.round(value * 100) / 100) : "";
  // overleaf-lab: a cap the reader cannot see is a lie about how much was found. Every
  // list in the block carries its true total next to what was kept, and wherever the
  // two differ the report says so, in the same place the list is.
  const showing = (what, tally) => {
    const shown = tally && typeof tally.shown === "number" ? tally.shown : null;
    const total = tally && typeof tally.total === "number" ? tally.total : null;
    if (shown === null || total === null || total <= shown) {
      return "";
    }
    return `<p class="meta">Showing the first ${shown} of ${total} ${what}.</p>`;
  };
  const artifactGroup = (kind, heading, note) => {
    const rows = artifacts.filter((a) => (a.kind || "tool") === kind);
    if (!rows.length) {
      return "";
    }
    return `<h3>${heading}</h3><p class="meta">${note}</p>${rows.map((row) => {
      const times = typeof row.occurrences === "number" && row.occurrences > 1 ? ` <span class="count">${row.occurrences} times</span>` : "";
      return `<div class="art"><strong>${escapeHtml(row.label || row.pattern || "")}</strong>${times} ${where(row)}${row.excerpt ? `<div class="q">${escapeHtml(row.excerpt)}</div>` : ""}</div>`;
    }).join("")}`;
  };
  const legend = Array.isArray(block?.legend) ? block.legend : [];
  const chaptersHtml = !flagged.length ? "" : `<h3>Chapters that do not read like the rest of this document</h3><p class="meta">Every number below is compared against the median of the ${typeof block?.totals?.comparedChapters === "number" ? block.totals.comparedChapters : ""} chapters of this same document, never against an outside standard, and a chapter is listed only when it sits far enough from that median to stand out. A field, a supervisor and a first language all move these numbers, which is why the comparison is with the document itself.</p>${flagged.map((chapter) => `<div class="chap"><h4>${escapeHtml(chapter.name || "")}</h4>${(chapter.signals || []).map((signal) => {
    const value = num(signal.value);
    const median = num(signal.thesisMedian);
    const side = signal.direction === "below" ? "lower than" : "higher than";
    const reading = value !== "" && median !== "" ? `<span class="val">this chapter ${value}, ${side} the document median of ${median}</span>` : "";
    const excerpts = (signal.excerpts || []).filter(Boolean).map(passage);
    const more = typeof signal.excerptsTotal === "number" && signal.excerptsTotal > excerpts.length ? `<p class="meta">Showing ${excerpts.length} of ${signal.excerptsTotal} occurrences in this chapter.</p>` : "";
    return `<div class="sig"><strong>${escapeHtml(signal.label || signal.id || "")}</strong> ${reading}${excerpts.length ? `<ul>${excerpts.map((e) => `<li class="q">${escapeHtml(e.text || "")}${e.file ? ` <span class="at">${where(e)}</span>` : ""}</li>`).join("")}</ul>` : ""}${more}</div>`;
  }).join("")}</div>`).join("")}${showing("chapters", block?.totals?.flaggedChapters)}${legend.length ? `<details><summary>What these signals are</summary><ul>${legend.map((entry) => `<li><strong>${escapeHtml(entry.label || entry.id || "")}</strong>: ${escapeHtml(entry.note || "")}</li>`).join("")}</ul></details>` : ""}`;
  const clustersHtml = !clusters.length ? "" : `<h3>Paragraphs carrying several stock phrases at once</h3><p class="meta">Listed when three or more DIFFERENT phrases from the pattern list appear in the same paragraph. A single phrase is never listed: everyone has favourite words, and a thesis is long.</p>${clusters.map((cluster) => {
    const markers = (cluster.markers || []).map((m) => escapeHtml(m)).join(", ");
    const hidden = typeof cluster.markersTotal === "number" && cluster.markersTotal > (cluster.markers || []).length ? ` and ${cluster.markersTotal - cluster.markers.length} more` : "";
    return `<div class="art"><strong>${escapeHtml(cluster.chapter || "")}</strong> ${where(cluster)} <span class="val">${markers}${hidden}</span>${cluster.paragraphExcerpt ? `<div class="q">${escapeHtml(cluster.paragraphExcerpt)}</div>` : ""}</div>`;
  }).join("")}${showing("paragraphs", block?.totals?.clusters)}`;
  return `<section class="aisig" id="ai-signals">
    <h2>AI writing signals</h2>
    <p class="caveat">These are stylistic signals and left-over artifacts that are worth a
    human look. They are <strong>not proof</strong> that any part of this document was
    machine-generated, and false positives are common, especially for authors writing in a
    language that is not their first. Nothing here is a verdict and nothing here counts as
    a finding: read the passages below and judge them yourself.</p>
    ${artifactGroup("tool", "Markers left behind by a chat interface", "These strings have no reason to exist in a LaTeX source: they are what a copy out of a chat window carries with it. Unlike everything else in this section, they are reported however few they are.")}
    ${artifactGroup("paste", "Characters that came from a rich-text source", "Typographic quotes and literal em-dash characters are not what a LaTeX source normally contains. They say the text was pasted from somewhere that formats as you type, which may be a chat window, a word processor or a web page.")}
    ${artifacts.length ? showing("rows", block?.totals?.artifacts) : ""}
    ${chaptersHtml}
    ${clustersHtml}
    <p class="meta">Computed by code, with no language model involved, from pattern list
    version ${escapeHtml(block?.version || "")}. The list is dated on purpose: the phrasing
    habits it looks for are those of its time, and an older report should be read as the
    signals somebody would have looked at then.</p>
  </section>`;
}
// overleaf-lab: shared by the two fact sections below. A number that is not a number
// renders as nothing rather than as the word "undefined": these blocks are written by
// four different producers over three versions of the schema, and an older archived
// report is rendered by today's code.
function factNumber(value) {
  return typeof value === "number" && Number.isFinite(value) ? String(value) : "";
}
function factWhere(row) {
  const file = escapeHtml(row.file || "");
  const line = typeof row.line === "number" && row.line > 0 ? `:${row.line}` : "";
  return file ? `<code>${file}${line}</code>` : "";
}
// overleaf-lab: the "Figure resolution" section, from the block LLMImageMetrics
// attaches to the result (`result.imageMetrics`).
//
// The discipline is the AI signals section's, for the same reasons: facts and true
// totals, no verdict anywhere, every string that came out of the student's project
// escaped. Two things are specific to this block.
//
// One: AN ESTIMATED NUMBER CARRIES ITS ASSUMPTION IN THE SAME CELL. A figure sized as a
// fraction of \textwidth has no printed width until a text width is assumed, and a
// reader shown "112 DPI" with the assumption in a footnote will quote the number and
// forget the footnote. So every row says whether it is exact, and an estimated row
// names the width it assumed, next to the number and not under the table.
//
// Two: the figures whose resolution could NOT be computed are listed under a label that
// says what they are NOT. An unmeasured figure sitting in a list below the low ones is
// read as a low one, and that is an accusation the code did not make.
function buildImageMetricsHtml(block, T) {
  if (!block) {
    return "";
  }
  if (block.enabled === false) {
    return buildNotRunHtml("figure-resolution", T.figuresTitle, T.figuresNotRun, block.reason, T);
  }
  const measured = Array.isArray(block.measured) ? block.measured : [];
  const unchecked = Array.isArray(block.unchecked) ? block.unchecked : [];
  if (!measured.length && !unchecked.length) {
    // Nothing was measured and nothing failed to measure: a project whose figures are
    // all vector, or one with no figures. A heading over an empty table would only
    // make the reader look for something that is not there.
    return "";
  }
  const totals = block.totals || {};
  const formats = Object.entries(totals.formats || {})
    .sort((a, b) => b[1] - a[1])
    // Both halves escaped: the count comes out of a stored document, and a document
    // that has been through Mongo is not a place to start trusting types.
    .map(([name, n]) => `${escapeHtml(String(n))} ${escapeHtml(name)}`)
    .join(", ");
  const countsLine = `${T.figuresCounts(factNumber(totals.raster) || 0, factNumber(totals.vector) || 0)}${formats ? ` (${formats})` : ""}.`;
  const range =
    block.dpiRange && typeof block.dpiRange.min === "number" && typeof block.dpiRange.max === "number"
      ? ` ${T.figuresRange(block.dpiRange.min, block.dpiRange.max)}`
      : "";
  const assumed = factNumber(block.assumedTextWidthMm);
  const rows = measured
    .map((row) => {
      const pixels =
        factNumber(row.width) && factNumber(row.height)
          ? `${factNumber(row.width)} x ${factNumber(row.height)}`
          : "";
      const width = factNumber(row.renderedWidthMm);
      const dpi = factNumber(row.dpi);
      const mark = row.exact
        ? T.figuresExact
        : T.figuresEstimated(assumed || factNumber(row.assumedTextWidthMm) || "?");
      return `<tr><td>${row.path ? `<code>${escapeHtml(row.path)}</code>` : ""} ${factWhere(row)}</td><td>${pixels}</td><td>${width ? `${width} mm` : ""}</td><td>${dpi ? `${dpi} DPI` : ""} <span class="mark">(${escapeHtml(mark)})</span></td></tr>`;
    })
    .join("");
  const measuredHtml = !measured.length
    ? ""
    : `<div class="tablewrap"><table class="ftable"><thead><tr><th>${escapeHtml(T.figuresHeadFigure)}</th><th>${escapeHtml(T.figuresHeadPixels)}</th><th>${escapeHtml(T.figuresHeadWidth)}</th><th>${escapeHtml(T.figuresHeadDpi)}</th></tr></thead><tbody>${rows}</tbody></table></div>${
        totals.measured && totals.measured.total > measured.length
          ? `<p class="meta">${escapeHtml(T.figuresShowing(measured.length, totals.measured.total))}</p>`
          : ""
      }`;
  const uncheckedHtml = !unchecked.length
    ? ""
    : `<p class="meta">${escapeHtml(T.figuresUnmeasured)}</p><ul>${unchecked
        .map(
          (row) =>
            `<li>${row.path ? `<code>${escapeHtml(row.path)}</code>` : ""} ${factWhere(row)} ${escapeHtml(row.reason || "")}</li>`
        )
        .join("")}</ul>${
        totals.unchecked && totals.unchecked.total > unchecked.length
          ? `<p class="meta">${escapeHtml(T.figuresUnmeasuredShowing(unchecked.length, totals.unchecked.total))}</p>`
          : ""
      }`;
  return `<section class="facts" id="figure-resolution">
    <h2>${escapeHtml(T.figuresTitle)}</h2>
    <p class="caveat">${escapeHtml(T.figuresCaveat)}</p>
    <p class="meta">${countsLine}${range}</p>
    ${measuredHtml}
    ${uncheckedHtml}
  </section>`;
}
// overleaf-lab: the "Bibliography check" section, from the block LLMBibVerify attaches
// to the result (`result.bibVerify`).
//
// This is the strongest single fact the pipeline can produce about a fabricated
// bibliography - a DOI that resolves nowhere, or to somebody else's paper - and until
// this function existed it reached the student only if the model happened to restate a
// hint line in one of its items. Three rules.
//
// The GRADE of every finding is shown. The block puts a verified fact and a suggestion
// about a preprint in the same list, and a suggestion rendered like a violation is a
// false accusation the module took care not to make.
//
// BOTH TITLES are quoted wherever both exist. "The DOI resolves to a different work" is
// not checkable by the reader unless the reader can see the two titles that were
// compared, and the whole point of this section is that it can be checked.
//
// The entries that were NOT checked are counted by reason, because "checked 12 of 40"
// with no account of the other 28 reads as a bibliography that mostly passed.
const BIB_KIND_ORDER = [
  "doi_not_found",
  "doi_mismatch",
  "doi_check_uncertain",
  "arxiv_published_version",
];
function buildBibVerifyHtml(block, T) {
  if (!block) {
    return "";
  }
  if (block.enabled === false) {
    return buildNotRunHtml("bibliography-check", T.bibTitle, T.bibNotRun, block.reason, T);
  }
  const findings = Array.isArray(block.findings) ? block.findings : [];
  const totals = block.totals || {};
  // NOTHING CHECKED IS NOT A CLEAN BIBLIOGRAPHY. The reassuring sentence below belongs
  // only to a run that actually resolved something: over zero entries it is a vacuous
  // truth that reads as an all-clear, which is the same mistake as a silent section.
  const checked = typeof block.checked === "number" ? block.checked : 0;
  const reasons = Object.entries(block.uncheckedByReason || {})
    .sort((a, b) => b[1] - a[1])
    .map(([reason, n]) => `${n} ${escapeHtml((T.bibReason && T.bibReason[reason]) || reason)}`)
    .join(", ");
  // A kind this renderer does not know about is still shown, under its own raw name:
  // a finding added to the module later must not disappear from the report until
  // somebody remembers to come back here.
  const kinds = [
    ...BIB_KIND_ORDER,
    ...findings.map((f) => String(f.kind || "")).filter((k) => k && !BIB_KIND_ORDER.includes(k)),
  ];
  const seenKinds = new Set();
  const groups = kinds
    .filter((kind) => {
      if (seenKinds.has(kind)) return false;
      seenKinds.add(kind);
      return true;
    })
    .map((kind) => {
      const rows = findings.filter((f) => String(f.kind || "") === kind);
      if (!rows.length) {
        return "";
      }
      const heading = (T.bibKind && T.bibKind[kind]) || kind;
      return `<h3>${escapeHtml(heading)} <span class="count">${rows.length}</span></h3>${rows
        .map((row) => {
          const grade = (T.bibGrade && T.bibGrade[row.grade]) || row.grade || "";
          return `<div class="art"><strong>${escapeHtml(row.key || "")}</strong> ${factWhere(row)}${
            grade ? ` <span class="grade">${escapeHtml(grade)}</span>` : ""
          }${
            row.entryTitle
              ? `<div class="q">${escapeHtml(T.bibEntryTitle)}: &quot;${escapeHtml(row.entryTitle)}&quot;</div>`
              : ""
          }${
            row.foundTitle
              ? `<div class="q">${escapeHtml(T.bibFoundTitle)}: &quot;${escapeHtml(row.foundTitle)}&quot;</div>`
              : ""
          }${row.detail ? `<div>${escapeHtml(row.detail)}</div>` : ""}</div>`;
        })
        .join("")}`;
    })
    .join("");
  const capped =
    totals.findings && totals.findings.total > findings.length
      ? `<p class="meta">${escapeHtml(T.bibShowing(findings.length, totals.findings.total))}</p>`
      : "";
  return `<section class="facts" id="bibliography-check">
    <h2>${escapeHtml(T.bibTitle)}</h2>
    <p class="caveat">${escapeHtml(T.bibCaveat)}</p>
    <p class="meta">${escapeHtml(
      T.bibChecked(checked, factNumber(block.total) || 0, factNumber(block.requests) || 0)
    )}${reasons ? ` ${escapeHtml(T.bibUncheckedLabel)} ${reasons}.` : ""}</p>
    ${findings.length ? groups : checked > 0 ? `<p class="meta">${escapeHtml(T.bibClean)}</p>` : ""}
    ${capped}
  </section>`;
}
function buildReportHtml(result) {
  const T = chromeFor(result);
  const counts = {
    ok: 0,
    partial: 0,
    missing: 0,
    na: 0
  };
  for (const item of result.items) {
    counts[item.status] = (counts[item.status] || 0) + 1;
  }
  const statusLabel = T.status;
  const statusClass = {
    ok: "st-ok",
    partial: "st-partial",
    missing: "st-missing",
    na: "st-na"
  };
  const chipLabel = T.chip;
  const severity = {
    missing: 0,
    partial: 1,
    na: 2,
    ok: 3
  };
  const shortRequirement = (text) => {
    const full = (text || "").trim();
    const numbered = /^(\d+[.)]\s*)([\s\S]*)$/.exec(full);
    const prefix = numbered ? numbered[1] : "";
    const rest = numbered ? numbered[2] : full;
    const cut = /^(.{20,110}?)(:|\.\s|;)/.exec(rest);
    if (cut) {
      return `${prefix}${cut[1]}${cut[1].length < rest.length ? "..." : ""}`;
    }
    if (rest.length <= 110) {
      return `${prefix}${rest}`;
    }
    const clipped = rest.slice(0, 110);
    const lastSpace = clipped.lastIndexOf(" ");
    return `${prefix}${lastSpace > 40 ? clipped.slice(0, lastSpace) : clipped}...`;
  };
  // overleaf-lab: THE DEEP LINK BACK INTO THE EDITOR. The controller stores the project
  // URL on the result when the instance declared a siteUrl; here it is re-tested rather
  // than trusted, because this renderer is also handed results read back out of Mongo
  // and a value that ends up in an href is not a value to take on faith. Nothing else in
  // this document is allowed to be an absolute URL: the page must stay readable with no
  // network at all, so a stylesheet, a font or an image from a host would be a bug.
  const projectUrl = /^https?:\/\/[^\s"'<>]+$/i.test(String(result.projectUrl || ""))
    ? String(result.projectUrl)
    : "";
  // The parameter carries a path and a line and nothing else. The reader of it (the
  // editor hook) validates the shape again and resolves the path against the project's
  // own file tree, so a link that has been edited by hand opens nothing.
  // A location with no line is a whole file, and the parameter has no way to say that:
  // its shape is a path AND a line. So a file-only location keeps its chip and loses its
  // link, rather than being linked to a line nobody measured.
  const lineOrZero = (l) =>
    l && typeof l.line === "number" && Number.isFinite(l.line) && l.line > 0 ? l.line : 0;
  const gotoHref = (l) =>
    projectUrl && l && l.path && lineOrZero(l)
      ? `${projectUrl}?${GOTO_PARAM}=${encodeURIComponent(gotoParamValue(l.path, l.line))}`
      : "";
  const locChip = (l) => {
    const line = lineOrZero(l);
    const label = `${escapeHtml(String(l.path || ""))}${line ? `:${line}` : ""}`;
    if (!label) {
      return "";
    }
    const href = gotoHref(l);
    return href
      ? `<a class="jump" href="${escapeHtml(href)}" title="${escapeHtml(T.openInEditor)}"><code>${label}</code></a>`
      : `<code>${label}</code>`;
  };
  // The AI-signals section speaks `{ file, line }` while the findings speak
  // `{ path, line }`, so the adapter lives here rather than in either of them.
  const factChip = (row) =>
    row && row.file ? locChip({ path: row.file, line: row.line }) : "";
  // overleaf-lab: the excerpt the controller attached, as a mini code block with the
  // offending line marked. Everything in it is the student's own LaTeX, so every line
  // goes through escapeHtml: this is the one block of this document that quotes source
  // bytes verbatim, and it is rendered inside a page a supervisor opens.
  const excerptBlock = (l) => {
    const excerpt = l && l.excerpt;
    const lines = excerpt && Array.isArray(excerpt.lines) ? excerpt.lines : [];
    if (!lines.length) {
      return "";
    }
    const start = typeof excerpt.start === "number" && excerpt.start > 0 ? excerpt.start : 0;
    const mark = typeof excerpt.mark === "number" ? excerpt.mark : -1;
    const rows = lines
      .map((text, i) => {
        const n = start ? start + i : 0;
        const hit = i === mark;
        return `<span class="sl${hit ? " hit" : ""}"><span class="n">${n ? escapeHtml(String(n)) : ""}</span><span class="t">${escapeHtml(String(text == null ? "" : text))}</span></span>`;
      })
      .join("");
    const shortened = excerpt.clipped
      ? `<p class="meta cut">${escapeHtml(T.excerptShortened)}</p>`
      : "";
    return `<div class="srcblk"><div class="srchd"><span class="lbl inline">${escapeHtml(T.inTheSource)}</span>${locChip(l)}</div><pre class="src">${rows}</pre>${shortened}</div>`;
  };
  const seenAnchors = /* @__PURE__ */ new Set();
  const anchorFor = (item) => {
    const base = `req-${(item.requirement || "").replace(/[^\w]+/g, "-").slice(0, 40).toLowerCase()}`;
    let anchor = base;
    let n = 2;
    while (seenAnchors.has(anchor)) {
      anchor = `${base}-${n++}`;
    }
    seenAnchors.add(anchor);
    return anchor;
  };
  const renderItem = (item, atLine = -1, atPath = "", fixable = false) => {
    const cls = statusClass[item.status] || "st-na";
    const label = statusLabel[item.status] || statusLabel.na;
    const warning = /\s*\[warning:\s*([^\]]+)\]\s*$/i.exec(item.evidence || "");
    const evidenceText = (item.evidence || "").replace(
      /\s*\[warning:\s*[^\]]+\]\s*$/i,
      ""
    );
    const warningHtml = warning ? `<span class="warn">${escapeHtml(warning[1])}</span>` : "";
    const parts = evidenceText.split(/\s\|\s|\r?\n/).map((p) => p.trim().replace(/^(?:[-*•]|\d+[.)])\s+/, "")).filter(Boolean);
    // overleaf-lab: the ENGINE's split-vote marker, in BOTH the spellings the engine
    // can write. A chapter vote that did not agree with itself appends this note to the
    // evidence, and the note is built with the controller's L(): matching only the
    // English one left an Italian report with the raw "[verdetto ...]" marker sitting
    // in the middle of a sentence, and cost the reader the one badge that says "this
    // verdict was not unanimous". The two spellings are pinned in the suite together
    // with the controller's own template, so neither side can move alone.
    const contestedNote =
      /\s*\[(?:verdict agreed by (\d+) of (\d+) readings|verdetto concorde in (\d+) letture su (\d+))\]\s*/i;
    const renderPart = (p) => {
      const split = contestedNote.exec(p);
      const clean = p.replace(contestedNote, " ").trim();
      const agreeing = split ? split[1] || split[3] : "";
      const total = split ? split[2] || split[4] : "";
      const badge = split ? ` <span class="warn">${escapeHtml(T.readingsAgree(agreeing, total))}</span>` : "";
      return `${escapeHtml(clean)}${badge}`;
    };
    const renderList = (ps) => `<ul>${ps.map((p) => `<li>${renderPart(p)}</li>`).join("")}</ul>`;
    const evidenceBody = parts.length > 8 ? `${renderList(parts.slice(0, 6))}<details class="more"><summary>${parts.length - 6} more</summary>${renderList(parts.slice(6))}</details>` : parts.length > 1 ? renderList(parts) : renderPart(evidenceText);
    const evidence = evidenceText ? `<div class="ev"><span class="lbl">${escapeHtml(T.evidence)}</span>${evidenceBody}</div>` : "";
    // overleaf-lab: the locations that carry an excerpt are rendered BELOW, each one
    // headed by its own chip, so listing them again under "Also at" would print every
    // one of them twice. What stays in "Also at" is exactly what has no code block of
    // its own: the places the reader still has to go and find by hand.
    const excerpted = (item.locations || []).filter(
      (l) => l && l.excerpt && Array.isArray(l.excerpt.lines) && l.excerpt.lines.length
    );
    const sources = excerpted.map(excerptBlock).join("");
    const alsoSeen = /* @__PURE__ */ new Set();
    const others = (item.locations || []).filter((l) => {
      if (l && l.excerpt && Array.isArray(l.excerpt.lines) && l.excerpt.lines.length) return false;
      if (atLine >= 0 && l.path === atPath && l.line === atLine) return false;
      const key = `${l.path}:${l.line}`;
      if (evidenceText.includes(key)) return false;
      if (alsoSeen.has(key)) return false;
      alsoSeen.add(key);
      return true;
    });
    const locations = others.length ? `<div class="loc"><span class="lbl inline">${escapeHtml(T.alsoAt)}</span>${others.map((l) => locChip(l)).join(" ")}</div>` : "";
    const suggestion = item.suggestion ? `<div class="sg"><span class="lbl">${escapeHtml(T.whatToDo)}</span>${escapeHtml(item.suggestion)}</div>` : "";
    // overleaf-lab: the gutter is the finding's HOME line, and it is the one location a
    // reader looks at first, so it is the one that most needs to be a jump. It carries
    // no path of its own (the file block above it is the path), which is why it took a
    // pass over this file to notice it was the only location in the document with no way
    // to be clicked.
    const gutterLink = atLine > 0 && atPath ? gotoHref({ path: atPath, line: atLine }) : "";
    const gutter =
      atLine >= 0
        ? `<span class="ln">${
            atLine > 0
              ? gutterLink
                ? `<a class="jump" href="${escapeHtml(gutterLink)}" title="${escapeHtml(T.openInEditor)}">L${atLine}</a>`
                : `L${atLine}`
              : ""
          }</span>`
        : "";
    const anchor = anchorFor(item);
    // overleaf-lab: the guided-mode tick. Rendered for the findings that are actually
    // things to fix and for no others, since a checkbox next to a met requirement asks
    // the reader to do something about a requirement that is already satisfied. It is
    // invisible until the inline script declares the page guided, so a browser with
    // scripting off shows a plain report and not a row of controls that do nothing.
    const fixbox = fixable
      ? `<label class="fixbox"><input type="checkbox" class="fx" data-fx="${anchor}"><span>${escapeHtml(T.guideMarkFixed)}</span></label>`
      : "";
    return `<div class="item ${cls}${fixable ? " fixable" : ""}" id="${anchor}" tabindex="-1">${gutter}<div class="body"><div class="req"><span class="badge">${label}</span><span class="rtext" title="${escapeHtml(
      item.requirement
    )}">${escapeHtml(shortRequirement(item.requirement))}</span>${warningHtml}${fixbox}</div>${evidence}${sources}${locations}${suggestion}</div></div>`;
  };
  const problems = result.items.filter((item) => item.status !== "ok").sort((a, b) => severity[a.status] - severity[b.status]);
  const passed = result.items.filter((item) => item.status === "ok");
  const itemsHtml = passed.length ? `<details><summary>${escapeHtml(T.requirementsMet(passed.length))}</summary>
${passed.map((item) => renderItem(item)).join("\n")}
</details>` : "";
  const filesHtml = result.documentFiles && result.documentFiles.length ? `<details class="files"><summary>${escapeHtml(T.filesRead(result.documentFiles.length))}</summary><ul>${result.documentFiles.map((f) => `<li><code>${escapeHtml(f)}</code></li>`).join("")}</ul></details>` : "";
  const skippedHtml = result.documentFilesSkipped && result.documentFilesSkipped.length ? `<p class="skipped"><strong>${escapeHtml(T.notReviewed)}</strong> ${result.documentFilesSkipped.map(
    (f) => `<code>${escapeHtml(f.path)}</code>${f.reason ? ` (${escapeHtml(f.reason)})` : ""}`
  ).join(", ")}. ${escapeHtml(T.notReviewedNote)}</p>` : "";
  const notIncludedHtml = result.documentFilesNotIncluded && result.documentFilesNotIncluded.length ? `<p class="skipped"><strong>${escapeHtml(T.notIncluded)}</strong> ${result.documentFilesNotIncluded.map((f) => `<code>${escapeHtml(f)}</code>`).join(", ")}. ${T.notIncludedNote}</p>` : "";
  const homeOf = (item) => {
    const sorted = [...item.locations || []].sort(
      (a, b) => a.path === b.path ? a.line - b.line : a.path.localeCompare(b.path)
    );
    if (sorted.length > 0) {
      return sorted[0];
    }
    const source = (item.sourceFiles || [])[0];
    return source ? { path: source, line: 0 } : null;
  };
  const byFile = /* @__PURE__ */ new Map();
  const loose = [];
  for (const item of problems) {
    const home = homeOf(item);
    if (!home) {
      loose.push(item);
      continue;
    }
    if (!byFile.has(home.path)) byFile.set(home.path, []);
    byFile.get(home.path).push({ line: home.line, item });
  }
  const placed = problems.length - loose.length;
  const fileAnchor = (path) => `file-${path.replace(/[^\w]+/g, "-")}`;
  const indexHtml = problems.length ? `<ul class="toc">${[...byFile.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(
    ([path, hits]) => `<li><a href="#${fileAnchor(path)}"><code>${escapeHtml(
      path
    )}</code><span class="count">${hits.length}</span></a></li>`
  ).join("")}${loose.length ? `<li><a href="#file-loose"><span>${escapeHtml(T.everywhere)}</span><span class="count">${loose.length}</span></a></li>` : ""}</ul>` : "";
  const fileBlock = (heading, note, entries, anchor, path = "") => `<div class="fileblock" id="${anchor}"><h3>${heading} <span class="count">${escapeHtml(T.thingsToFixCount(entries.length))}</span></h3>${note ? `<p class="meta">${escapeHtml(note)}</p>` : ""}${entries.sort(
    (a, b) => severity[a.item.status] - severity[b.item.status] || a.line - b.line
  ).map((e) => renderItem(e.item, e.line, path, true)).join("")}</div>`;
  const byFileHtml = problems.length ? `${[...byFile.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(
    ([path, hits]) => fileBlock(`<code>${escapeHtml(path)}</code>`, "", hits, fileAnchor(path), path)
  ).join("\n  ")}
  ${loose.length ? fileBlock(
    escapeHtml(T.everywhere),
    T.everywhereNote,
    loose.map((item) => ({ line: 0, item })),
    "file-loose"
  ) : ""}` : `<p class="meta">${escapeHtml(T.nothingToFixNote)}</p>`;
  // overleaf-lab: a model line only when a model was involved. A fast review records
  // no model (see the controller), and "Model: null" over a page produced by parsers
  // would be both ugly and false; the banner below says what produced this report.
  const metaParts = result.model ? [escapeHtml(T.model(result.model))] : [];
  // overleaf-lab: WHICH BACKEND ANSWERED, when the instance runs a pool of them.
  // Arrives already written in the report's language (the reviewer builds it with its
  // own L(), which knows the rubric's language) rather than through a T key: this is
  // the only string in the document whose text depends on configuration the renderer
  // cannot see, and inventing a second dictionary entry for it would give the two
  // sides two ways to name the same machine. Absent on a single-backend install and
  // on every report archived before the pool existed, and then nothing is drawn.
  if (result.endpointNote) {
    metaParts.push(escapeHtml(result.endpointNote));
  }
  if (typeof result.documentTokensEstimate === "number") {
    metaParts.push(escapeHtml(T.promptTokens(result.documentTokensEstimate)));
  }
  if (result.completedAt) {
    metaParts.push(escapeHtml(new Date(result.completedAt).toLocaleString()));
  }
  if (result.durationMs) {
    metaParts.push(
      escapeHtml(T.took(Math.max(1, Math.round(result.durationMs / 6e4))))
    );
  }
  const metaLine = metaParts.join(' <span class="sep">&middot;</span> ');
  const statusOrder = ["missing", "partial", "ok", "na"];
  const totalItems = result.items.length;
  const barHtml = totalItems ? `<div class="bar" aria-hidden="true">${statusOrder.filter((s) => counts[s] > 0).map(
    (s) => `<span class="${statusClass[s]}" style="width:${(counts[s] / totalItems * 100).toFixed(2)}%"></span>`
  ).join("")}</div>` : "";
  const chipsHtml = `<ul class="chips">${statusOrder.map(
    (s) => `<li class="chip ${statusClass[s]}${counts[s] ? "" : " zero"}"><i></i><b>${counts[s] || 0}</b> ${chipLabel[s]}</li>`
  ).join("")}</ul>`;
  // overleaf-lab: the requirements this run could not re-check. It is part of the delta
  // and not a footnote to it: a comparison that silently left rows out is exactly the
  // kind of half-truth the delta exists to avoid, and it has to be visible in the same
  // box as the "fixed:" lines it is the counterweight to. Shown even when nothing
  // moved, which is the case that used to render as "No verdict changed" over a run
  // that in fact measured five fewer requirements than the one before it.
  const notRecheckedCount = result.delta?.notRecheckedCount || 0;
  const notRecheckedHtml = notRecheckedCount ? `<p class="meta">${escapeHtml(T.deltaNotRechecked(notRecheckedCount))}</p>` : "";
  // overleaf-lab: the fast-review banner, drawn from the mode the run recorded and
  // never inferred from the items. Counting the n.a. rows would look equivalent and is
  // not: a full review also produces n.a. rows (a check that found no material to
  // judge, a pass that failed), and a banner built on that count would appear over
  // reports that are not fast at all.
  const coverage = result.modeCoverage;
  const fastHtml = result.mode !== "fast" ? "" : `<div class="fastbar"><strong>${escapeHtml(T.fastTitle)}</strong> ${escapeHtml(
    coverage && typeof coverage.checked === "number" && typeof coverage.total === "number"
      ? T.fastBanner(coverage.checked, coverage.total)
      : T.fastBannerPlain
  )}</div>`;
  const deltaHtml = !result.delta ? "" : !result.delta.comparable ? `<p class="meta">${escapeHtml(result.delta.reason === "rubric_changed" ? T.deltaRubricChanged : result.delta.reason === "mode_changed" ? T.deltaModeChanged : result.delta.reason === "model_changed" ? T.deltaModelChanged : T.deltaFirst)}</p>` : (result.delta.resolved?.length || 0) === 0 && (result.delta.regressed?.length || 0) === 0 ? `<div class="delta"><p class="meta">${escapeHtml(T.deltaUnchanged)}</p>${notRecheckedHtml}</div>` : `<div class="delta"><strong>${escapeHtml(T.deltaSince(result.delta.previousAt ? new Date(result.delta.previousAt).toLocaleDateString() : ""))}</strong>
    <ul>
      ${(result.delta.resolved || []).map((d) => `<li class="fixed">${escapeHtml(T.deltaFixed)} ${escapeHtml(shortRequirement(d.requirement))}</li>`).join("")}
      ${(result.delta.regressed || []).map((d) => `<li class="broke">${escapeHtml(T.deltaNew)} ${escapeHtml(shortRequirement(d.requirement))}</li>`).join("")}
    </ul>${result.delta.stillOpenCount ? `<p class="meta">${escapeHtml(T.deltaStillOpen(result.delta.stillOpenCount))}</p>` : ""}${notRecheckedHtml}</div>`;
  // overleaf-lab: GUIDED MODE. The report is a list of things to fix, and a list of
  // things to fix that cannot be ticked off is read once and then abandoned halfway
  // through, with no way of telling where "halfway" was. So each finding gets a tick,
  // the header gets a count, and two buttons walk the reader from one finding to the
  // next.
  //
  // THREE RULES, and the page is wrong if any of them stops holding.
  //
  // One: NO ASSET LEAVES THIS FILE. The script is inline, the styles are inline, there
  // is no font, no image and no fetch. This document is opened from a Downloads folder,
  // on a train, months later, and it has to be exactly as complete then as it is now.
  //
  // Two: WITH SCRIPTING OFF, THE CONTROLS DO NOT EXIST. They are hidden by CSS and the
  // script is what declares the page guided; a checkbox that cannot remember anything
  // and a Next button that goes nowhere are worse than a plain page, and a plain page
  // is exactly what this still is.
  //
  // Three: THE TICKS BELONG TO ONE REPORT. The key carries completedAt, so downloading
  // a newer review starts from a clean sheet rather than showing the previous run's
  // ticks against this run's findings, which would mark as fixed things nobody fixed.
  // Sanitised to a strict allowlist because it is interpolated into a script tag.
  const guideKey = String(result.completedAt || "").replace(/[^\w:.+-]/g, "");
  const fixableCount = problems.length;
  const guideHtml = fixableCount
    ? `<div class="guide" id="guide" role="group" aria-label="${escapeHtml(T.guideTitle)}">
    <div class="gbar" aria-hidden="true"><span id="gfill"></span></div>
    <p class="gtext" id="gtext" role="status" aria-live="polite">${escapeHtml(T.guideProgress(0, fixableCount))}</p>
    <div class="gnav">
      <button type="button" id="gprev">${escapeHtml(T.guidePrev)}</button>
      <button type="button" id="gnext">${escapeHtml(T.guideNext)}</button>
      <button type="button" id="gclear">${escapeHtml(T.guideClear)}</button>
    </div>
    <p class="ghint">${escapeHtml(T.guideHint)}</p>
  </div>`
    : "";
  // The progress sentence is built here, in the page's language, as a template with two
  // holes: the chrome table is a JavaScript object this script cannot reach, and a
  // number formatted in English inside an Italian report is exactly the kind of seam
  // the chrome table exists to remove.
  const guideProgressTemplate = T.guideProgress("{done}", "{total}");
  const jsString = (value) =>
    JSON.stringify(String(value)).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
  const guideScript = fixableCount
    ? `<script>
(function () {
  var boxes = [].slice.call(document.querySelectorAll('.fx'));
  var items = [].slice.call(document.querySelectorAll('.item.fixable'));
  if (!boxes.length || !items.length) { return; }
  document.documentElement.className += ' guided';
  var KEY = 'llm-review-guide:${guideKey}';
  var TEMPLATE = ${jsString(guideProgressTemplate)};
  var fill = document.getElementById('gfill');
  var text = document.getElementById('gtext');
  var state = {};
  // Private browsing, a file:// origin with storage disabled, a full quota: none of
  // these may cost the reader the report. Ticks that cannot be saved simply do not
  // survive the tab, and everything else still works.
  try { state = JSON.parse(window.localStorage.getItem(KEY) || '{}') || {}; } catch (e) { state = {}; }
  function save() { try { window.localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }
  function paint() {
    var done = 0;
    for (var i = 0; i < boxes.length; i++) {
      var id = boxes[i].getAttribute('data-fx');
      var on = Object.prototype.hasOwnProperty.call(state, id);
      boxes[i].checked = on;
      var card = document.getElementById(id);
      if (card) { card.className = card.className.replace(/ done\\b/g, '') + (on ? ' done' : ''); }
      if (on) { done++; }
    }
    if (fill) { fill.style.width = Math.round((done * 100) / boxes.length) + '%'; }
    if (text) {
      text.textContent = TEMPLATE.replace('{done}', String(done)).replace('{total}', String(boxes.length));
    }
  }
  document.addEventListener('change', function (ev) {
    var target = ev.target;
    if (!target || target.className.indexOf('fx') === -1) { return; }
    var id = target.getAttribute('data-fx');
    if (!id) { return; }
    if (target.checked) { state[id] = 1; } else { delete state[id]; }
    save();
    paint();
  });
  var at = -1;
  function go(step) {
    at = at < 0 ? (step > 0 ? 0 : items.length - 1) : (at + step + items.length) % items.length;
    var el = items[at];
    if (el.scrollIntoView) { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
    try { el.focus({ preventScroll: true }); } catch (e) { el.focus(); }
  }
  var prev = document.getElementById('gprev');
  var next = document.getElementById('gnext');
  var clear = document.getElementById('gclear');
  if (prev) { prev.addEventListener('click', function () { go(-1); }); }
  if (next) { next.addEventListener('click', function () { go(1); }); }
  if (clear) { clear.addEventListener('click', function () { state = {}; save(); paint(); }); }
  paint();
})();
</script>`
    : "";
  // overleaf-lab: the excerpt budget, stated when it bit. Excerpts that stop partway
  // down the report look exactly like locations the review could not place, and the
  // difference between "we ran out of room" and "we could not find it" is the whole
  // credibility of the location list.
  const excerptClipped = result.excerpts && result.excerpts.capped > 0 ? result.excerpts.capped : 0;
  const excerptNoteHtml = excerptClipped
    ? `<p>${escapeHtml(T.excerptsClipped(excerptClipped))}</p>`
    : "";
  const aiSignalsHtml = buildAiSignalsHtml(result.aiSignals, factChip);
  // overleaf-lab: the two fact sections. They sit after the findings and before the AI
  // signals: they are not compliance verdicts, so they must not be read as any, but
  // they are measurements of THIS document and belong above the section that is only
  // ever an invitation to look.
  const bibVerifyHtml = buildBibVerifyHtml(result.bibVerify, T);
  const imageMetricsHtml = buildImageMetricsHtml(result.imageMetrics, T);
  const title = `${escapeHtml(T.title)} - ${escapeHtml(result.rubric.name)}`;
  return `<!doctype html>
<html lang="${T.htmlLang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title>
<style>
  /* One palette per medium, all of it behind custom properties: the dark scheme and
     the print stylesheet only re-declare these tokens, they never restate a rule. */
  :root{
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,Liberation Mono,monospace;
    --bg:#fff;--fg:#16181d;--muted:#646b76;--faint:#8b929c;
    --hairline:#e3e6eb;--surface:#f6f7f9;--code-bg:#eff1f5;
    --accent:#0b5394;--accent-bg:#f1f6fc;--accent-br:#cbdff5;
    --badge-fg:#fff;
    --ok:#146c43;--ok-tint:#f4faf6;--ok-br:#d7e8de;
    --partial:#b45309;--partial-tint:#fdf8ef;--partial-br:#eeddc2;
    --missing:#b42318;--missing-tint:#fdf5f4;--missing-br:#f0d6d2;
    --na:#5c636a;--na-tint:#f8f9fa;--na-br:#e3e6ea;
  }
  *{box-sizing:border-box}
  html{-webkit-text-size-adjust:100%}
  body{font-family:-apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica Neue,Arial,sans-serif;font-size:15.5px;line-height:1.55;color:var(--fg);background:var(--bg);max-width:880px;margin:0 auto;padding:2.5rem 1.25rem 3rem;-webkit-print-color-adjust:exact;print-color-adjust:exact}
  h1{font-size:1.65rem;line-height:1.25;letter-spacing:-.015em;font-weight:700;margin:0 0 .2rem}
  h2{font-size:1.2rem;line-height:1.3;letter-spacing:-.01em;font-weight:600;margin:2rem 0 .6rem}
  h3{font-size:.98rem;font-weight:600;margin:0 0 .55rem}
  p{margin:0 0 .7rem}
  a{color:var(--accent)}
  a:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
  code{font-family:var(--mono);font-size:.85em;background:var(--code-bg);border-radius:4px;padding:.08em .32em;overflow-wrap:anywhere}
  /* Header */
  .head{border-bottom:1px solid var(--hairline);padding-bottom:1rem;margin-bottom:1.35rem}
  .rubric{font-size:1.02rem;font-weight:500;margin:0 0 .35rem}
  .metaline{font-size:.8rem;color:var(--muted);margin:0}
  .sep{opacity:.45;padding:0 .15rem}
  /* Overview: the whole verdict as one bar, with the numbers next to it */
  .overview{margin:0 0 1.5rem}
  .bar{display:flex;height:10px;border-radius:999px;overflow:hidden;background:var(--hairline)}
  .bar>span{flex:0 0 auto;background:var(--c)}
  .bar>span:last-child{flex:1 0 auto}
  .chips{display:flex;flex-wrap:wrap;gap:.4rem;list-style:none;margin:.6rem 0 0;padding:0}
  .chip{display:inline-flex;align-items:center;gap:.4rem;font-size:.8rem;line-height:1.45;background:var(--surface);border:1px solid var(--hairline);border-radius:999px;padding:.18rem .65rem}
  .chip i{width:8px;height:8px;border-radius:50%;background:var(--c);flex:0 0 auto}
  .chip b{font-weight:700;font-variant-numeric:tabular-nums}
  .chip.zero{color:var(--muted)}
  .chip.zero i{opacity:.4}
  .summary{background:var(--surface);border:1px solid var(--hairline);border-radius:10px;padding:.85rem 1rem;margin:1rem 0 1.25rem;white-space:pre-wrap;font-size:.95rem}
  .meta{color:var(--muted);font-size:.86rem}
  /* Index of files */
  .toc{list-style:none;margin:.5rem 0 1.5rem;padding:0;border:1px solid var(--hairline);border-radius:10px;overflow:hidden}
  .toc li+li{border-top:1px solid var(--hairline)}
  .toc a{display:flex;align-items:center;justify-content:space-between;gap:1rem;padding:.45rem .75rem;color:var(--fg);text-decoration:none}
  .toc a:hover{background:var(--surface)}
  .toc code{background:none;padding:0;font-size:.86rem}
  .count{display:inline-block;background:var(--code-bg);color:var(--muted);border-radius:999px;padding:.05rem .55rem;font-size:.72rem;font-weight:700;font-variant-numeric:tabular-nums;white-space:nowrap}
  /* One file, one block */
  .fileblock{border:1px solid var(--hairline);border-radius:12px;padding:.9rem 1rem 1rem;margin:1rem 0;scroll-margin-top:1rem}
  .fileblock h3{display:flex;align-items:center;gap:.55rem;flex-wrap:wrap;break-after:avoid}
  .fileblock h3 code{background:none;padding:0;font-size:.95rem;font-weight:600}
  /* One finding, one card. The status is the left edge, the pill and the wash. */
  .item{display:flex;gap:.7rem;padding:.7rem .85rem;margin:.6rem 0;background:var(--tint);border:1px solid var(--br);border-left:3px solid var(--c);border-radius:8px;scroll-margin-top:1rem;break-inside:avoid;page-break-inside:avoid}
  .item .body{min-width:0;flex:1}
  .st-ok{--c:var(--ok);--tint:var(--ok-tint);--br:var(--ok-br)}
  .st-partial{--c:var(--partial);--tint:var(--partial-tint);--br:var(--partial-br)}
  .st-missing{--c:var(--missing);--tint:var(--missing-tint);--br:var(--missing-br)}
  .st-na{--c:var(--na);--tint:var(--na-tint);--br:var(--na-br)}
  .req{font-weight:600;font-size:1rem;line-height:1.45}
  .req .rtext{cursor:help}
  .badge{display:inline-block;background:var(--c);color:var(--badge-fg);border-radius:999px;padding:.1rem .5rem;margin-right:.5rem;font-size:11px;font-weight:700;letter-spacing:.07em;text-transform:uppercase;line-height:1.5;vertical-align:.08em;white-space:nowrap}
  .warn{display:inline-block;margin-left:.4rem;border:1px solid var(--partial);color:var(--partial);background:none;border-radius:999px;padding:0 .5rem;font-size:11px;font-weight:600;line-height:1.6;vertical-align:.08em;white-space:nowrap}
  .ln{flex:0 0 auto;min-width:2.6rem;text-align:right;font-family:var(--mono);font-size:.76rem;color:var(--faint);font-variant-numeric:tabular-nums;padding-top:.3rem}
  .lbl{display:block;font-size:10.5px;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);margin-bottom:.15rem}
  .lbl.inline{display:inline;margin:0 .45rem 0 0}
  /* The source excerpt: the finding's own line with two lines either side, the offending
     one marked by the status colour. It scrolls INSIDE its box, because a LaTeX line is
     as long as the author made it and the page must never scroll sideways. */
  .srcblk{margin:.6rem 0 0}
  .srchd{margin-bottom:.22rem}
  .src{font-family:var(--mono);font-size:.78rem;line-height:1.55;background:var(--code-bg);border:1px solid var(--br);border-radius:8px;margin:0;padding:.35rem 0;overflow-x:auto}
  .src .sl{display:block;padding:0 .65rem}
  .src .sl.hit{background:var(--tint);border-left:3px solid var(--c);padding-left:calc(.65rem - 3px);font-weight:600}
  .src .n{display:inline-block;min-width:2.9rem;text-align:right;padding-right:.75rem;color:var(--faint);font-variant-numeric:tabular-nums;-webkit-user-select:none;user-select:none}
  .src .t{white-space:pre}
  .cut{margin:.22rem 0 0;font-size:.76rem}
  /* A location that links back into the editor still READS as a path, not as a button:
     the chip is what the reader already knows, the link is what it gained. */
  a.jump{text-decoration:none}
  a.jump code{color:var(--accent);text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px}
  a.jump:hover code{background:var(--accent-bg)}
  a.jump:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:4px}
  /* Guided mode. Hidden until the inline script declares the page guided, so scripting
     off leaves a plain report rather than a row of controls that do nothing. */
  .guide,.fixbox{display:none}
  .guided .guide{display:block}
  .guided .fixbox{display:inline-flex;align-items:center;gap:.3rem;margin-left:.55rem;font-size:.78rem;font-weight:500;color:var(--muted);cursor:pointer;vertical-align:.08em}
  .guide{position:sticky;top:0;z-index:5;background:var(--bg);border:1px solid var(--hairline);border-radius:10px;padding:.6rem .85rem;margin:0 0 1rem}
  .gbar{height:8px;border-radius:999px;background:var(--hairline);overflow:hidden}
  .gbar>span{display:block;height:100%;width:0;background:var(--ok);transition:width .2s ease}
  .gtext{margin:.4rem 0 0;font-size:.83rem;color:var(--muted);font-variant-numeric:tabular-nums}
  .gnav{display:flex;gap:.4rem;margin-top:.5rem;flex-wrap:wrap}
  .gnav button{font:inherit;font-size:.82rem;color:var(--fg);background:var(--surface);border:1px solid var(--hairline);border-radius:6px;padding:.22rem .75rem;cursor:pointer}
  .gnav button:hover{background:var(--code-bg)}
  .gnav button:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .ghint{margin:.5rem 0 0;font-size:.76rem;color:var(--faint)}
  .item.done{opacity:.5}
  .item.done .rtext{text-decoration:line-through}
  .item:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
  .ev,.loc,.sg{font-size:.9rem;margin-top:.55rem}
  .ev{border-left:2px solid var(--br);padding-left:.7rem}
  .ev ul{margin:.1rem 0 0;padding-left:1.05rem}
  .ev li{margin:.18rem 0}
  .loc{color:var(--muted)}
  .loc code{display:inline-block;margin:.12rem .2rem .12rem 0;color:var(--fg)}
  .sg{background:var(--accent-bg);border:1px solid var(--accent-br);border-left:3px solid var(--accent);border-radius:8px;padding:.55rem .7rem}
  .sg .lbl{color:var(--accent)}
  /* Folded sections: quiet rows, never a shouting control */
  details{margin:.7rem 0}
  summary{display:block;cursor:pointer;color:var(--muted);font-size:.88rem;font-weight:600;padding:.35rem .5rem;border-radius:6px;list-style:none}
  summary::-webkit-details-marker{display:none}
  summary::before{content:"";display:inline-block;width:0;height:0;border:4px solid transparent;border-left-color:currentColor;margin-right:.5rem;vertical-align:.1em}
  details[open]>summary::before{transform:rotate(90deg)}
  summary:hover{background:var(--surface);color:var(--fg)}
  .more{margin:.35rem 0 0}
  .more>summary{font-size:.82rem;font-weight:500;padding:.2rem .4rem}
  .files ul{margin:.3rem 0 0;padding-left:1.15rem;font-size:.85rem;color:var(--muted)}
  .files li{margin:.12rem 0}
  .skipped{font-size:.87rem;background:var(--partial-tint);border:1px solid var(--partial-br);border-left:3px solid var(--partial);border-radius:8px;padding:.6rem .75rem;margin:.8rem 0}
  .skipped strong{color:var(--partial)}
  /* The fast-review banner: the same quiet surface as the delta, one notch of accent
     on the left so it is not skipped, and never a status colour - "this run looked at
     less" is a fact about the run, not a finding against the document. */
  .fastbar{font-size:.9rem;background:var(--surface);border:1px solid var(--hairline);border-left:3px solid var(--partial);border-radius:10px;padding:.7rem .85rem;margin:1rem 0}
  .fastbar strong{color:var(--partial)}
  .delta{font-size:.9rem;background:var(--surface);border:1px solid var(--hairline);border-radius:10px;padding:.7rem .85rem;margin:1rem 0}
  .delta ul{margin:.35rem 0 0;padding-left:1.15rem}
  .delta li{margin:.12rem 0}
  .delta .fixed{color:var(--ok)}
  .delta .broke{color:var(--missing)}
  .delta .meta{margin:.45rem 0 0}
  /* AI writing signals. Deliberately the quietest block in the document: the neutral
     surface, no status colour, no accent border. Anything that looked like the
     "missing" wash would read as a charge, and this section is not one. */
  .aisig{border:1px solid var(--hairline);border-radius:12px;padding:.9rem 1rem 1rem;margin:1.75rem 0 1rem}
  .aisig h2{margin:0 0 .6rem}
  .aisig h3{margin:1.15rem 0 .35rem}
  .aisig h4{font-size:.92rem;font-weight:600;margin:.9rem 0 .3rem}
  .aisig .caveat{background:var(--surface);border:1px solid var(--hairline);border-left:3px solid var(--na);border-radius:8px;padding:.6rem .75rem;font-size:.87rem;margin:0 0 .6rem}
  .aisig .art{margin:.45rem 0}
  .aisig .sig{border-left:2px solid var(--hairline);padding-left:.7rem;margin:.45rem 0}
  .aisig .val{color:var(--muted);font-size:.83rem;font-variant-numeric:tabular-nums}
  .aisig .q{font-family:var(--mono);font-size:.78rem;color:var(--muted);overflow-wrap:anywhere;margin-top:.2rem}
  .aisig ul{margin:.25rem 0 0;padding-left:1.05rem;font-size:.9rem}
  .aisig li{margin:.15rem 0}
  .aisig li.q{font-size:.78rem}
  /* The address of a quoted passage, next to the passage. Quiet, because the passage is
     what the reader is being asked to look at; present, because until it was there the
     reader had a sentence and no way to find it. */
  .aisig .at,.facts .at{font-size:.76rem;color:var(--muted);white-space:nowrap}
  .aisig .at code,.facts .at code{background:none;padding:0}
  /* The two measured-fact sections (bibliography, figures). Same quiet surface as the
     signals block, because these are not verdicts either; the one loud thing in them
     is the NOT RUN line, which has to be impossible to read as a pass. */
  .facts{border:1px solid var(--hairline);border-radius:12px;padding:.9rem 1rem 1rem;margin:1.75rem 0 1rem}
  .facts h2{margin:0 0 .6rem}
  .facts h3{display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;margin:1.15rem 0 .35rem}
  .facts .caveat{background:var(--surface);border:1px solid var(--hairline);border-left:3px solid var(--na);border-radius:8px;padding:.6rem .75rem;font-size:.87rem;margin:0 0 .6rem}
  .facts .art{margin:.5rem 0;font-size:.9rem}
  .facts .q{font-family:var(--mono);font-size:.78rem;color:var(--muted);overflow-wrap:anywhere;margin-top:.2rem}
  .facts ul{margin:.25rem 0 0;padding-left:1.05rem;font-size:.88rem}
  .facts li{margin:.15rem 0}
  .facts .grade{display:inline-block;border:1px solid var(--hairline);border-radius:999px;padding:0 .5rem;font-size:11px;font-weight:600;color:var(--muted);white-space:nowrap}
  .facts .mark{color:var(--muted);font-size:.78rem;white-space:nowrap}
  .notrun{background:var(--partial-tint);border:1px solid var(--partial-br);border-left:3px solid var(--partial);border-radius:8px;padding:.6rem .75rem;font-size:.9rem;margin:0}
  .notrun strong{color:var(--partial);letter-spacing:.06em}
  /* A long path plus four columns overflows a phone; the table scrolls, the page does
     not. */
  .tablewrap{overflow-x:auto;margin:.4rem 0 .2rem}
  .ftable{border-collapse:collapse;width:100%;font-size:.85rem}
  .ftable th{text-align:left;font-weight:600;color:var(--muted);border-bottom:1px solid var(--hairline);padding:.3rem .5rem .3rem 0;white-space:nowrap}
  .ftable td{border-bottom:1px solid var(--hairline);padding:.3rem .5rem .3rem 0;vertical-align:top;font-variant-numeric:tabular-nums}
  .ftable td:first-child{overflow-wrap:anywhere}
  .notes{border-top:1px solid var(--hairline);margin-top:2.25rem;padding-top:.85rem;font-size:.8rem;color:var(--muted)}
  .notes p:last-child{margin:0}
  /* Dark: a true dark ground, tints dark enough not to glow, statuses lightened
     so they stay legible on it and the pill takes near-black text instead of white. */
  @media (prefers-color-scheme:dark){
    :root{
      --bg:#121417;--fg:#e6e8ec;--muted:#98a0ad;--faint:#7d8592;
      --hairline:#282c33;--surface:#181b1f;--code-bg:#23272d;
      --accent:#7cb8f5;--accent-bg:#141d27;--accent-br:#27405a;
      --badge-fg:#101318;
      --ok:#4ec98c;--ok-tint:#14201a;--ok-br:#254232;
      --partial:#f2b544;--partial-tint:#211c12;--partial-br:#453820;
      --missing:#f2837a;--missing-tint:#211618;--missing-br:#4a2c2c;
      --na:#9aa3af;--na-tint:#1a1d22;--na-br:#31363d;
    }
  }
  /* Print: forced back to light whatever the screen scheme is, tints dropped to
     white to save ink while the status keeps its border and its pill.
     Printing must not hide what the reader folded away: on paper there is nothing to
     click, so every details is opened. Two rules are needed because browsers hide
     that content in two different ways. Current engines put it behind the
     ::details-content pseudo-element with content-visibility:hidden, which is the
     rule that actually does the work here (verified by printing this report to PDF:
     with only the older rule the "N more" evidence was silently dropped from the
     PDF). Older ones hide the children themselves, which the second rule covers. */
  @media print{
    :root{
      --bg:#fff;--fg:#000;--muted:#3f454d;--faint:#5a616a;
      --hairline:#d3d7dd;--surface:#f6f7f9;--code-bg:#eef0f4;
      --accent:#0b5394;--accent-bg:#f4f8fd;--accent-br:#c9dcf2;
      --badge-fg:#fff;
      --ok:#146c43;--ok-tint:#fff;--ok-br:#d0e3d8;
      --partial:#b45309;--partial-tint:#fff;--partial-br:#ecdcc2;
      --missing:#b42318;--missing-tint:#fff;--missing-br:#efd4d0;
      --na:#5c636a;--na-tint:#fff;--na-br:#e0e3e7;
    }
    body{margin:0;max-width:none;padding:0;font-size:11pt}
    details{display:block}
    details::details-content{content-visibility:visible!important;block-size:auto!important}
    details>*{display:block}
    summary{color:#000;padding-left:0}
    summary::before{display:none}
    /* On paper the evidence is one continuous list: the "N more" row was a control,
       and a control that cannot be clicked is just noise. The captions of the other
       folds are kept, since they say what the section below them is. */
    .more>summary{display:none}
    .toc a,.fileblock a{text-decoration:none;color:#000}
    h2,h3{break-after:avoid}
    /* Paper has no controls: the guided chrome goes, ticks and all. And a finding the
       reader ticked off is still a finding, so the printed copy shows it whole rather
       than faded and struck through, which on a monochrome printer reads as deleted. */
    .guide,.fixbox{display:none!important}
    .item.done{opacity:1}
    .item.done .rtext{text-decoration:none}
    a.jump code{color:#000;text-decoration:none;background:none}
    .src{background:#f6f7f9;border:1px solid #d3d7dd}
    .srcblk{break-inside:avoid;page-break-inside:avoid}
  }
</style></head>
<body>
  <header class="head">
    <h1>${escapeHtml(T.title)}</h1>
    ${result.rubric.name ? `<p class="rubric">${escapeHtml(result.rubric.name)}</p>` : ""}
    <p class="metaline">${metaLine}</p>
  </header>
  <section class="overview">
    ${barHtml}
    ${chipsHtml}
  </section>
  ${fastHtml}
  ${deltaHtml}
  ${skippedHtml}
  ${notIncludedHtml}
  ${result.summary ? `<div class="summary">${escapeHtml(result.summary)}</div>` : ""}
  ${problems.length ? `<h2>${escapeHtml(T.thingsToFix(problems.length, byFile.size + (loose.length ? 1 : 0)))}</h2>
  ${indexHtml}
  ${guideHtml}` : `<h2>${escapeHtml(T.nothingToFix)}</h2>`}
  ${byFileHtml}
  ${itemsHtml}
  ${filesHtml}
  ${bibVerifyHtml}
  ${imageMetricsHtml}
  ${aiSignalsHtml}
  <footer class="notes">
    <p>${escapeHtml(T.footerTied(placed, problems.length))}
    ${escapeHtml(T.footerNote)}</p>
    ${excerptNoteHtml}
    <p>${escapeHtml(T.footerTip)}</p>
  </footer>
  ${guideScript}
</body></html>`;
}
export {
  buildAiSignalsHtml,
  buildBibVerifyHtml,
  buildImageMetricsHtml,
  buildReportHtml,
  escapeHtml,
  GOTO_PARAM,
  gotoParamValue,
  parseGotoParam
};
