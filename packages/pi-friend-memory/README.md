# pi-friend-memory

A friendship-oriented memory extension for the Pi coding agent.

The storage foundation, strict schema, repository, memory lifecycle tools,
keyword and semantic search, sqlite-vec indexing, RAG injection, auto-capture,
consolidation, and dreaming are implemented.

This package lives at `packages/pi-friend-memory` in the `pi-friend` npm
workspace.

## Package layout

Pi loads the extension from the root-level composition entry:

```text
index.ts   # Pi-facing hooks, commands, and tool registrations
src/       # Configuration, storage, and implementation modules
```

## Memory storage

The default tree is:

```text
~/.pi/agent/pi-friend/memory/
├── nodes/
├── staging/
├── history/
│   ├── deleted/
│   ├── dropped/
│   ├── edited/
│   ├── merged/
│   └── split/
├── access-log
├── sweeps/
└── index/
```

`nodes/` and `staging/` are memory and are searchable. `history/`, `sweeps/`,
`index/` and `access-log` are the extension's own bookkeeping — the vector index,
run logs, and every previous version of a memory — and are never enumerated for
search, even though they are Markdown. A history entry is a copy of a memory as
it was, so indexing one would let an outdated version answer a search as though
it were current.

### Migrating a store written before `history/`

Older stores kept the same material in five places — tombstones under
`nodes/superseded/`, recovery records, sweep preimages, archived tombstones, and
dropped candidates — and node bodies carried a `## audit` section. Run the
migration once, after upgrading:

```sh
python3 scripts/migrate-history.py            # prompts, then reports each step
python3 scripts/migrate-history.py --dry-run  # counts only, changes nothing
```

It reads the store location from the configuration, moves tombstones into
`history/deleted/` as the nodes they were before deletion, moves dropped
candidates into `history/dropped/`, strips `## audit` from `nodes/` and
`staging/`, removes the five old locations, and drops configuration options that
no longer exist. Every step prints what it did or why it was skipped. A file it
cannot convert is left exactly where it is, and the directory around it is not
removed while that file remains, so a partial failure is visible rather than
silently destructive.

Audit sections cannot be reconstructed into history, and preimages are the only
remaining copy of versions written before `history/` existed; the confirmation
prompt says both, because both are lost.

Override the root in `~/.pi/agent/pi-friend/pi-friend-memory.yml`:

```yaml
memory:
  root: ~/workspace/memory
  tool_prefix: ""
  # Markdown files and directories watched and included in memory search.
  index_paths: []
  #  - ~/Documents/notes
  #  - ~/journal
  vector:
    chunk_size: 4000
  injection:
    enabled: true
    position: -1
    mode: hybrid
    limit: 5
    max_chars: 6000
  auto_capture:
    enabled: true
    every_turns: 5
    idle_timeout: 600
    max_candidates: 3
    # model: openrouter/google/gemini-2.5-flash
    # prompt: |
    #   Replacement system prompt for capture.
    # prompt_append: |
    #   Added after the built-in capture prompt.
  sweep:
    enabled: true
    background: false
    tombstone_grace_days: 30
    min_guarded_batch_size: 10
    # model: openrouter/google/gemini-2.5-flash
    # prompt: |
    #   Replacement system prompt for sweep decisions.
    # prompt_append: |
    #   Added after the built-in sweep prompt.
  dreaming:
    enabled: true
    max_nodes: 4
    # model: openrouter/google/gemini-2.5-flash
    # prompt: |
    #   Replacement system prompt for dream selection and writing.
    # prompt_append: |
    #   Added after the built-in dream prompt.
  embeddings:
    model: openrouter/openai/text-embedding-3-small
```

A missing config uses the default. Malformed configuration is reported and
does not fall back to another path. The tree is initialized on `session_start`.

