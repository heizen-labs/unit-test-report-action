# Changelog

All notable changes to this action are documented here.

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
