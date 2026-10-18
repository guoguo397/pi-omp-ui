import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { discoverAndLoadExtensions } from "@earendil-works/pi-coding-agent";

test("Pi's real extension loader loads the package with only the interaction mode command", async () => {
	const directory = mkdtempSync(join(tmpdir(), "omp-load-"));
	try {
		const loaded = await discoverAndLoadExtensions([resolve("extensions/omp-editor.js")], directory, directory);
		assert.deepEqual(loaded.errors, []);
		assert.equal(loaded.extensions.length, 1);
		const commands = loaded.extensions[0].commands;
		assert.deepEqual([...commands.keys()], ["omp-mode"]);
		assert.equal(loaded.extensions[0].tools.size, 0, "UI must not replace tool execution");
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