The memory extension reads `pi-friend-memory.yml` independently from the prompt
extension's `pi-friend-prompt.yml`. Existing users of the former combined file
should move the `memory` section into `pi-friend-memory.yml` and the `prompt`
section into `pi-friend-prompt.yml`.

`memory.index_paths` lists Markdown files and directory trees that should be
watched and included in search. Leading `~` is expanded, relative paths resolve
from the `pi-friend` config directory, and overlapping paths are indexed once.
The list is reconciled on session start and after filesystem changes while Pi is
running. Files deleted or removed from the list have their stale vectors
removed. Configuration list changes take effect on the next session or reload.

`sweep.allow_drop` offers the consolidation model a third action, `drop`, for
candidates that are simply wrong — a misread speaker, a misunderstanding, a
detail nobody needed. It is off by default, because the default pass only ever
adds to canonical memory. A dropped candidate is archived under
`sweeps/dropped/<runId>/<slug>.md` rather than deleted, so a bad judgement is
recoverable, and drops count against the same 25% removal guard as decay so a
single pass cannot empty staging. Leaving it off withdraws the action from the
prompt and from the response parser together; setting it while supplying a
replacement `prompt` that never mentions `drop` is reported as a warning.

`auto_capture`, `sweep`, and `dreaming` each accept two prompt options, and at
most one of them: `prompt` replaces that internal model's system prompt, while
`prompt_append` keeps the built-in prompt and adds your text after it. Supplying
both is a configuration error naming both keys, so the result never depends on
an invisible precedence rule.

Most of the built-in text is load-bearing. It holds the output contract, the
observed-data rule, the type and action vocabulary, and the speaker rules the
parser enforces by silently discarding anything that breaks them — so a
replacement prompt has to carry those itself. The complete current defaults are
copied into `pi-friend-memory.example.yml` under each section's `prompt`, which
is also where the append form is shown commented out.

Configuration problems that do not stop startup are reported once per session as
warnings rather than errors: an unknown field (`promptAddition` instead of
`prompt_append`, say, which used to be ignored in silence), or custom prompt text
that names vocabulary the code cannot honour — a sweep action other than
`promote`/`merge`, a memory type that does not exist, or generic speaker labels
without the rule to omit them.

The repository includes a complete, ready-to-copy example at
[`pi-friend-memory.example.yml`](./pi-friend-memory.example.yml). Install it manually with:

```sh
mkdir -p ~/.pi/agent/pi-friend
cp pi-friend-memory.example.yml ~/.pi/agent/pi-friend/pi-friend-memory.yml
```

Injection defaults to enabled at position `-1`, meaning the memory block is
attached to the previous user turn to preserve the current hot cache prefix.
Position `0` targets the current turn. `keyword`, `semantic`, and `hybrid`
retrieval modes are supported; semantic/hybrid failures fall back to keyword
retrieval so prompt injection does not block the model call.

The injected block is prepended to the selected user message and wrapped in
`<pi-friend-memory>...</pi-friend-memory>`. Each recalled node includes a
compact `Why recalled:` line with semantic/keyword ranks, matched fields, and
score so retrieval can be calibrated rather than taken on trust.

Retrieval and injection now happen together in the request-time `context` hook.
The result is cached per session and user-turn index, so tool-loop requests do
not repeat embedding searches, and concurrent sessions cannot overwrite one
another's pending RAG context.

With `PI_FRIEND_DEBUG_HOOKS=1`, retrieval logs `rag retrieved`, and the later
`context_with_system` hook logs either `rag delivery-confirmed` or
`rag delivery-failed`. Delivery confirmation checks that the exact RAG block is
still present in the full request context after all context hooks have run.

The `rag retrieved` entry includes the query, configured and fallback search
modes, search errors, search result count, eligible active-node count, selected
node count, and final context size. RAG restricts ranking to active nodes before
applying its result limit, so ordinary documents and non-active memory files
cannot crowd out injectable memories.

