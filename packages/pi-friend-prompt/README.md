# pi-friend-prompt

Configurable edits to Pi's generated system prompt.

The extension can replace the prompt preamble, replace or extend Pi's
`addendum`, edit other structured prompt sections, load text from files, and
rewrite section text with regular expressions. Configuration and files are
reread for every request, so changes do not require restarting Pi.

## Configuration

This package reads the shared configuration file:

```text
~/.pi/agent/pi-friend/pi-friend.yml
```

It reads only the top-level `prompt` section. The original scalar form remains
supported:

```yaml
prompt:
  custom: |
    You are Lime, an AI friend to a plural system collectively called Feathersong.
```

The `memory` section is ignored by this extension. A missing `prompt` section
leaves Pi's system prompt unchanged.

## Prompt sections

`custom` replaces the preamble. `addendum` replaces Pi's append-system-prompt
section. Other Pi sections, including `tools`, `rules`, `docs`,
`project_context`, and `skills`, can be replaced through `sections`.

Each slot accepts a string or an object containing inline `text` and an ordered
list of `files`:

```yaml
prompt:
  custom:
    text: |
      You are Lime, an AI friend.
    files:
      - persona/details.md
      - persona/local.md

  addendum:
    files:
      - addendum/global.md
      - addendum/project.md

  sections:
    project_context:
      files:
        - context/shared.md
    house_rules: |
      Follow the shared household conventions.
```

Inline text comes first, followed by files in declaration order. Components are
trimmed and joined with a blank line. Relative file paths are resolved beside
`pi-friend.yml`; absolute paths and paths beginning with `~/` are also
supported.

When the preamble is replaced, Pi would normally omit its generated `tools`,
`rules`, and `docs` sections. The extension restores those sections from the
current request options unless the configuration explicitly replaces them.

Section keys use Pi's section-name format: a lowercase letter followed by
lowercase letters, digits, underscores, or hyphens. In other words, they must
match `^[a-z][a-z0-9_-]*$`.

The configuration slots map to these replacement names:

| Configuration | Replacement target | Meaning |
| --- | --- | --- |
| `prompt.custom` | `preamble` | The main system-prompt preamble |
| `prompt.addendum` | `addendum` | Pi's append-system-prompt section |
| `prompt.sections.<name>` | `<name>` | Another generated or custom section |

Pi currently generates `tools`, `rules`, `docs`, `project_context`, `skills`,
and `cwd` sections. Those names can be used under `prompt.sections` to replace
their generated content. Other valid names create additional XML-wrapped prompt
sections, and other extensions may also contribute section names that can be
replaced.

`preamble` and `addendum` are reserved for `prompt.custom` and
`prompt.addendum`; do not put them under `prompt.sections`. Valid custom names
include `house_rules`, `work-context`, and `memory_notes`. Invalid names include
`HouseRules`, `2fa_rules`, and `house rules`.

The `section` of a replacement rule can be `preamble`, `addendum`, or any valid
section that exists in the generated prompt. A replacement cannot target an
arbitrary section name that does not exist yet; define it under
`prompt.sections` first.

## Rewriting existing text

The `replacements` list can replace, prepend to, or append to existing prompt
text. Replacement text can be inline or loaded from a file:

```yaml
prompt:
  replacements:
    # Prepend once to the complete addendum.
    - section: addendum
      action: prepend
      replacement: |
        Configured context:

    # Append once to the complete addendum.
    - section: addendum
      action: append
      replacement_file: addendum/extra.md

    # Prepend the heading before the first match.
    - section: preamble
      action: prepend
      pattern: '^'
      replacement: '# Friend context'

    # Append to every matching rule line.
    - section: rules
      action: append
      pattern: '^- Be concise.*$'
      flags: gm
      replacement: ' Prefer concrete answers.'

    # Replace every matching addendum heading.
    - section: addendum
      pattern: '^## Temporary$'
      flags: gm
      replacement: '## Current context'
```

Without `pattern`, the action applies once to the whole section:

- `replace` replaces the complete section. This is the default.
- `prepend` places the new text before the complete section.
- `append` places the new text after the complete section.

With `pattern`, the action applies to regular-expression matches:

- `replace` substitutes every match, subject to the regex flags.
- `prepend` places the new text before each match.
- `append` places the new text after each match.

Regex flags default to `g`. An explicit `flags` value replaces that default, so
omit `g` to edit only the first match. Patterns and flags use JavaScript regular
expression syntax. Replacement text uses JavaScript substitution syntax, such
as `$1` for capture groups and `$&` for the matched text. Whole-section actions
use the replacement text literally.

Rules are applied in configuration order, and later rules see the result of
earlier rules. Replacements target unwrapped section contents rather than the
generated `<section>...</section>` tags. A replacement fails if its target
section does not exist.

## Failure handling

The configuration and all referenced prompt files are loaded on every request.
If parsing, file loading, regex rewriting, or prompt construction fails, the
extension leaves that request's original prompt unchanged and reports a warning.
It tries again on every later request, including after the problem is fixed.

This means missing files, malformed YAML, invalid regexes, and misspelled
section names are visible every time they affect a request instead of only once
per Pi process.

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
