import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import {
	buildPayload,
	buildTestCommand,
	detectFramework,
	mergeCoverage,
	parseApps,
	resolveApps,
	testsFromResults,
} from "../scripts/collect-and-post.mjs";

const fixtureDir = fileURLToPath(new URL("./fixtures/app", import.meta.url));
const jestFixtureDir = fileURLToPath(
	new URL("./fixtures/jest-app", import.meta.url),
);

function check(name, fn) {
	try {
		fn();
		console.log(`  ok  ${name}`);
	} catch (error) {
		console.error(`  FAIL  ${name}`);
		console.error(error.message);
		process.exitCode = 1;
	}
}

async function checkAsync(name, fn) {
	try {
		await fn();
		console.log(`  ok  ${name}`);
	} catch (error) {
		console.error(`  FAIL  ${name}`);
		console.error(error.message);
		process.exitCode = 1;
	}
}

check("parseApps applies defaults", () => {
	const [app] = parseApps(
		JSON.stringify([{ name: "demo", directory: "apps/demo" }]),
	);
	assert.equal(app.resultsFile, "test-results.json");
	assert.equal(app.coverageFile, "coverage/coverage-summary.json");
});

check("parseApps rejects invalid JSON", () => {
	assert.throws(() => parseApps("not json"), /not valid JSON/);
});

check("parseApps requires name and directory", () => {
	assert.throws(
		() => parseApps(JSON.stringify([{ name: "demo" }])),
		/needs 'name' and 'directory'/,
	);
});

check("parseApps accepts a per-app framework", () => {
	const [app] = parseApps(
		JSON.stringify([{ name: "demo", directory: "apps/demo", framework: "Jest" }]),
	);
	assert.equal(app.framework, "jest");
});

check("parseApps rejects an unknown framework", () => {
	assert.throws(
		() =>
			parseApps(
				JSON.stringify([
					{ name: "demo", directory: "apps/demo", framework: "mocha" },
				]),
			),
		/Unsupported framework 'mocha'/,
	);
});

check("parseApps normalizes a written-out test script", () => {
	const cases = ["test:unit", "pnpm test:unit", "npm run test:unit"];
	for (const value of cases) {
		const [app] = parseApps(
			JSON.stringify([
				{ name: "demo", directory: "apps/demo", testScript: value },
			]),
		);
		assert.equal(app.testScript, "test:unit", `from ${value}`);
	}
});

check("buildTestCommand appends report flags to a package script", () => {
	const app = {
		testScript: "test:unit",
		resultsFile: "test-results.json",
		coverageFile: "coverage/coverage-summary.json",
	};
	// pnpm forwards extra args as-is; a literal `--` would reach the runner and
	// be read as a file filter, silently dropping every flag after it.
	assert.equal(
		buildTestCommand(app, "jest", "pnpm"),
		"pnpm run test:unit --coverage --coverageReporters=json-summary --coverageDirectory=coverage --json --outputFile=test-results.json",
	);
	// npm is the opposite: without `--` the flags never reach the runner.
	assert.equal(
		buildTestCommand(app, "vitest", "npm"),
		"npm run test:unit -- --run --coverage --coverage.reporter=json-summary --coverage.reportsDirectory=coverage --reporter=json --outputFile=test-results.json",
	);
});

check("buildTestCommand honours custom output paths", () => {
	const command = buildTestCommand(
		{ resultsFile: "out/results.json", coverageFile: "out/cov/coverage-summary.json" },
		"jest",
		"pnpm",
	);
	assert.match(command, /--coverageDirectory=out\/cov\b/);
	assert.match(command, /--outputFile=out\/results\.json$/);
});

check("buildTestCommand uses the package manager's exec form", () => {
	const app = {
		resultsFile: "test-results.json",
		coverageFile: "coverage/coverage-summary.json",
	};
	assert.match(buildTestCommand(app, "jest", "pnpm"), /^pnpm exec jest /);
	assert.match(buildTestCommand(app, "jest", "npm"), /^npx jest /);
	assert.match(buildTestCommand(app, "vitest", "bun"), /^bunx vitest /);
});

