import { spawnSync } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://api.studio.heizen.work";
const DEFAULT_RESULTS_FILE = "test-results.json";
const DEFAULT_COVERAGE_FILE = "coverage/coverage-summary.json";
const DEFAULT_HEADER_NAME = "x-api-key";
const DEFAULT_PACKAGE_MANAGER = "pnpm";
const METRICS = ["lines", "statements", "functions", "branches"];

// Both runners emit a Jest-shaped JSON report and an Istanbul json-summary, so
// only the flags that produce them differ.
const FRAMEWORKS = {
	vitest: {
		binary: "vitest",
		configFiles: ["vitest.config.ts", "vitest.config.js", "vitest.config.mjs"],
		reportFlags: (app) => [
			"--run",
			"--coverage",
			"--coverage.reporter=json-summary",
			`--coverage.reportsDirectory=${dirname(app.coverageFile)}`,
			"--reporter=json",
			`--outputFile=${app.resultsFile}`,
		],
	},
	jest: {
		binary: "jest",
		configFiles: [
			"jest.config.ts",
			"jest.config.js",
			"jest.config.mjs",
			"jest.config.json",
		],
		reportFlags: (app) => [
			"--coverage",
			"--coverageReporters=json-summary",
			`--coverageDirectory=${dirname(app.coverageFile)}`,
			"--json",
			`--outputFile=${app.resultsFile}`,
		],
	},
};
const FRAMEWORK_NAMES = Object.keys(FRAMEWORKS);
const FALLBACK_FRAMEWORK = "vitest";
const EXEC_PREFIXES = { pnpm: "pnpm exec", npm: "npx", yarn: "yarn", bun: "bunx" };
// npm needs `--` to forward extra args to the script; pnpm, yarn and bun pass
// a literal `--` straight through to the runner, which swallows the flags.
const SCRIPT_ARG_SEPARATORS = { npm: "-- " };

const {
	REPORT_BASE_URL,
	REPORT_API_KEY,
	REPORT_APPS,
	REPORT_DEFAULT_TEST_COMMAND,
	REPORT_TEST_SCRIPT,
	REPORT_FRAMEWORK,
	REPORT_PACKAGE_MANAGER,
	REPORT_HEADER_NAME,
	GITHUB_SHA,
	GITHUB_REF_NAME,
	GITHUB_EVENT_NAME,
	GITHUB_RUN_ID,
	GITHUB_REPOSITORY,
	GITHUB_ACTOR,
} = process.env;

function normalizeFramework(value, source) {
	if (!value || value === "auto") return null;
	const framework = String(value).trim().toLowerCase();
	if (!FRAMEWORK_NAMES.includes(framework)) {
		throw new Error(
			`Unsupported framework '${value}' in ${source}. Supported: ${FRAMEWORK_NAMES.join(", ")}.`,
		);
	}
	return framework;
}

// Accepts a bare script name ("test:unit") or a written-out invocation
// ("pnpm test:unit", "npm run test:unit"), and returns just the script name.
function normalizeTestScript(value) {
	if (!value) return null;
	const parts = String(value).trim().split(/\s+/);
	if (parts.length > 1 && Object.keys(EXEC_PREFIXES).includes(parts[0])) {
		parts.shift();
		if (parts[0] === "run") parts.shift();
	}
	return parts.join(" ") || null;
}

function packageManager() {
	return REPORT_PACKAGE_MANAGER?.trim() || DEFAULT_PACKAGE_MANAGER;
}

// Builds the command for an app that named a framework or a package script,
// appending the flags that make the runner emit the report files we collect.
function buildTestCommand(app, framework, pm = packageManager()) {
	const flags = FRAMEWORKS[framework].reportFlags(app).join(" ");
	if (app.testScript) {
		const separator = SCRIPT_ARG_SEPARATORS[pm] ?? "";
		return `${pm} run ${app.testScript} ${separator}${flags}`;
	}
	const exec = EXEC_PREFIXES[pm] ?? `${pm} exec`;
	return `${exec} ${FRAMEWORKS[framework].binary} ${flags}`;
}

function parseApps(raw = REPORT_APPS) {
	if (!raw) throw new Error("Missing 'apps' input.");
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error("'apps' input is not valid JSON.");
	}
	if (!Array.isArray(parsed) || parsed.length === 0) {
		throw new Error("'apps' input must be a non-empty JSON array.");
	}
	const globalFramework = normalizeFramework(REPORT_FRAMEWORK, "'framework' input");
	const globalScript = normalizeTestScript(REPORT_TEST_SCRIPT);
	return parsed.map((app) => {
		if (!app.name || !app.directory) {
			throw new Error("Each app entry needs 'name' and 'directory'.");
		}
		// Most specific wins: the app's own command, then its script, then the
		// action-wide command, then the action-wide script.
		const appScript = normalizeTestScript(app.testScript);
		const source = app.testCommand
			? { testCommand: app.testCommand }
			: appScript
				? { testScript: appScript }
				: REPORT_DEFAULT_TEST_COMMAND
					? { testCommand: REPORT_DEFAULT_TEST_COMMAND }
					: globalScript
						? { testScript: globalScript }
						: {};
		return {
			name: app.name,
			directory: app.directory,
			framework:
				normalizeFramework(app.framework, `app '${app.name}'`) ?? globalFramework,
			testCommand: source.testCommand ?? null,
			testScript: source.testScript ?? null,
			resultsFile: app.resultsFile || DEFAULT_RESULTS_FILE,
			coverageFile: app.coverageFile || DEFAULT_COVERAGE_FILE,
		};
	});
}

