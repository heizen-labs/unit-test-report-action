# Unit Test Report Action

[![CI](https://github.com/heizen-labs/unit-test-report-action/actions/workflows/ci.yml/badge.svg)](https://github.com/heizen-labs/unit-test-report-action/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A composite GitHub Action that runs unit tests for one or more apps in a repo, then POSTs a combined **coverage + pass/fail** report to Heizen Studio.

Works with **Vitest** and **Jest** — the runner is detected per app, and both produce the exact same report payload.

The report is sent to `{base-url}/unit-testcases/report` with the API key in a configurable header (`x-api-key` by default).

## Contents

- [Why](#why)
- [Quick start](#quick-start)
- [Inputs](#inputs)
- [The `apps` input](#the-apps-input)
  - [Framework support](#framework-support)
  - [Using your own test script](#using-your-own-test-script)
  - [Bring your own command](#bring-your-own-command)
- [Prerequisites](#prerequisites)
- [Report payload](#report-payload)
- [Behavior](#behavior)
- [Advanced usage](#advanced-usage)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Releasing](#releasing)
- [License](#license)

## Why

Instead of copying a reporting script into every project, each repo references this action and passes a small config. One place to maintain the collect-and-post logic; every project stays clean.

## Quick start

```yaml
name: Unit Test Report

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  test-report:
    runs-on: self-hosted
    steps:
      - uses: actions/checkout@v7.0.0

      - uses: pnpm/action-setup@v5
        with:
          version: 11.5.0

      - uses: actions/setup-node@v6.4.0
        with:
          node-version: "24"
          cache: "pnpm"

      - run: pnpm install
      - run: pnpm db:generate
      - run: pnpm package

      - name: Run tests and post report
        uses: heizen-labs/unit-test-report-action@v1
        with:
          api-key: ${{ secrets.HEIZEN_STUDIO_API_KEY }}
          apps: |
            [
              { "name": "server", "directory": "apps/server" },
              { "name": "web", "directory": "apps/web" }
            ]
```

A ready-to-copy version lives in [`examples/consumer-workflow.yml`](./examples/consumer-workflow.yml).

## Inputs

| Input | Required | Default | Description |
|---|---|---|---|
| `api-key` | ✅ | — | Studio API key, sent as the auth header. |
| `apps` | ✅ | — | JSON array of apps to test. See [below](#the-apps-input). |
| `base-url` | | `https://api.studio.heizen.work` | Report service base URL. The report is POSTed to `{base-url}/unit-testcases/report`. |
| `test-script` | | — | Name of **your own** package script to run in each app (e.g. `test:unit`). The action appends the reporter + coverage flags. See [using your own script](#using-your-own-test-script). |
| `framework` | | `auto` | `vitest`, `jest`, or `auto` to detect per app. |
| `package-manager` | | `pnpm` | `pnpm`, `npm`, `yarn`, or `bun`. Used to run scripts and binaries. |
| `default-test-command` | | — | Full command run verbatim in each app's directory. Only needed when neither the framework defaults nor `test-script` fit. |
| `fail-on-test-failure` | | `true` | Fail the step when tests fail. The report is posted first either way. |
| `header-name` | | `x-api-key` | HTTP header used to send the API key. |

## The `apps` input

A JSON array. Each entry:

```jsonc
{
  "name": "server",                 // required — label used in the report
  "directory": "apps/server",       // required — the test command runs here
  "framework": "jest",              // optional — "vitest" | "jest"; defaults to the framework input
  "testScript": "test:unit",        // optional — your own package script; flags are appended
  "testCommand": "pnpm vitest ...", // optional — full command, run verbatim
  "resultsFile": "test-results.json",              // optional — relative to directory
  "coverageFile": "coverage/coverage-summary.json" // optional — relative to directory
}
```

Nothing beyond `name` and `directory` is required. By default the action detects the runner and builds the command itself.

### Framework support

Vitest and Jest both emit a Jest-shaped JSON report and an Istanbul `json-summary`, so **the report payload is identical either way** — only the flags differ:

| Framework | Command the action builds (pnpm) |
|---|---|
| `vitest` | `pnpm exec vitest --run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=coverage --reporter=json --outputFile=test-results.json` |
| `jest` | `pnpm exec jest --coverage --coverageReporters=json-summary --coverageDirectory=coverage --json --outputFile=test-results.json` |

With `framework: auto` (the default) each app is detected independently, so a monorepo can mix runners. Detection order:

1. the framework named in the script being run (when `testScript` is set),
2. a `vitest` / `jest` dependency in the app's `package.json`,
3. the framework named in the app's `test` script,
4. a `vitest.config.*` / `jest.config.*` file,
5. falling back to `vitest`.

### Using your own test script

If you already run tests through a script like `pnpm test:unit`, point the action at it instead of restating the command. The action runs it through your package manager and **appends** the reporter and coverage flags, so the script itself doesn't need to know anything about reporting:

```yaml
      - name: Run tests
        if: github.event_name == 'pull_request'
        run: pnpm test:unit

      - name: Run tests and post report
        if: github.event_name == 'push' && github.ref == 'refs/heads/main'
        uses: heizen-labs/unit-test-report-action@v1
        with:
          api-key: ${{ secrets.HEIZEN_STUDIO_API_KEY }}
          test-script: test:unit          # same script your PR job runs
          apps: |
            [
              { "name": "server", "directory": "apps/server" },
              { "name": "web", "directory": "apps/web" }
            ]
```

`test-script` accepts a bare script name (`test:unit`) or a written-out invocation (`pnpm test:unit`, `npm run test:unit`) — all three mean the same thing. Set it per app with `"testScript"` when apps use different script names.

Because the flags are appended, your script must **not** hard-code a conflicting reporter, and must be able to accept extra arguments (a plain `"test:unit": "vitest"` or `"test:unit": "jest"` is ideal).

### Bring your own command

`testCommand` (per app) and `default-test-command` (action-wide) are run **verbatim** — nothing is appended. Use them for runners the action doesn't know about; the command must emit:

- a Jest/Vitest-shaped JSON report at `resultsFile`, and
- an Istanbul `json-summary` coverage report at `coverageFile`.

Command precedence per app: `testCommand` → `testScript` → `default-test-command` → `test-script` → the framework default.

## Prerequisites

This action does **not** install dependencies or build packages. Do that in your workflow **before** calling it — checkout, package-manager setup, install, and any codegen/build your tests need. The action only runs the test commands, collects the outputs, and posts.

## Report payload

```jsonc
{
  "generatedAt": "2026-07-16T09:27:37.672Z",
  "source": {
    "repository": "heizen/master-template",
    "branch": "main",
    "commit": "…",
    "trigger": "push",
    "actor": "…",
    "runId": "…"
  },
  "summary": {
    "success": true,
    "tests": {
      "total": 50, "passed": 50, "failed": 0, "skipped": 0, "todo": 0,
      "suites": { "total": 24, "passed": 24, "failed": 0 }
    },
    "coverage": {
      "lines":      { "total": 372, "covered": 117, "pct": 31.45 },
      "statements": { "total": 387, "covered": 123, "pct": 31.78 },
      "functions":  { "total": 108, "covered": 30,  "pct": 27.78 },
      "branches":   { "total": 262, "covered": 74,  "pct": 28.24 }
    }
  },
  "apps": {
    "server": { "tests": { … }, "coverage": { … } },
    "web":    { "tests": { … }, "coverage": { … } }
  }
}
```

Combined `summary` numbers are aggregated across all apps; per-app detail is under `apps`. Coverage percentages are recomputed from summed `covered` / `total`.

## Behavior

- **Failures are reported *and* fail the step.** The report is always POSTed first, so failures reach Studio; the step then exits non-zero so the PR goes red. The step fails when any test fails, any suite fails, **no tests are collected at all**, or a runner exits non-zero without writing a failing report. Set `fail-on-test-failure: false` to post without failing.

  Because the report is posted before the step fails, this replaces a separate test step — you don't need to run your suite twice to both gate the PR and report it:

  ```yaml
        - name: Run unit tests and post report
          uses: heizen-labs/unit-test-report-action@v1
          with:
            api-key: ${{ secrets.HEIZEN_STUDIO_API_KEY }}
            test-script: test:unit
            apps: |
              [{ "name": "server", "directory": "apps/server" }]
  ```
- **No silent empty reports.** If **no** app produces results, the action fails instead of posting an empty (green-looking) report. If only some apps produce results, it warns and posts a partial report.
- **`generatedAt`** is stamped at report time, so it is always present for both `push` and manual `workflow_dispatch` runs.
- **Source metadata** is read from the standard `GITHUB_*` environment variables provided by the runner.

## Advanced usage

Override the base URL and auth header (e.g. a staging Studio that expects a bearer token):

```yaml
      - uses: heizen-labs/unit-test-report-action@v1
        with:
          api-key: ${{ secrets.HEIZEN_STUDIO_API_KEY }}
          base-url: https://staging.studio.heizen.work
          header-name: authorization
          apps: |
            [{ "name": "api", "directory": ".", "testCommand": "npm test -- --coverage" }]
```

Per-app custom commands and file locations:

```yaml
          apps: |
            [
              {
                "name": "server",
                "directory": "apps/server",
                "testCommand": "pnpm vitest run --coverage --coverage.reporter=json-summary --reporter=json --outputFile=out/results.json",
                "resultsFile": "out/results.json",
                "coverageFile": "coverage/coverage-summary.json"
              }
            ]
```

A monorepo mixing runners, each app with its own script — the framework is detected per app:

```yaml
          apps: |
            [
              { "name": "server", "directory": "apps/server", "testScript": "test:unit" },
              { "name": "web", "directory": "apps/web", "framework": "jest", "testScript": "test:ci" },
              { "name": "worker", "directory": "apps/worker" }
            ]
```

When the action builds the command, `resultsFile` and `coverageFile` are wired into it automatically, so custom output paths need no extra flags:

```yaml
          apps: |
            [
              {
                "name": "server",
                "directory": "apps/server",
                "resultsFile": "out/results.json",
                "coverageFile": "out/cov/coverage-summary.json"
              }
            ]
```

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Missing 'api-key' input` | The `api-key` input is empty — check the secret is set on the repo. |
| `No test results found for any app` | The test command didn't write `resultsFile`/`coverageFile`. Check the command echoed in the run's log group. If you passed `testCommand`, confirm it emits JSON + `json-summary`; paths are relative to `directory`. |
| Tests ran but no report files appeared, with `test-script` | Your script likely doesn't forward extra arguments, or hard-codes a conflicting reporter. Run the echoed command locally to see what the runner received. |
| `Unsupported framework 'x'` | `framework` (or an app's `"framework"`) must be `vitest`, `jest`, or `auto`. |
| Wrong runner detected | Set `framework`, or `"framework"` on the specific app, to pin it. |
| `Report POST failed: 401` | The API key value is wrong for this Studio endpoint, or `header-name` doesn't match what the server expects. |
| `fetch failed` | The `base-url` is unreachable from the runner (server down, wrong host, or network egress blocked). |
| `'apps' input is not valid JSON` | Fix the JSON in the `apps` input — use a block scalar (`apps: \|`) for multi-line JSON. |

## Development

```bash
npm run check   # node --check on the script
npm test        # network-free functional tests
```

The tests ([`test/smoke.mjs`](./test/smoke.mjs)) import the script's pure functions and assert against Vitest and Jest fixture apps ([`test/fixtures/`](./test/fixtures/)) — input parsing and defaults, framework detection, command building, coverage merging, payload construction, and the missing-results path. No network or external services required. CI runs both on every push and PR.

## Releasing

Consumers pin a moving major tag (`@v1`). After merging to `main`:

```bash
git tag -f v1
git push -f origin v1
```

For immutable references, also cut a full version tag (`v1.0.0`) and update [`CHANGELOG.md`](./CHANGELOG.md).

## License

[MIT](./LICENSE)