RAG searches the full latest user message. In hybrid and keyword modes, any one
meaningful keyword/token overlap with an active node is sufficient; it does not
require every word from a conversational sentence to appear in one memory.
Semantic candidates use nearest-neighbor ranking without a minimum similarity
threshold, then pass the same active-node and quarantine filters.

The query also includes the most recent visible assistant chat prose before the
current user message. Thinking blocks, tool calls, and tool results are ignored.
Staged candidates are eligible for RAG and always begin with
`Candidate - unverified`; ordinary documents remain tool-search-only.

When `PI_FRIEND_DEBUG_HOOKS` is enabled and retrieval selects no nodes, the
extension still injects an empty `<pi-friend-memory></pi-friend-memory>` block.
This makes request-context plumbing visible in traces without requiring test
memories. Debug-disabled runs inject nothing in that case.

## External Markdown and exclusions

`memory.index_paths` imports Markdown from outside the memory tree. Two rules
decide what is skipped.

The paths the extension owns inside its root are never imported, even when a
configured path contains them: `nodes/`, `staging/`, `history/`, `sweeps/`,
`index/`, and `access-log`. Without that, pointing `index_paths` at a directory
that contains the store — `~/identity`, when the store lives at
`~/identity/pi-friend-memory` — would index every memory file a second time as a
document and rescan on every memory write. The exclusion stops at those paths on
purpose: anything else kept under the same root (a `notes/` directory, a loose
`.md` file) is ordinary Markdown and stays indexable.

`index_exclude` removes more, by glob:

```yaml
memory:
  index_paths:
    - ~/journal
  index_exclude:
    - ~/journal/private
    - '**/*.draft.md'
```

`**` crosses directory separators, `*` matches within one segment, `?` matches
one character, and a pattern with no wildcard is an exact path — so naming a
directory excludes everything beneath it. Patterns resolve beside the
configuration file and accept a leading `~`, exactly like `index_paths`.

## Development

From the monorepo root, install all development dependencies:

```sh
npm install
```

Type-check the extension:

```sh
npm run typecheck
```

Run the storage tests:

```sh
npm test --workspace pi-friend-memory
```

Load the extension directly from the working tree:

```sh
pi --extension ./index.ts
```

Then run `/hello` to greet the world or `/hello Aisling` to greet someone by
name. Pi compiles TypeScript extensions itself, so no build step is required.

## Install locally

From this package directory, install the checkout as a Pi package:

```sh
pi install ./
```

Pi reads the extension entry point from the `pi.extensions` field in
`package.json`.

## Memory tools

- `memory.tool_prefix` in `pi-friend-memory.yml` is prepended to every memory tool
  name. The default is empty, so tools are named `memory_add`,
  `memory_search`, and so on. For example, `tool_prefix: pf_` exposes
  `pf_memory_add` and allows two memory extensions to load side by side.
  Configurations created from the earlier example may still contain
  `tool_prefix: memory_`; change that to `""` or remove it.
- `memory_add` creates a canonical active node, derives a unique slug unless one
  is supplied, and records speaker attribution: `speaker` names the people and
  other non-AI participants involved, while `agents` names the AI agents,
  usually including the one writing the memory. When an AI's words prompted the
  memory and no person spoke, `speaker` is empty and `agents` carries every AI
  involved.
- `memory_edit` updates an existing node while preserving creation and usage
  metadata, and stores the version it replaces under `history/edited/<slug>/`
  with the edit's reason.
- `memory_delete` copies exactly one matched node into history before removing
  it: a memory goes to `history/deleted/<slug>.md` and leaves `nodes/`, while a
  staging candidate goes to `history/dropped/<slug>.md` and leaves `staging/` —
  the same entry the sweep writes when its model rejects a candidate. The match
  may name either area, and an ambiguity is rejected with each match labelled
  memory or candidate.
