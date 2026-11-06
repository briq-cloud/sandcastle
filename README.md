# @briq-cloud/sandcastle

[![npm](https://img.shields.io/npm/v/@briq-cloud/sandcastle)](https://www.npmjs.com/package/@briq-cloud/sandcastle) [![ci](https://github.com/briq-cloud/sandcastle/actions/workflows/ci.yml/badge.svg)](https://github.com/briq-cloud/sandcastle/actions/workflows/ci.yml)

A [Sandcastle](https://github.com/mattpocock/sandcastle) sandbox provider for [briq](https://briq.cloud). Each agent run gets its own briq, a microVM.

```ts
import { claudeCode, run } from "@ai-hero/sandcastle";
import { briq } from "@briq-cloud/sandcastle";

await run({
  agent: claudeCode("claude-opus-4-8"),
  sandbox: briq({ env: { IS_SANDBOX: "1" } }),
  promptFile: ".sandcastle/prompt.md",
  hooks: {
    sandbox: {
      onSandboxReady: [
        { command: "npm install -g @anthropic-ai/claude-code", timeoutMs: 300_000 },
      ],
    },
  },
});
```

```bash
npm install @briq-cloud/sandcastle @ai-hero/sandcastle
export BRIQ_API_KEY=...   # from the briq dashboard
```

Do not put `BRIQ_API_KEY` in `.sandcastle/.env`: Sandcastle forwards those keys into the sandbox.

## What happens

1. `create` starts a briq in the `sandcastle` stack and makes `/workspace/repo`.
2. Sandcastle copies the repo in as a git bundle and clones it there.
3. Each command runs in the briq and its output streams back line by line.
4. Sandcastle copies the agent's commits out.
5. `close` destroys the briq.

## Options

| Option | Default | |
| --- | --- | --- |
| `apiKey` | `BRIQ_API_KEY` | A briq API key. |
| `baseUrl` | `BRIQ_API_URL`, else `https://api.briq.cloud` | The API's origin. |
| `image` | briq's sandbox image | An image with `sh`, `python3`, `git`, `tar` and your agent's CLI. |
| `size` | `small` | `small`, `medium`, `large` or `xlarge`. Any other value fails as `unsupported`. |
| `env` | none | Variables for every command, merged with the ones Sandcastle passes. |
| `stack` | `sandcastle` | The briq stack that holds the sandboxes. |
| `labels` | none | Labels set on each sandbox. |
| `commandTimeoutMs` | `3600000` | The longest one command may run, at most one hour. |
| `maxOutputTailChars` | `65536` | Characters of each stream kept in the result of a streaming command. |

`sandboxId` is the briq's id: `briq status <id>` and the dashboard take it.

## Supported

- `run()` and `createSandbox()`, with the `branch` and `merge-to-head` strategies.
- Streaming output, so Sandcastle's idle timeout works.
- `stdin` for a command, up to 512 KB.
- Files and directories in, single files out.

## Not supported

- `interactive()`: use `run()` or `createSandbox()`.
- A network policy: the sandbox always has open egress.
- `sudo: true` has no effect: commands already run as `root`.
- Files over the API's per-file limit (`maxFileBytes` in `briq quota --json`, 1 MB or more): a larger repo bundle fails at the copy in.
- A command that runs longer than one hour.

## Notes

- The sandbox image has `git`, Node.js and `python3`. It has no agent CLI: install one in an `onSandboxReady` hook, as above, or set `image`.
- Commands run as `root`. Claude Code refuses to skip its permission checks as `root` unless `IS_SANDBOX=1` is set, as in the example.
- The environment Sandcastle passes (the agent's login, for example) goes with each command. It is not stored on the briq.
- A briq that a crash left behind is in the `sandcastle` stack: `briq list --stack sandcastle` lists it and `briq destroy <id>` destroys it.

## Develop

```bash
pnpm install
pnpm lint && pnpm typecheck && pnpm test && pnpm build
```

Tests mock the briq API. MIT license. Issues and pull requests: <https://github.com/briq-cloud/sandcastle>.
