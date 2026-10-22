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