- `memory_restore` copies a memory back out of history by slug, optionally
  naming a version. Without a timestamp it prefers the deletion entry, then the
  newest stored version, then a dropped candidate. A live node with the same
  slug is replaced, and its text is archived under `history/edited/` first;
  a dropped candidate goes back to `staging/` instead, and is refused if a
  memory or candidate already holds the name. Restoring a split source removes
  the children that split recorded.
- `memory_promote` promotes one staging candidate, merging semantic
  near-duplicates into an existing canonical node. Before a merge rewrites the
  target, both sides are stored under `history/merged/<slug>/`, because those
  are the only copies that will not exist afterwards.
- `memory_merge` merges one or more memories into a target in one operation. Sources
  may be canonical memories or staging candidates; the target must be canonical.
  Every source is archived under `history/merged/` before it is removed, so the
  merge is undoable with `memory_restore`. Omit `body` and the merge model writes
  the consolidated text from all sources; supply it and the text is used verbatim,
  with no rewrite and no conflict note — corrections and superseded facts are not
  conflicts, so a merge that needs one is usually the wrong merge.
- `memory_read` reads a complete node from canonical or staging storage.
- Search results and recalled blocks both carry attribution — `Heard from: Aria; Iri
  (uncertain) — relayed` — because in a plural system who said something is part of
  what the memory means, and it should not cost a second tool call.
- `memory_search` supports ranked keyword search and semantic search across
  nodes, staging candidates, and plain Markdown documents. Pass `corpus` to
  narrow it: `memory` for nodes and staging candidates, `documents` for imported
  and ordinary Markdown, `all` for both (the default). `type` filters memory
  nodes, so it cannot be combined with `corpus: documents`. When `mode` is
  omitted the tool uses `memory.search.default_mode`, which defaults to `hybrid`
  and is configured separately from retrieval's `injection.mode`. If that
  default needs embeddings and none are available, the tool searches with
  keyword and says so; an explicit `mode` that cannot run still fails.
- A speaker tag is never searchable: every query is cleaned of tags before it is
  matched or embedded, so `\>>Aria: kettle` searches for `kettle` and nothing
  else, and the name never reaches the embedding. The name is not discarded,
  though — a memory attributed to the person speaking is more relevant to the
  conversation, so each tagged name scores memories whose `speaker` contains it,
  once per name however many records carry it. The same name typed as text is
  ordinary query text: it matches prose and embeddings like any other word, and
  a memory named in a search still scores, because the memory is about them. A
  name that is both tagged and typed earns both, each once.

Supersession through `memory_add` is intentionally deferred until correction
handling can update both sides of the relationship atomically.

## Speaker tags

A name tag marks who is speaking and is not part of what was said. One
recogniser handles every caller that needs that distinction, so the search
query cleaner, the capture hint, and the `speaker` index cannot disagree about
what counts as a tag.

The default forms are `\>>Sam:`, `<Sam>`, `Sam>` and `[Sam]` at the start of a
line, and `-Sam` or `~Sam` at the end of one. A message may carry several tags —
a pasted conversation brings its own speakers with it — and every one of them is
a name that was written on purpose. Lines inside a fenced block, lines beginning
with `>` and matches inside inline code are skipped, because those are
quotations rather than the author signing. A name is one word — letters in
either case, apostrophes, hyphens — with no digits or periods, so `Note:`, `TODO:`, a Markdown link's `[text]`, a
bracketed timestamp, and a full name are not tags. One word is deliberate:
plural systems generally sign with a first name, a nickname or another
contraction, and admitting spaces lets a prefix tag swallow the start of a
message and a suffix tag reach back over a phrase.

`memory.speaker_tags.patterns` replaces the defaults. Each entry is a regular
expression whose first capture group, or a group named `name`, is the name.
An empty list, a pattern that does not compile, has no capture group, or exceeds
200 characters is a configuration error; one that matches the empty string earns
a warning. Recognition cannot be switched off by emptying the list: a silent
"no patterns" would let a name in a query pull results toward it again, which is
the bias the tags are recognised to remove.

