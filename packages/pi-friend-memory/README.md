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
├── MEMORY.md
├── nodes/
│   └── superseded/
├── staging/
├── access-log
├── sweeps/
├── index/
└── recovery/
```

Override the root in `~/.pi/agent/pi-friend/pi-friend.yml`:

```yaml
memory:
  root: ~/workspace/memory
  tool_prefix: ""
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
    max_candidates: 3
    # model: openrouter/google/gemini-2.5-flash
  sweep:
    enabled: true
    background: false
    tombstone_grace_days: 30
    min_guarded_batch_size: 10
    # model: openrouter/google/gemini-2.5-flash
  dreaming:
    enabled: true
    max_nodes: 4
    # model: openrouter/google/gemini-2.5-flash
```

A missing config uses the default. Malformed configuration is reported and
does not fall back to another path. The tree is initialized on `session_start`.

The repository includes a complete, ready-to-copy example at
[`pi-friend.example.yml`](./pi-friend.example.yml). Install it manually with:

```sh
mkdir -p ~/.pi/agent/pi-friend
cp pi-friend.example.yml ~/.pi/agent/pi-friend/pi-friend.yml
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

When `PI_FRIEND_DEBUG_HOOKS` is enabled and retrieval selects no nodes, the
extension still injects an empty `<pi-friend-memory></pi-friend-memory>` block.
This makes request-context plumbing visible in traces without requiring test
memories. Debug-disabled runs inject nothing in that case.

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

- `memory.tool_prefix` in `pi-friend.yml` is prepended to every memory tool
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
  nodes, staging candidates, and plain Markdown documents.
- `memory_index_path` additively embeds a Markdown file or directory tree.
  Imported files retain their source path, file modification time, first-heading
  title, and `imported` provenance. Content hashes make repeat runs idempotent.

Supersession through `memory_add` is intentionally deferred until correction
handling can update both sides of the relationship atomically.

## Auto-capture

After every configured number of completed agent runs, a separate no-tools
model request reviews only the transcript entries added since the prior
successful capture. The prompt treats conversation content as observed data,
requires concrete speaker attribution, and allows only active memory types.

Candidates are written to `staging/` with `status: candidate` and are excluded
from RAG. Exact duplicates of canonical or staged memories are skipped.
Promotion uses the semantic index to detect near-duplicates, merging close
matches while preserving links, tags, speakers, and audit history.

## Daily sweep and decay

The daily sweep runs at most once per local calendar day after an agent run
settles. Before mutation it writes a full canonical preimage under
`sweeps/preimages/`. It always advances `sweeps/state.json`, including failed
attempts, and appends a dated decision log under `sweeps/`.

Set `memory.sweep.background: true` to schedule the sweep on the next event-loop
task instead of making agent settlement wait for its model calls. The sweep
holds an exclusive memory-mutation lock while it runs, so interactive memory
writes wait rather than racing with promotion, decay, or dream creation.
Session shutdown aborts an unfinished background sweep before closing the
semantic index. The default remains `false`.

The sweep model chooses `promote`, `merge`, or `drop` for staged candidates.
Dropped candidates are archived under `sweeps/dropped/`, not hard-deleted.
Decay is volume-relative: access resets a node to fresh, while new canonical
memories since its last use lower its `decay_weight`.

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

`type: inner` records inward-facing state or reflection. Inner memories are
canonical and searchable, but follow the same quarantine rules as dreams:
they are excluded from factual RAG, automated capture, dream sources, and
automated merge targets. The sweep model receives each node's type and is
instructed to preserve the boundary between inner and ordinary memory.

## Semantic search

The `index/` directory includes a disposable `sqlite-vec` backend backed by
Node's built-in SQLite runtime. It supports transactional upsert, removal,
cosine search, clearing, and rebuild against a declared embedding model and
dimension count.

Semantic mode uses Pi's stored OpenRouter credential, falling back to
`OPENROUTER_API_KEY`, and embeds with `openai/text-embedding-3-small` at 1,536
dimensions. Markdown is synchronized lazily on semantic search; unchanged
content hashes do not make repeat embedding calls.

Markdown longer than `memory.vector.chunk_size` is embedded as overlapping
chunks of at most that many characters. The default is 4,000 and the accepted
range is 200–20,000. Chunks prefer nearby paragraph boundaries. Search
deduplicates chunks back to one result per source document and previews the
matching chunk.

Use `memory_index_path` to index a Markdown corpus outside the configured
memory root. Directory walks include nested `.md` files, ignore hidden paths
and symlinks, and preserve all vector records outside the supplied path.

The Markdown tree remains canonical. Deleting `index/vectors.sqlite` is always
safe because the index can be rebuilt from source files. Hybrid mode combines
keyword and semantic candidates using reciprocal-rank fusion.

## Inspect lifecycle hooks

Set `PI_FRIEND_DEBUG_HOOKS=1` when starting Pi to append each structural
lifecycle event to a debug file:

```sh
PI_FRIEND_DEBUG_HOOKS=1 pi --extension ./index.ts
```

The default file is:

```text
~/.pi/agent/pi-friend/debug.log
```

Override it with `PI_FRIEND_DEBUG_LOG=/path/to/debug.log`. Debug output never
writes to stdout or the TUI.

The logger includes session, agent, turn, prompt, provider, tool, input, model,
and UI boundaries. It intentionally omits token-level streaming updates.
