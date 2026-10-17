import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";

const directory = mkdtempSync(join(tmpdir(), "omp-footer-icon-"));
process.env.PI_CODING_AGENT_DIR = directory;
const { registerFooterIcon, withIcon } = await import("../extensions/lib/footer-icon.js");
const { readSettings, SETTINGS_PATH } = await import("../extensions/lib/settings.js");
const { FooterComponent } = await import("@earendil-works/pi-coding-agent");
const originalRender = FooterComponent.prototype.render;
beforeEach(() => rmSync(SETTINGS_PATH, { force: true }));
after(() => rmSync(directory, { recursive: true, force: true }));

function create(mode = "tui") {
	const handlers = new Map();
	const commands = new Map();
	const notifications = [];
	const ctx = { mode, ui: { notify: (message, level) => notifications.push({ message, level }) } };
	registerFooterIcon({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
	});
	return {
		ctx, commands, notifications,
		emit: async (name) => handlers.get(name)?.({}, ctx),
	};
}

test("withIcon prepends the folder icon and stays within width", () => {
	const lines = ["~/project (main)", "stats"];
	assert.deepEqual(withIcon([...lines], 40), ["📁 ~/project (main)", "stats"]);
	const narrow = withIcon([...lines], 10);
	assert.equal(visibleWidth(narrow[0]) <= 10, true);
	assert.ok(narrow[0].startsWith("📁"));
	assert.deepEqual(withIcon([], 40), []);
	assert.deepEqual(withIcon([...lines], 3), lines, "icon is skipped when it would not fit");
});

test("patch wraps the built-in footer only when enabled and restores on shutdown", async () => {
	const session = create();
	await session.emit("session_start");
	assert.notEqual(FooterComponent.prototype.render, originalRender);
	await session.commands.get("omp-footer").handler("off", session.ctx);
	assert.equal(FooterComponent.prototype.render, originalRender);
	assert.equal(readSettings().footerIconEnabled, false);
	assert.match(session.notifications.at(-1).message, /disabled/);
	await session.commands.get("omp-footer").handler("on", session.ctx);
	assert.notEqual(FooterComponent.prototype.render, originalRender);
	assert.equal(readSettings().footerIconEnabled, true);
	await session.commands.get("omp-footer").handler("status", session.ctx);
	assert.match(session.notifications.at(-1).message, /enabled/);
	await session.emit("session_shutdown");
	assert.equal(FooterComponent.prototype.render, originalRender);
});

test("disabled setting stays native across sessions and non-TUI modes never patch", async () => {
	const { updateSettings } = await import("../extensions/lib/settings.js");
	updateSettings({ footerIconEnabled: false });
	const session = create();
	await session.emit("session_start");
	assert.equal(FooterComponent.prototype.render, originalRender);
	await session.emit("session_shutdown");
	for (const mode of ["rpc", "json", "print"]) {
		const nonTui = create(mode);
		await nonTui.emit("session_start");
		assert.equal(FooterComponent.prototype.render, originalRender);
		await nonTui.emit("session_shutdown");
	}
});