Markup that a deployment puts in front of a person's words is a deployment's
business, not this extension's: `memory.query_prefixes.patterns` lists regular
expressions anchored at the start of a line, and each is removed from the RAG
query before matching. There is no default, because there is nothing universally
right to strip; a house running an extension that timestamps messages adds that
extension's prefix here.

A query is cleaned of every tag, not only the first. Capture goes the other way
and keeps them all: every tag a person wrote is handed to the model, with one
line saying what a tag is, so attribution is a judgement made with the names in
front of it rather than a guess at what `\>>Aria:` meant. The parser still
replaces a generic label only when exactly one name was in the window; with
several, the label is dropped instead, because choosing between them would be a
coin toss.

`pi-time-awareness` puts `[Mon 2026-11-02 16:31 EST] ` in front of
person-authored messages at the provider-payload layer, so a tag behind that
prefix is no longer at the start of the text. A caller working from `context`
messages has to remove the timestamp before asking for a tag. Capture does not:
it reads the transcript, which the extension never edits.

## Auto-capture

After every configured number of completed agent runs, a separate no-tools
model request reviews only the transcript entries added since the prior
successful capture. What it reads is the conversation: user messages, and
assistant prose — commentary before a tool call and the reply after it. Tool
calls and their output are excluded: the output is the bulk of a working
transcript and says what the agent read rather than what anyone meant, and a
fact learned from a tool reaches capture through the reply that states it.
Custom messages are included only when a person wrote them — pi-web's structured
answers, not harness notices. The
prompt treats conversation content as observed data, requires concrete speaker
attribution, and allows only active memory types.

Attribution comes from speaker tags, not from guessing. The capture window is
read for tags using the same recogniser described above, and the prompt is told
what they say: one name is stated as the speaker, several names are listed so
each candidate can be attributed to the person whose message it came from, and
no names means no line at all. A candidate whose speaker stays a generic label
(`USER`, `system`) is replaced by the sole name when exactly one person signed
the window; with several people there is no safe answer, so the label is removed
instead. A candidate may name several speakers and several agents, and repeated
names are folded into one record. An empty `speaker` list is a real outcome, not
a failure: a durable fact with no identifiable speaker is still worth keeping,
and dropping it would lose the fact while looking like nothing was found.
Phrasing is never treated as evidence: "I am so tired" used to supply the name
"so", which the parser then stamped onto every candidate in the batch.

Capture is also debounced from the last settled run using
`auto_capture.idle_timeout` seconds, default 600. A new settled run resets the
timer. Expiry triggers only while no agent run is active; shutdown cancels a
pending timer.

A session loaded with material its capture cursor has not passed arms that
debounce immediately, without waiting for a settlement — so a resume, reload or
restart captures the work even if nobody speaks in that session again. Whether
anything is pending is read from the branch and the saved cursor rather than
stored as a flag, so it cannot disagree with the transcript. A cursor that no
longer appears in the branch does not count as pending: its fallback re-reads
the most recent turns, and arming on that would stage duplicates on every
resume.

Candidates are written to `staging/` with `status: candidate` and may enter RAG
with a `Candidate - unverified` marker. Exact duplicates of canonical or staged
memories are skipped. Promotion uses the semantic index to detect
near-duplicates, merging close matches while preserving links, tags, speakers,
and audit history.

## Merging

A merge is a rewrite, not an append. When a sweep verdict or a near-duplicate
promotion merges memories, one writer call consolidates them: the decision names
the candidates, the code groups them by target, and the writer sees every source
at once — slug, title, type, speakers, the date of that account, and the body.

It returns a body and, only when the sources assert incompatible things that
nothing in them can order, a short conflict note. Corrections, changed
preferences and superseded facts are not conflicts — the newer date decides those
and the body states the current version alone. The note is kept in the archived
entry's front matter rather than surfaced: it is for whoever goes looking at how
a memory came to say what it says, and a banner would make a rare, quiet fact
into an alarm.

