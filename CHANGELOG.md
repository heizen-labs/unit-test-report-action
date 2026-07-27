# Changelog

All notable changes to this action are documented here.

## [Unreleased]

### Fixed

- `summary.success` reported `true` for a run where every suite failed to load.
  It only counted failed *tests*, and a suite that cannot load runs zero tests.
  A run now succeeds only if tests actually ran and nothing failed at either
  the test or suite level.
- Istanbul writes the string `"Unknown"` for `pct` when nothing was
  instrumented; it leaked into the payload's numeric fields. All coverage
  numbers are now coerced, with non-numeric values becoming `0`.
- A runner that fails to start, or an app that collects zero tests, now emits a
  `::warning::` / `::error::` annotation instead of a line buried in a
  collapsed log group.

### Added

- `fail-on-test-failure` input, default `true`: the step exits non-zero when
  tests fail, no tests are collected, or a runner exits non-zero without
  writing a failing report. **The report is always POSTed first**, so failures
  still reach Studio. Set to `false` for the previous report-only behavior.

- Jest support. Vitest and Jest both emit a Jest-shaped JSON report and an
  Istanbul `json-summary`, so the report payload is unchanged either way.
- `framework` input (`vitest` | `jest` | `auto`) and a per-app `"framework"`.
  With `auto` (the default) the runner is detected per app from its
  `package.json` dependencies, test script, or config file — so a monorepo can
  mix runners — falling back to Vitest.
- `test-script` input and a per-app `"testScript"` for pointing the action at
  your own package script (e.g. `test:unit`). The action appends the reporter
  and coverage flags, so the script needs no reporting flags of its own.
  Accepts `test:unit`, `pnpm test:unit`, or `npm run test:unit`.
- `package-manager` input (`pnpm` | `npm` | `yarn` | `bun`), used to run
  scripts and binaries. The `--` argument separator is applied only for npm,
  since pnpm, yarn and bun pass a literal `--` through to the runner, which
  would silently discard every appended flag.
- Generated commands now derive `--outputFile` and the coverage directory from
  the app's `resultsFile` and `coverageFile`, so custom output paths work
  without a custom command.
- Test counts are derived from per-suite `assertionResults` when a report omits
  the top-level totals.

### Changed

- `default-test-command` no longer defaults to the Vitest command; it is now
  empty and the command is built from the resolved framework. Set it only to
  run a full command verbatim. Existing configs that set it are unaffected.
- The log group for each app now echoes the resolved framework and command.

## [1.0.0] - 2026-07-16

### Added

- Composite action that runs unit tests for one or more apps and posts a merged
  coverage + pass/fail report to Heizen Studio.
- Configurable inputs: `api-key`, `base-url`, `apps`, `default-test-command`,
  `header-name`.
- Per-app `testCommand`, `resultsFile`, and `coverageFile` overrides.
- Report includes combined summary, per-app breakdown, and source metadata
  (repository, branch, commit, trigger, actor, run id).
- Guard that refuses to post an empty report when no app produces results, and
  warns on partial results.
- Self-contained smoke test and CI workflow.
