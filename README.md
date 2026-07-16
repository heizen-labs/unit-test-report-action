# Unit Test Report Action

[![CI](https://github.com/heizen-labs/unit-test-report-action/actions/workflows/ci.yml/badge.svg)](https://github.com/heizen-labs/unit-test-report-action/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

A composite GitHub Action that runs unit tests for one or more apps in a repo, then POSTs a combined **coverage + pass/fail** report to Heizen Studio.

The report is sent to `{base-url}/unit-testcases/report` with the API key in a configurable header (`x-api-key` by default).

## Contents

- [Why](#why)
- [Quick start](#quick-start)
- [Inputs](#inputs)
- [The `apps` input](#the-apps-input)
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
| `default-test-command` | | `pnpm vitest run --coverage --coverage.reporter=json-summary --reporter=json --outputFile=test-results.json` | Test command run in each app's directory when the app does not set its own `testCommand`. |
| `header-name` | | `x-api-key` | HTTP header used to send the API key. |

## The `apps` input

A JSON array. Each entry:

```jsonc
{
  "name": "server",                 // required — label used in the report
  "directory": "apps/server",       // required — the test command runs here
  "testCommand": "pnpm vitest ...", // optional — falls back to default-test-command
  "resultsFile": "test-results.json",              // optional — relative to directory
  "coverageFile": "coverage/coverage-summary.json" // optional — relative to directory
}
```

The test command **must** emit:

- a Vitest JSON report at `resultsFile` (`--reporter=json --outputFile=...`), and
- a `json-summary` coverage report at `coverageFile` (`--coverage.reporter=json-summary`).

The default command already produces both. For non-Vitest runners, provide a `testCommand` that emits equivalently shaped files.

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

- **Failures are still reported.** Tests run even if a suite fails; the report is posted so failures show up in Studio.
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

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `Missing 'api-key' input` | The `api-key` input is empty — check the secret is set on the repo. |
| `No test results found for any app` | The test command didn't write `resultsFile`/`coverageFile`. Confirm the command emits JSON + `json-summary`, and that paths are relative to `directory`. |
| `Report POST failed: 401` | The API key value is wrong for this Studio endpoint, or `header-name` doesn't match what the server expects. |
| `fetch failed` | The `base-url` is unreachable from the runner (server down, wrong host, or network egress blocked). |
| `'apps' input is not valid JSON` | Fix the JSON in the `apps` input — use a block scalar (`apps: \|`) for multi-line JSON. |

## Development

```bash
npm run check   # node --check on the script
npm test        # network-free functional tests
```

The tests ([`test/smoke.mjs`](./test/smoke.mjs)) import the script's pure functions and assert against a fixture app ([`test/fixtures/app`](./test/fixtures/app)) — input parsing and defaults, coverage merging, payload construction, and the missing-results path. No network or external services required. CI runs both on every push and PR.

## Releasing

Consumers pin a moving major tag (`@v1`). After merging to `main`:

```bash
git tag -f v1
git push -f origin v1
```

For immutable references, also cut a full version tag (`v1.0.0`) and update [`CHANGELOG.md`](./CHANGELOG.md).

## License

[MIT](./LICENSE)
