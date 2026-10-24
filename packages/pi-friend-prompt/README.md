# pi-friend-prompt

Configurable edits to Pi's generated system prompt.

The first pass replaces only the custom prompt preamble while preserving Pi's
generated `tools`, `rules`, and `docs` sections.

## Configuration

This package reads the shared configuration file:

```text
~/.pi/agent/pi-friend/pi-friend.yml
```

It reads only the top-level `prompt` section:

```yaml
prompt:
  custom: |
    You are Lime, an AI friend to a plural system collectively called Feathersong.
    ...
```

The `memory` section is ignored by this extension. A missing `prompt` section
or empty `prompt.custom` leaves Pi's system prompt unchanged.

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
normal preamble replacement is preserved directly.

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