await checkAsync("resolveApps uses the declared framework's binary", async () => {
	const [app] = await resolveApps(
		parseApps(
			JSON.stringify([
				{ name: "demo", directory: jestFixtureDir, framework: "jest" },
			]),
		),
	);
	assert.match(app.testCommand, /^pnpm exec jest /);
});

await checkAsync("resolveApps keeps an explicit testCommand", async () => {
	const [app] = await resolveApps(
		parseApps(
			JSON.stringify([
				{ name: "demo", directory: jestFixtureDir, testCommand: "npm test" },
			]),
		),
	);
	assert.equal(app.testCommand, "npm test");
});

await checkAsync("resolveApps runs an app's testScript", async () => {
	const [app] = await resolveApps(
		parseApps(
			JSON.stringify([
				{ name: "demo", directory: jestFixtureDir, testScript: "test:unit" },
			]),
		),
	);
	assert.match(app.testCommand, /^pnpm run test:unit --coverage /);
});

await checkAsync("resolveApps detects jest from package.json", async () => {
	const [app] = await resolveApps(
		parseApps(JSON.stringify([{ name: "demo", directory: jestFixtureDir }])),
	);
	assert.equal(app.framework, "jest");
	assert.match(app.testCommand, /^pnpm exec jest /);
});

await checkAsync("resolveApps falls back to vitest when undetectable", async () => {
	const [app] = await resolveApps(
		parseApps(JSON.stringify([{ name: "demo", directory: fixtureDir }])),
	);
	assert.equal(app.framework, "vitest");
	assert.match(app.testCommand, /^pnpm exec vitest /);
});

// mixed-app declares jest as a dependency but its test:unit script runs vitest.
await checkAsync("detectFramework prefers the script being run", async () => {
	const mixedDir = fileURLToPath(new URL("./fixtures/mixed-app", import.meta.url));
	assert.equal(await detectFramework(mixedDir, "test:unit"), "vitest");
	assert.equal(await detectFramework(mixedDir), "jest");
});

await checkAsync("detectFramework returns null for a bare directory", async () => {
	assert.equal(await detectFramework(fixtureDir), null);
});

check("testsFromResults derives counts when totals are absent", () => {
	const tests = testsFromResults({
		testResults: [
			{
				status: "passed",
				assertionResults: [{ status: "passed" }, { status: "pending" }],
			},
			{
				status: "failed",
				assertionResults: [{ status: "failed" }, { status: "todo" }],
			},
		],
	});
	assert.deepEqual(tests, {
		total: 4,
		passed: 1,
		failed: 1,
		skipped: 1,
		todo: 1,
		suites: { total: 2, passed: 1, failed: 1 },
		success: false,
	});
});

check("mergeCoverage recomputes weighted pct", () => {
	const full = (covered) => ({
		lines: { total: 100, covered },
		statements: { total: 100, covered },
		functions: { total: 100, covered },
		branches: { total: 100, covered },
	});
	const merged = mergeCoverage([full(50), full(100)]);
	assert.equal(merged.lines.total, 200);
	assert.equal(merged.lines.covered, 150);
	assert.equal(merged.lines.pct, 75);
});

await checkAsync("buildPayload merges fixture tests and coverage", async () => {
	const payload = await buildPayload([
		{
			name: "demo",
			directory: fixtureDir,
			resultsFile: "test-results.json",
			coverageFile: "coverage/coverage-summary.json",
		},
	]);
	assert.equal(payload.summary.tests.total, 3);
	assert.equal(payload.summary.tests.passed, 3);
	assert.equal(payload.summary.coverage.lines.pct, 80);
	assert.ok(payload.apps.demo.tests, "demo app tests present");
	assert.ok(payload.generatedAt, "generatedAt stamped");
});

