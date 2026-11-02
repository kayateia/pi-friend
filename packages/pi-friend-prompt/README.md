# pi-friend-prompt

Configurable edits to Pi's generated system prompt.

The extension applies an ordered list of changes to prompt sections. A change
can replace, prepend, or append text, optionally using a regular expression,
and can load its source text from files. Configuration and files are reread for
every request, so changes do not require restarting Pi.

## Configuration

This package reads its dedicated configuration file:

```text
~/.pi/agent/pi-friend/pi-friend-prompt.yml
```

The prompt extension no longer reads the `prompt` section from
`pi-friend.yml`. The dedicated file contains the top-level `prompt` list:

```yaml
prompt:
  - section: preamble
    action: replace
    text: |
      You are Lime, an AI friend.

  - section: addendum
    action: prepend
    text: |
      Prefer direct, warm, concrete language.
```

A missing `prompt` key or an empty list leaves Pi's system prompt unchanged.

## Change fields

Every list entry describes one change:

| Field | Required | Meaning |
| --- | --- | --- |
| `section` | Yes | Prompt section to edit |
| `action` | Yes | `replace`, `prepend`, or `append` |
| `text` | At least one of `text`/`files` | Inline source text |
| `files` | At least one of `text`/`files` | Ordered prompt source files |
| `pattern` | No | Regular expression selecting part of the section |
| `flags` | With `pattern` | JavaScript regular-expression flags |

`text` and `files` may be used together. Inline text comes first, followed by
files in declaration order. Components are joined with a blank line. Relative
paths resolve beside `pi-friend-prompt.yml`; absolute paths and paths beginning
with `~/` are also supported.

An explicit action is required. A change with neither meaningful text nor a
file is rejected.

## Section names

All changes use the same `section` field. The available names are:

- `preamble`, Pi's main system-prompt preamble.
- `addendum`, Pi's append-system-prompt section.
- Pi's generated `tools`, `rules`, `docs`, `project_context`, `skills`, and
  `cwd` sections.
- Additional sections contributed by other extensions.
- New custom sections.

Named sections must match `^[a-z][a-z0-9_-]*$`. Valid examples include
`house_rules`, `work-context`, and `memory_notes`. Invalid examples include
`HouseRules`, `2fa_rules`, and `house rules`.

A whole-section `replace` can create a custom section:

```yaml
prompt:
  - section: house_rules
    action: replace
    text: |
      - Be kind.
```

`preamble` and `addendum` are always available as logical targets, even when Pi
did not previously render an addendum. A named section must exist before a
whole-section prepend or append, or before a pattern-based operation can edit
it. Creating it with `replace` first makes it available to later changes.

## Ordered changes

The list is an ordered pipeline. A section may appear more than once, and every
change sees the output of all preceding changes:

```yaml
prompt:
  - section: house_rules
    action: replace
    text: |
      - Be kind.

  - section: house_rules
    action: append
    text: |
      - Ask before assuming.

  - section: house_rules
    action: append
    pattern: '^- Ask.*$'
    flags: gm
    text: ' Include the reason when useful.'
```

The first change creates the section, the second appends a new prose block, and
the third edits the result of both.

## Actions

Without `pattern`, an action applies once to the complete section:

- `replace` replaces the section contents. It creates a missing custom section.
- `prepend` inserts the source text before the section, separated by a blank
  line.
- `append` inserts the source text after the section, separated by a blank
  line.

With `pattern`, an action applies to regular-expression matches:

- `replace` substitutes every match, subject to the regex flags.
- `prepend` inserts the source text before each match.
- `append` inserts the source text after each match.

```yaml
prompt:
  - section: addendum
    action: append
    files:
      - addendum/extra.md

  - section: rules
    action: replace
    pattern: '^- Be concise.*$'
    flags: gm
    text: |
      - Prefer concise, concrete answers.

  - section: project_context
    action: prepend
    pattern: '^## '
    flags: gm
    text: 'Project note: '
```