async function fileExists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function frameworkNamedIn(script) {
	return (
		FRAMEWORK_NAMES.find((framework) =>
			new RegExp(`\\b${framework}\\b`).test(script ?? ""),
		) ?? null
	);
}

async function detectFramework(directory, scriptName) {
	const pkg = await readJson(join(directory, "package.json"));
	// The script we are about to run is the strongest signal.
	const named = scriptName ? frameworkNamedIn(pkg?.scripts?.[scriptName]) : null;
	if (named) return named;
	const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
	for (const framework of FRAMEWORK_NAMES) {
		if (deps[framework]) return framework;
	}
	const fromTestScript = frameworkNamedIn(pkg?.scripts?.test);
	if (fromTestScript) return fromTestScript;
	for (const framework of FRAMEWORK_NAMES) {
		for (const file of FRAMEWORKS[framework].configFiles) {
			if (await fileExists(join(directory, file))) return framework;
		}
	}
	return null;
}

// Fills in each app's framework and test command. An explicit testCommand always
// wins; otherwise the framework decides, detected from the app when not declared.
async function resolveApps(apps) {
	const pm = packageManager();
	return Promise.all(
		apps.map(async (app) => {
			if (app.testCommand) return app;
			const framework =
				app.framework ??
				(await detectFramework(app.directory, app.testScript)) ??
				FALLBACK_FRAMEWORK;
			return { ...app, framework, testCommand: buildTestCommand(app, framework, pm) };
		}),
	);
}

function runTests(app) {
	if (!app.testCommand) {
		console.warn(`No test command for ${app.name}; skipping test run.`);
		return;
	}
	const label = app.framework ? `${app.name} (${app.framework})` : app.name;
	console.log(`::group::Running tests for ${label}`);
	console.log(`$ ${app.testCommand}`);
	const result = spawnSync(app.testCommand, {
		cwd: app.directory,
		shell: true,
		stdio: "inherit",
	});
	console.log("::endgroup::");
	if (result.error) {
		console.log(
			`::warning::Could not run tests for ${app.name}: ${result.error.message}`,
		);
	} else if (result.status !== 0) {
		// An annotation rather than a plain log: the run is collapsed by default
		// and a runner that fails to start otherwise looks like a passing report.
		console.log(
			`::warning::Tests for ${app.name} exited with code ${result.status} — command: ${app.testCommand}`,
		);
	}
}

