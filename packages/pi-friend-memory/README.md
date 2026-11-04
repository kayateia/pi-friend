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
│   └── superseded/
├── staging/
├── access-log
├── sweeps/
├── index/
└── recovery/
```

`nodes/` and `staging/` are memory and are searchable. `sweeps/`, `index/`,
`recovery/` and `access-log` are the extension's own bookkeeping — run logs,
preimages, dropped and archived candidates, the vector index, recovery records —
and are never enumerated for search, even though they are Markdown. A preimage is
a full copy of the store from before a change, so indexing it would let an
outdated version of a memory answer a search as though it were current.

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
configured path contains them: `nodes/`, `staging/`, `sweeps/`, `recovery/`,
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
  is supplied, and records speaker attribution.
- `memory_edit` updates an existing node while preserving creation and usage
  metadata and appending a dated audit entry.
- `memory_delete` moves exactly one matched node into superseded storage after
  writing a durable recovery record.
- `memory_restore` restores a deleted node from its recovery ID without
  overwriting newer canonical content.
- `memory_promote` promotes one staging candidate, merging semantic
  near-duplicates into an existing canonical node.
- `memory_read` reads a complete node from canonical, staging, or superseded
  storage.
- `memory_search` supports ranked keyword search and semantic search across
  nodes, staging candidates, and plain Markdown documents. Pass `corpus` to
  narrow it: `memory` for nodes and staging candidates, `documents` for imported
  and ordinary Markdown, `all` for both (the default). `type` filters memory
  nodes, so it cannot be combined with `corpus: documents`.

Supersession through `memory_add` is intentionally deferred until correction
handling can update both sides of the relationship atomically.

## Auto-capture

After every configured number of completed agent runs, a separate no-tools
model request reviews only the transcript entries added since the prior
successful capture. The prompt treats conversation content as observed data,
requires concrete speaker attribution, and allows only active memory types.

Capture is also debounced from the last settled run using
`auto_capture.idle_timeout` seconds, default 600. A new settled run resets the
timer. Expiry triggers only while no agent run is active; shutdown cancels a
pending timer.

Candidates are written to `staging/` with `status: candidate` and may enter RAG
with a `Candidate - unverified` marker. Exact duplicates of canonical or staged
memories are skipped. Promotion uses the semantic index to detect
near-duplicates, merging close matches while preserving links, tags, speakers,
and audit history.

## Daily sweep and decay

The daily sweep runs at most once per local calendar day after an agent run
settles. Before mutation it writes a full canonical preimage under
`sweeps/preimages/`. It always advances `sweeps/state.json`, including failed
attempts, and appends a dated decision log under `sweeps/`.

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
archived under `sweeps/dropped/`, not hard-deleted. Decay is volume-relative:
access resets a canonical node to fresh, while new canonical memories since a
node's last use lower its `decay_weight`. Candidate decay uses the same curve
and floor, counts canonical additions only, and ignores RAG-hit access resets.

The 25% removal guard applies only when a sweep has at least
`min_guarded_batch_size` candidates. Smaller batches can remove or consolidate
above that ratio without deadlocking on a tiny working set.

Superseded tombstones older than `tombstone_grace_days` are archived under
`sweeps/archived/<run-id>/`. They remain searchable and are not irreversibly
deleted.

## Dreaming

After a successful sweep, a separate model pass receives an
adjacency-weighted shortlist and is asked to choose what it wants to sit with
before writing one short first-person narrative.

Dreams are stored as canonical nodes with `type: dream`, explicit source-node
links, and `emotional_flavor: dreamlike`. They are permanently excluded from
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