The code then unions tags, links, speakers and supersedes, writes the merged
node, and stores every input under `history/merged/` first. The writer
never sees the front matter it cannot mangle, and never decides what merges —
that belongs to the sweep, which is also where "a memory covers one key fact"
is enforced, because the model choosing targets should not fold unrelated
content together in the first place.

A failed or unusable response falls back to appending the bodies, with a warning
that names the target: the old behaviour cannot lose a fact, and refusing the
merge would re-offer the same candidates at every sweep.

Configure it under `memory.merge`: `model`, `thinking_level`, and `prompt` or
`prompt_append`. With no model configured it uses the session's model, the same
fallback the other internal passes use.

## Daily sweep and decay

The daily sweep runs at most once per local calendar day after an agent run
settles. It always advances `sweeps/state.json`, including failed attempts, and
appends a dated decision log under `sweeps/`. Before the history tree it also
took a full canonical snapshot under `sweeps/preimages/`; that is gone, because
every operation it was protecting now stores its own previous version.

`memory.history.keep_days` (default `30`, `0` keeps everything) bounds how long
previous versions survive. Pruning runs twice, both bounded: the sweep walks
`history/` once a day, and writing a version prunes only that slug's directory,
so an edit never pays for the size of the tree. Retention is per file, which
means a memory that lives for a year loses its oldest versions while keeping the
recent ones — "the version before the most recent edit" is really "the newest one
still on disk".



Set `memory.sweep.background: true` to schedule the sweep on the next event-loop
task instead of making agent settlement wait for its model calls. The sweep
holds an exclusive memory-mutation lock while it runs, so interactive memory
writes wait rather than racing with promotion, decay, or dream creation.
That lock is shared by every memory service using the same canonical root in
the current process, including multiple pi-web-ui conversations. Separate
processes sharing one memory tree still require a single writer or an
OS-level lock.
Session shutdown aborts an unfinished background sweep before closing the
semantic index. The default remains `false`.

The sweep model chooses `promote` or `merge` for staged candidates. Candidates
that reach the volume-decay floor of `0.05` expire before model review and are
archived under `history/dropped/`, not hard-deleted. Decay is volume-relative:
access resets a canonical node to fresh, while new canonical memories since a
node's last use lower its `decay_weight`. Candidate decay uses the same curve
and floor, counts canonical additions only, and ignores RAG-hit access resets.

A sweep that removes more than 25% of a queue at least `min_guarded_batch_size`
candidates large says so in its log line and then does it: dropping is
recoverable from `history/dropped/`, and refusing the run would discard the
promotions and merges decided alongside it.

Tombstones no longer exist: a deletion copies the node to `history/deleted/`
and the entry is what `memory_restore` reads.

## Dreaming

After a successful sweep, a separate model pass receives an
adjacency-weighted shortlist and is asked to choose what it wants to sit with
before writing one short first-person narrative.

Dreams are stored as canonical nodes with `type: dream`, explicit source-node
links, and `emotional_flavour: dreamlike`. They are permanently excluded from
default RAG and can never be promoted as factual memories by automated
processes.

## Semantic search

The `index/` directory includes a disposable `sqlite-vec` backend backed by
Node's built-in SQLite runtime. It supports transactional upsert, removal,
cosine search, clearing, and rebuild against a declared embedding model and
dimension count.

Semantic mode uses Pi's stored OpenRouter credential, falling back to
`OPENROUTER_API_KEY`. `memory.embeddings.model` defaults to
`openrouter/openai/text-embedding-3-small` at 1,536 dimensions. Markdown is
synchronized lazily on semantic search; unchanged content hashes do not make
repeat embedding calls.

