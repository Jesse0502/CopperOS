# Contributing

Thanks for taking a look at CopperOS. This is an early beta — expect rough edges,
and see the [Known limits](README.md#known-limits) section before assuming
something is a bug.

## Setup

Follow the [Setup](README.md#setup) section in the README to get the broker
and extension running locally. `broker/src/stub-extension.ts` lets you
exercise the agent loop without a real Chrome tab — see
[Testing without Chrome](README.md#testing-without-chrome).

## Before opening a PR

```bash
cd broker
npm install
npm run typecheck
```

CI runs the same typecheck on every PR. There is currently no automated test
suite beyond the stub-extension harness, so for behavioral changes, describe
in the PR what you exercised manually (which stub flags, which real sites).

## Filing issues

Include the broker's console output around the failure, your `OLLAMA_MODEL`
(or OpenAI model), and whether the tool call that failed was resolved with an
accessibility snapshot or an escalated screenshot — that split matters a lot
for reproducing perception bugs.

## Scope

Changes that add proxy rotation, CAPTCHA handling, or multi-tab concurrency
are out of scope for now — see [Scope](README.md#scope) in the README for why.
