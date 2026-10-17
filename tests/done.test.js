import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "omp-done-"));
process.env.PI_CODING_AGENT_DIR = directory;
const { registerDone, formatDuration } = await import("../extensions/lib/done.js");
const { readSettings, updateSettings, SETTINGS_PATH } = await import("../extensions/lib/settings.js");
beforeEach(() => rmSync(SETTINGS_PATH, { force: true }));
after(() => rmSync(directory, { recursive: true, force: true }));

function create(mode = "tui", options) {
	const handlers = new Map();
	const commands = new Map();
	const notifications = [];
	const ctx = {
		mode,
		sessionManager: { getEntries: () => { throw new Error("timing must not read token usage"); } },
		ui: {
			theme: { fg: (color, message) => `${color}:${message}` },
			notify: (message, level) => notifications.push({ message, level }),
		},
	};
	registerDone({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
	}, options);
	return { ctx, commands, notifications, emit: (name, event = {}) => handlers.get(name)?.(event, ctx) };
}

test("done formats duration boundaries", () => {
	for (const [ms, expected] of [[-1000, "0s"], [0, "0s"], [499, "0s"], [500, "1s"], [59_500, "1m 0s"], [61_000, "1m 1s"], [3_661_000, "1h 1m 1s"]]) {
		assert.equal(formatDuration(ms), expected);
	}
});

test("done notifies only at final settlement with timing and theme color", (t) => {
	let now = 1000;
	t.mock.method(Date, "now", () => now);
	const session = create();
	session.emit("session_start");
	now = 4000;
	session.emit("before_agent_start");
	session.emit("agent_end");
	assert.equal(session.notifications.length, 0);
	now = 9000;
	session.emit("agent_settled");
	assert.deepEqual(session.notifications, [{
		message: "success:本轮 5s · 会话累计 8s",
		level: "info",
	}]);
	// 缺少本轮开始事件时不复用上一轮计时。
	now = 10_000;
	session.emit("agent_settled");
	assert.doesNotMatch(session.notifications.at(-1).message, /本轮/);
});

test("done resets timings on new sessions/reload and reports aborted settlement", (t) => {
	let now = 0;
	t.mock.method(Date, "now", () => now);
	const session = create();
	session.emit("session_start");
	session.emit("before_agent_start");
	now = 10_000;
	session.emit("session_shutdown");
	session.emit("session_start");
	now = 12_000;
	session.emit("before_agent_start");
	now = 15_000;
	session.emit("agent_settled", { aborted: true });
	assert.match(session.notifications.at(-1).message, /^success:本轮 3s · 会话累计 5s/);
});

test("done omits tokens and cost and never reads session usage", (t) => {
	t.mock.method(Date, "now", () => 1000);
	const session = create();
	session.emit("session_start");
	session.emit("before_agent_start");
	session.emit("agent_settled");
	const { message } = session.notifications.at(-1);
	assert.equal(message, "success:本轮 0s · 会话累计 0s");
	assert.doesNotMatch(message, /tokens|输入|输出|\$/);
});

test("done switch persists independently of editor/tools and reloads without stale timing", async () => {
	updateSettings({ enabled: false, toolsEnabled: false, future: 42 });
	const session = create();
	const command = session.commands.get("omp-done");
	await command.handler(" off ", session.ctx);
	assert.deepEqual(readSettings(), { enabled: false, toolsEnabled: false, future: 42, doneEnabled: false });
	session.notifications.length = 0;
	session.emit("before_agent_start");
	session.emit("agent_settled");
	assert.equal(session.notifications.length, 0);
	const reloaded = create();
	reloaded.emit("agent_settled");
	assert.equal(reloaded.notifications.length, 0);

	await reloaded.commands.get("omp-done").handler("on", reloaded.ctx);
	assert.equal(readSettings().doneEnabled, true);
	assert.equal(readSettings().enabled, false);
	assert.equal(readSettings().toolsEnabled, false);
	reloaded.emit("agent_settled");
	assert.match(reloaded.notifications.at(-1).message, /会话累计/);
	assert.doesNotMatch(reloaded.notifications.at(-1).message, /本轮/);
	await reloaded.commands.get("omp-done").handler("", reloaded.ctx);
	assert.match(reloaded.notifications.at(-1).message, /enabled/);
	await reloaded.commands.get("omp-done").handler("invalid", reloaded.ctx);
	assert.match(reloaded.notifications.at(-1).message, /Usage:/);
});

test("done publishes raw text to the border, clears it on lifecycle changes and toggles independently", async () => {
	const updates = [];
	const session = create("tui", { onUpdate: (text) => { updates.push(text); return true; } });
	session.emit("session_start");
	assert.equal(updates.at(-1), "");
	session.emit("before_agent_start");
	session.emit("agent_settled");
	assert.match(updates.at(-1), /^本轮 .* · 会话累计 .*s$/);
	assert.doesNotMatch(updates.at(-1), /tokens|输入|输出|\$/);
	assert.doesNotMatch(updates.at(-1), /success:/, "theme colors belong to render time");
	assert.deepEqual(session.notifications, []);
	await session.commands.get("omp-done").handler("off", session.ctx);
	assert.equal(updates.at(-1), "");
	await session.commands.get("omp-done").handler("on", session.ctx);
	assert.match(updates.at(-1), /^本轮/);
	session.emit("before_agent_start");
	assert.equal(updates.at(-1), "");
	session.emit("agent_settled");
	session.emit("session_shutdown");
	assert.equal(updates.at(-1), "");
});

test("done stays silent and never reads usage or writes settings outside TUI", async () => {
	for (const mode of ["rpc", "json", "print"]) {
		const session = create(mode, { onUpdate: () => { throw new Error("must not update terminal UI"); } });
		session.ctx.sessionManager.getEntries = () => { throw new Error("must not read usage"); };
		session.emit("session_start");
		session.emit("before_agent_start");
		session.emit("agent_settled");
		await session.commands.get("omp-done").handler("off", session.ctx);
		assert.deepEqual(session.notifications, []);
		assert.deepEqual(readSettings(), {});
	}
});