Replacement text from `text` and files uses JavaScript substitution syntax when
a pattern is present, including `$1` for capture groups and `$&` for the
matched text. Whole-section actions use the source text literally.

`flags` is valid only with `pattern` and defaults to `g`. An explicit value
replaces that default, so omit `g` to edit only the first match.

Pattern-based operations target unwrapped section contents rather than the
generated `<section>...</section>` tags.

## Migration from the previous format

The previous specialized `custom`, `addendum`, `sections`, and `replacements`
keys are no longer accepted. Convert them to ordered changes:

| Previous configuration | New change |
| --- | --- |
| `prompt.custom` | `section: preamble`, `action: replace` |
| `prompt.addendum` | `section: addendum`, `action: replace` |
| `prompt.sections.house_rules` | `section: house_rules`, `action: replace` |
| `prompt.replacements[]` | Keep the action and pattern; use `text`/`files` |

For example:

```yaml
# Previous form
prompt:
  custom: |
    You are Lime.
  addendum:
    files: [addendum.md]
  sections:
    house_rules: Be kind.
```

becomes:

```yaml
prompt:
  - section: preamble
    action: replace
    text: |
      You are Lime.

  - section: addendum
    action: replace
    files: [addendum.md]

  - section: house_rules
    action: replace
    text: Be kind.
```

Previous `replacement` fields map to `text`, and `replacement_file` maps to a
one-item `files` list. Multiple files are now supported for every change.

Move the resulting `prompt` list from `pi-friend.yml` into the new
`pi-friend-prompt.yml` file. The memory extension continues to use
`pi-friend.yml`.

## Failure handling

The configuration and all referenced prompt files are loaded on every request.
If parsing, file loading, regex rewriting, or prompt construction fails, the
extension leaves that request's original prompt unchanged and reports a warning.
It tries again on every later request, including after the problem is fixed.

Because changes are applied atomically, failure in a later change also rolls
back earlier changes from that request.

## Host compatibility

Some hosts, including `pi-web-ui` with its prompt composer active, run a later
`before_agent_start` handler that replaces the complete system prompt. Pi still
awaits every handler, but the later replacement can discard this extension's
mutation.

To diagnose that case, `pi-friend-prompt` also checks the final system prompt in
`context_with_system` and records whether the configured narrative survived.
It does not inject a fallback message.

To let `pi-web-ui` leave the system prompt to Pi and extensions instead, use its
default prompt composition:

- Restore the default system-prompt template and clear all source overrides.
- Use the standard/full-capability agent preset.
- Enable all agent tools.
- Disable `Tool Lazy Loading`.

When those are default, `pi-web-ui` returns no replacement prompt and the
extension's prompt edits are preserved directly.

## Diagnostics

Set `PI_FRIEND_DEBUG_HOOKS=1` when starting Pi. Each run appends a
`web-ui prompt diagnostics` entry to the normal pi-friend debug log. The entry
contains:

- Whether `forceSystemPrompt` was set by a later handler.
- Whether that forced prompt included the configured narrative.
- Whether the narrative remains in the final request prompt.
- `overriddenByLaterHandler` when the final prompt lost the narrative.
- `likelyWebUiOverride` when the final prompt lost the narrative and one of the
  web UI prompt-composer settings below is active.
- The persisted `pi-web-ui` settings: prompt template activity, prompt override
  sources, default agent preset, disabled tool count, lazy tool loading, and
  whether their combination causes web UI to replace the system prompt.

The diagnostic reads `client-state.json` from `PI_WEB_DATA_DIR`, defaulting to
`~/.pi-web`. A missing file is reported as `available: false`.

## Development

From the monorepo root:

```sh
npm install
npm run typecheck --workspace pi-friend-prompt
npm test --workspace pi-friend-prompt
```

Load directly:

```sh
pi --extension ./packages/pi-friend-prompt/index.ts
```

Install from the package directory:

```sh
pi install ./packages/pi-friend-prompt
```
