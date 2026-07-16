import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_BASE_URL = "https://api.studio.heizen.work";
const DEFAULT_RESULTS_FILE = "test-results.json";
const DEFAULT_COVERAGE_FILE = "coverage/coverage-summary.json";
const DEFAULT_HEADER_NAME = "x-api-key";
const METRICS = ["lines", "statements", "functions", "branches"];

const {
	REPORT_BASE_URL,
	REPORT_API_KEY,
	REPORT_APPS,
	REPORT_DEFAULT_TEST_COMMAND,
	REPORT_HEADER_NAME,
	GITHUB_SHA,
	GITHUB_REF_NAME,
	GITHUB_EVENT_NAME,
	GITHUB_RUN_ID,
	GITHUB_REPOSITORY,
	GITHUB_ACTOR,
} = process.env;

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
	return parsed.map((app) => {
		if (!app.name || !app.directory) {
			throw new Error("Each app entry needs 'name' and 'directory'.");
		}
		return {
			name: app.name,
			directory: app.directory,
			testCommand: app.testCommand || REPORT_DEFAULT_TEST_COMMAND,
			resultsFile: app.resultsFile || DEFAULT_RESULTS_FILE,
			coverageFile: app.coverageFile || DEFAULT_COVERAGE_FILE,
		};
	});
}

function runTests(app) {
	if (!app.testCommand) {
		console.warn(`No test command for ${app.name}; skipping test run.`);
		return;
	}
	console.log(`::group::Running tests for ${app.name}`);
	const result = spawnSync(app.testCommand, {
		cwd: app.directory,
		shell: true,
		stdio: "inherit",
	});
	console.log("::endgroup::");
	if (result.status !== 0) {
		console.warn(`Tests for ${app.name} exited with code ${result.status}.`);
	}
}

async function readJson(path) {
	try {
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		return null;
	}
}

function testsFromResults(results) {
	if (!results) return null;
	return {
		total: results.numTotalTests ?? 0,
		passed: results.numPassedTests ?? 0,
		failed: results.numFailedTests ?? 0,
		skipped: results.numPendingTests ?? 0,
		todo: results.numTodoTests ?? 0,
		suites: {
			total: results.numTotalTestSuites ?? 0,
			passed: results.numPassedTestSuites ?? 0,
			failed: results.numFailedTestSuites ?? 0,
		},
		success: results.success ?? false,
	};
}

function coverageFromSummary(summary) {
	if (!summary?.total) return null;
	return Object.fromEntries(
		METRICS.map((metric) => {
			const m = summary.total[metric] ?? {};
			return [
				metric,
				{
					total: m.total ?? 0,
					covered: m.covered ?? 0,
					skipped: m.skipped ?? 0,
					pct: m.pct ?? 0,
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
			success: testList.length > 0 && combinedTests.failed === 0,
			tests: combinedTests,
			coverage: mergeCoverage(coverageList),
		},
		apps,
	};
}

async function main() {
	const appConfigs = parseApps();

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

	if (collectedApps.length < appConfigs.length) {
		console.warn(
			`Warning: results found only for [${collectedApps.join(", ")}]. Posting a partial report.`,
		);
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

export { parseApps, buildPayload, mergeCoverage };

const invokedDirectly =
	process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
	main().catch((error) => {
		console.error(error.message);
		process.exit(1);
	});
}