Markdown longer than `memory.vector.chunk_size` is embedded as overlapping
chunks of at most that many characters. The default is 4,000 and the accepted
range is 200–20,000. Chunks prefer nearby paragraph boundaries. Search
deduplicates chunks back to one result per source document and previews the
matching chunk.

Add a Markdown corpus outside the configured memory root to
`memory.index_paths`. Directory walks include nested `.md` files and ignore
hidden paths and symlinks. The complete configured set is reconciled on startup
and after changes. Imported files retain their source path, file modification
time, first-heading title, and `imported` provenance. Deletions and paths
removed from configuration are pruned from the vector index automatically.

The Markdown tree remains canonical. Deleting `index/vectors.sqlite` is always
safe because the index can be rebuilt from source files. Hybrid mode combines
keyword and semantic candidates using reciprocal-rank fusion.

## Models for the internal passes

Capture, the sweep, dreaming and the merge writer each take an optional
`model` (`memory.auto_capture.model`, `memory.sweep.model`,
`memory.dreaming.model`, `memory.merge.model`) and an optional `thinking_level`.
Everything about "the configured model cannot be used" is handled once, so the
four passes behave the same way:

| Situation | What happens |
| --- | --- |
| No `model` configured | the session's current model is used |
| `model` lacks a `provider/` prefix | warning, session model |
| `model` is not in the registry | warning, session model |
| The model resolves but the request fails | the pass fails, visibly; the model is not swapped mid-pass |
| The provider rejects the thinking level | retried once without it, announced once per model and level |
| No session model at all | the pass reports that every time it runs |

The thinking-level retry is a fallback, not a check: the model catalogue is
maintained by hand, so it can be wrong about which levels a provider accepts,
and a provider can reject one it claims to support. Neither is worth abandoning
a pass that has already produced decisions, which is why the retry exists — but
a level that never works is a configuration mistake, so the retry is announced
once and logged every time. Banners are deduplicated per process; the file log
deduplicates identical errors separately.

Not swapping models mid-pass is deliberate: a substitution makes "why did this
merge come out differently" unanswerable, and a rate limit would double the cost
of every retry.

## Inspecting the last retrieval

`/memory-last-rag` prints what the previous user turn injected and why: the
query after tags and prefixes were removed, the mode used and any fallback, and
per result the keyword score with the points each field contributed, the
semantic similarity, both ranks, the final fused score, and whether it was
injected. It runs entirely in the extension — no model call, no cost — and PI
WEB shows its output as command output, because the handler reports through
`ctx.ui.notify`.

`memory_last_rag` returns the same report as a tool, for when a conversation
rightly includes the numbers. The command is the cheap path; the tool exists
for explaining an injection in context.

## Diagnostics and errors

Initialization failures and recoverable background failures are always appended
to the diagnostic log with their full cause chain and stack trace. This happens
even when lifecycle debug logging is disabled. Repeated identical failures are
deduplicated for one minute.

The default log file is:

```text
~/.pi/agent/pi-friend/debug.log
```

Override it with `PI_FRIEND_DEBUG_LOG=/path/to/debug.log`. Model-facing tool
results and normal runtime output are not written to this file.

Users see the message chain for initialization and background warnings without
the stack details. Full stacks, nested `cause` failures, and lower-level
sqlite-vec diagnostics remain in the log file.

## Inspect lifecycle hooks

Set `PI_FRIEND_DEBUG_HOOKS=1` when starting Pi to append each structural
lifecycle event to a debug file:

```sh
PI_FRIEND_DEBUG_HOOKS=1 pi --extension ./index.ts
```

Lifecycle debug output never writes to stdout or the TUI.

The logger includes session, agent, turn, prompt, provider, tool, input, model,
and UI boundaries. Each entry contains only the event type and selected context
fields such as session, model, cwd, usage, and prompt size. Raw event payloads,
tool output, getters, and context methods are omitted. Token-level streaming
updates are also intentionally omitted.