async function readJson(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

const ASSERTION_BUCKETS = {
	passed: "passed",
	failed: "failed",
	pending: "skipped",
	skipped: "skipped",
	todo: "todo",
};

// Fallback for reports that carry per-suite detail but no top-level counters.
function countAssertions(results) {
	const suites = Array.isArray(results.testResults) ? results.testResults : [];
	const counts = { total: 0, passed: 0, failed: 0, skipped: 0, todo: 0 };
	const suiteCounts = { total: suites.length, passed: 0, failed: 0 };
	for (const suite of suites) {
		const assertions = suite.assertionResults ?? suite.testResults ?? [];
		for (const assertion of assertions) {
			counts.total += 1;
			const bucket = ASSERTION_BUCKETS[assertion.status];
			if (bucket) counts[bucket] += 1;
		}
		const failed =
			suite.status === "failed" ||
			assertions.some((assertion) => assertion.status === "failed");
		if (failed) suiteCounts.failed += 1;
		else suiteCounts.passed += 1;
	}
	return { ...counts, suites: suiteCounts };
}

function testsFromResults(results) {
	if (!results) return null;
	const derived = results.numTotalTests == null ? countAssertions(results) : null;
	const tests = {
		total: results.numTotalTests ?? derived?.total ?? 0,
		passed: results.numPassedTests ?? derived?.passed ?? 0,
		failed: results.numFailedTests ?? derived?.failed ?? 0,
		skipped: results.numPendingTests ?? derived?.skipped ?? 0,
		todo: results.numTodoTests ?? derived?.todo ?? 0,
		suites: {
			total: results.numTotalTestSuites ?? derived?.suites.total ?? 0,
			passed: results.numPassedTestSuites ?? derived?.suites.passed ?? 0,
			failed: results.numFailedTestSuites ?? derived?.suites.failed ?? 0,
		},
	};
	return {
		...tests,
		success: results.success ?? (tests.failed === 0 && tests.suites.failed === 0),
	};
}

// Istanbul writes the string "Unknown" for pct when nothing was instrumented,
// so every numeric field is coerced rather than passed through.
function numeric(value) {
	const n = Number(value);
	return Number.isFinite(n) ? n : 0;
}

function coverageFromSummary(summary) {
	if (!summary?.total) return null;
	return Object.fromEntries(
		METRICS.map((metric) => {
			const m = summary.total[metric] ?? {};
			return [
				metric,
				{
					total: numeric(m.total),
					covered: numeric(m.covered),
					skipped: numeric(m.skipped),
					pct: numeric(m.pct),
				},
			];
		}),
	);
}

function mergeCoverage(coverages) {
	const present = coverages.filter(Boolean);
	if (!present.length) return null;
	return Object.fromEntries(
		METRICS.map((metric) => {
			const total = present.reduce((sum, c) => sum + c[metric].total, 0);
			const covered = present.reduce((sum, c) => sum + c[metric].covered, 0);
			return [
				metric,
				{
					total,
					covered,
					pct: total ? Number(((covered / total) * 100).toFixed(2)) : 0,
				},
			];
		}),
	);
}

function sum(values) {
	return values.reduce((acc, v) => acc + (v ?? 0), 0);
}

async function buildPayload(appConfigs) {
	const apps = {};
	const testList = [];
	const coverageList = [];

	for (const app of appConfigs) {
		const [results, coverage] = await Promise.all([
			readJson(join(app.directory, app.resultsFile)),
			readJson(join(app.directory, app.coverageFile)),
		]);
		const tests = testsFromResults(results);
		const cov = coverageFromSummary(coverage);
		apps[app.name] = { tests, coverage: cov };
		if (tests) testList.push(tests);
		if (cov) coverageList.push(cov);
	}

	const combinedTests = {
		total: sum(testList.map((t) => t.total)),
		passed: sum(testList.map((t) => t.passed)),
		failed: sum(testList.map((t) => t.failed)),
		skipped: sum(testList.map((t) => t.skipped)),
		todo: sum(testList.map((t) => t.todo)),
		suites: {
			total: sum(testList.map((t) => t.suites.total)),
			passed: sum(testList.map((t) => t.suites.passed)),
			failed: sum(testList.map((t) => t.suites.failed)),
		},
	};

	return {
		generatedAt: new Date().toISOString(),
		source: {
			repository: GITHUB_REPOSITORY ?? null,
			branch: GITHUB_REF_NAME ?? null,
			commit: GITHUB_SHA ?? null,
			trigger: GITHUB_EVENT_NAME ?? null,
			actor: GITHUB_ACTOR ?? null,
			runId: GITHUB_RUN_ID ?? null,
		},
		summary: {
			// A run only succeeded if tests actually ran and nothing failed at
			// either level: a suite that fails to load reports zero tests, so
			// `failed === 0` alone would call a totally broken run green.
			success:
				testList.length > 0 &&
				combinedTests.total > 0 &&
				combinedTests.failed === 0 &&
				combinedTests.suites.failed === 0,
			tests: combinedTests,
			coverage: mergeCoverage(coverageList),
		},
		apps,
	};
}

async function main() {
	const appConfigs = await resolveApps(parseApps());

	for (const app of appConfigs) runTests(app);

	const payload = await buildPayload(appConfigs);

	console.log("Test metrics report payload:");
	console.log(JSON.stringify(payload, null, 2));

	const collectedApps = Object.entries(payload.apps)
		.filter(([, app]) => app.tests)
		.map(([name]) => name);

	if (collectedApps.length === 0) {
		throw new Error(
			"No test results found for any app. Refusing to post an empty report — check that each app's testCommand writes its resultsFile and coverageFile.",
		);
	}

	const missingApps = Object.entries(payload.apps)
		.filter(([, app]) => !app.tests)
		.map(([name]) => name);

	if (missingApps.length) {
		console.log(
			`::warning::No test results for [${missingApps.join(", ")}]. Posting a partial report — check the command echoed in each app's log group.`,
		);
	}

	// Suites that fail to load report zero tests, which reads as a clean run.
	for (const [name, app] of Object.entries(payload.apps)) {
		if (app.tests && app.tests.total === 0) {
			console.log(
				`::error::${name} collected 0 tests from ${app.tests.suites.total} suites (${app.tests.suites.failed} failed to run). The runner started but could not execute any test — usually a config or setup the app's own test script provides.`,
			);
		}
	}

	if (!REPORT_API_KEY) {
		throw new Error("Missing 'api-key' input. Cannot post report.");
	}

	const baseUrl = (REPORT_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, "");
	const url = `${baseUrl}/unit-testcases/report`;
	const headerName = REPORT_HEADER_NAME || DEFAULT_HEADER_NAME;

	const response = await fetch(url, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			[headerName]: REPORT_API_KEY,
		},
		body: JSON.stringify(payload),
	});

	const text = await response.text();
	if (!response.ok) {
		throw new Error(
			`Report POST failed: ${response.status} ${response.statusText} — ${text}`,
		);
	}

	console.log(`Report posted to ${url} (${response.status})`);
	if (text) console.log(`Response: ${text}`);
}

export {
	parseApps,
	resolveApps,
	detectFramework,
	buildTestCommand,
	buildPayload,
	mergeCoverage,
	testsFromResults,
};

const invokedDirectly =
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	main().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
