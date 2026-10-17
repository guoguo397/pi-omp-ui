import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSettings, updateSettings } from "../extensions/lib/settings.js";

test("settings preserve editor/tool switches, unknown keys and old configurations", () => {
	const directory = mkdtempSync(join(tmpdir(), "omp-settings-"));
	const path = join(directory, "settings.json");
	try {
		assert.deepEqual(readSettings(path), {});
		writeFileSync(path, '{"enabled":false,"future":42}');
		updateSettings({ toolsEnabled: false }, path);
		assert.deepEqual(readSettings(path), { enabled: false, future: 42, toolsEnabled: false });
		updateSettings({ enabled: true }, path);
		assert.deepEqual(readSettings(path), { enabled: true, future: 42, toolsEnabled: false });
		assert.ok(readFileSync(path, "utf8").endsWith("\n"));
		for (const bad of ["null", "[]", "42", "broken JSON"]) {
			writeFileSync(path, bad);
			assert.deepEqual(readSettings(path), {});
		}
		updateSettings({ toolsEnabled: true }, join(directory, "new", "settings.json"));
		assert.equal(readSettings(join(directory, "new", "settings.json")).toolsEnabled, true);
	} finally { rmSync(directory, { recursive: true, force: true }); }
});
