import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { buildPayload, mergeCoverage, parseApps } from "../scripts/collect-and-post.mjs";

const fixtureDir = fileURLToPath(new URL("./fixtures/app", import.meta.url));

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