await checkAsync("buildPayload reads a jest report in the same shape", async () => {
	const payload = await buildPayload([
		{
			name: "jest-demo",
			directory: jestFixtureDir,
			resultsFile: "test-results.json",
			coverageFile: "coverage/coverage-summary.json",
		},
	]);
	assert.deepEqual(payload.apps["jest-demo"].tests, {
		total: 6,
		passed: 3,
		failed: 1,
		skipped: 1,
		todo: 1,
		suites: { total: 2, passed: 1, failed: 1 },
		success: false,
	});
	assert.equal(payload.apps["jest-demo"].coverage.lines.pct, 50);
	assert.equal(payload.summary.success, false);
});

await checkAsync("buildPayload merges jest and vitest apps together", async () => {
	const app = (name, directory) => ({
		name,
		directory,
		resultsFile: "test-results.json",
		coverageFile: "coverage/coverage-summary.json",
	});
	const payload = await buildPayload([
		app("vitest-demo", fixtureDir),
		app("jest-demo", jestFixtureDir),
	]);
	// Same payload shape regardless of which runner produced each report.
	assert.deepEqual(Object.keys(payload.apps), ["vitest-demo", "jest-demo"]);
	assert.deepEqual(Object.keys(payload.apps["jest-demo"]), ["tests", "coverage"]);
	assert.equal(payload.summary.tests.total, 9);
	assert.equal(payload.summary.tests.passed, 6);
	assert.equal(payload.summary.tests.failed, 1);
	assert.equal(payload.summary.tests.suites.total, 3);
	// lines: (8 + 10) covered of (10 + 20) total.
	assert.equal(payload.summary.coverage.lines.covered, 18);
	assert.equal(payload.summary.coverage.lines.pct, 60);
	assert.equal(payload.summary.success, false);
});

// A runner that starts but cannot load any suite reports 0 tests and N failed
// suites. Counting only failed *tests* called that a success.
await checkAsync("buildPayload fails a run where every suite failed to load", async () => {
	const brokenDir = fileURLToPath(new URL("./fixtures/broken-app", import.meta.url));
	const payload = await buildPayload([
		{
			name: "server",
			directory: brokenDir,
			resultsFile: "test-results.json",
			coverageFile: "coverage/coverage-summary.json",
		},
	]);
	assert.equal(payload.summary.tests.total, 0);
	assert.equal(payload.summary.tests.suites.failed, 53);
	assert.equal(payload.summary.success, false);
});

// Istanbul writes "Unknown" for pct when nothing was instrumented.
await checkAsync("buildPayload coerces non-numeric coverage pct", async () => {
	const brokenDir = fileURLToPath(new URL("./fixtures/broken-app", import.meta.url));
	const payload = await buildPayload([
		{
			name: "server",
			directory: brokenDir,
			resultsFile: "test-results.json",
			coverageFile: "coverage/coverage-summary.json",
		},
	]);
	for (const metric of ["lines", "statements", "functions", "branches"]) {
		const pct = payload.apps.server.coverage[metric].pct;
		assert.equal(typeof pct, "number", `${metric} pct is a number`);
		assert.equal(pct, 0);
	}
});

await checkAsync("buildPayload keeps success true for a clean run", async () => {
	const payload = await buildPayload([
		{
			name: "demo",
			directory: fixtureDir,
			resultsFile: "test-results.json",
			coverageFile: "coverage/coverage-summary.json",
		},
	]);
	assert.equal(payload.summary.success, true);
});

await checkAsync("buildPayload reports null tests for missing files", async () => {
	const payload = await buildPayload([
		{
			name: "missing",
			directory: fixtureDir,
			resultsFile: "does-not-exist.json",
			coverageFile: "nope/coverage-summary.json",
		},
	]);
	assert.equal(payload.apps.missing.tests, null);
	assert.equal(payload.summary.success, false);
});

if (process.exitCode) {
	console.error("\nTESTS FAILED");
} else {
	console.log("\nALL TESTS PASSED");
}
