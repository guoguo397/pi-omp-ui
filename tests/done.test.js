import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

const directory = mkdtempSync(join(tmpdir(), "omp-done-"));
process.env.PI_CODING_AGENT_DIR = directory;
const { registerDone, collectUsage, formatDuration, formatTokens } = await import("../extensions/lib/done.js");
const { readSettings, updateSettings, SETTINGS_PATH } = await import("../extensions/lib/settings.js");
beforeEach(() => rmSync(SETTINGS_PATH, { force: true }));
after(() => rmSync(directory, { recursive: true, force: true }));

const usage = { input: 100, output: 20, cacheRead: 30, cacheWrite: 5, cost: { total: 0.1 } };
const entries = [
	{ type: "usage", usage },
	{ type: "branch_summary", usage },
	{ type: "compaction", usage },
	{ type: "message", message: { role: "assistant", usage } },
	{ type: "message", message: { role: "toolResult", usage, details: { nested: { usage } } } },
	{ type: "message", message: { role: "user", usage } },
	{ type: "custom", usage },
	{ type: "compaction" },
	{ type: "message", message: { role: "assistant" } },
];

function create(mode = "tui", options) {
	const handlers = new Map();
	const commands = new Map();
	const notifications = [];
	const ctx = {
		mode,
		sessionManager: { getEntries: () => entries },
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

test("done usage includes all Pi entry types and cached/nested usage without double counting", () => {
	assert.deepEqual(collectUsage(entries), { input: 500, output: 100, cacheRead: 150, cacheWrite: 25, cost: 0.5 });
	assert.deepEqual(collectUsage([]), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
	assert.deepEqual(collectUsage([{ type: "usage", usage: { output: 42 } }]), { input: 0, output: 42, cacheRead: 0, cacheWrite: 0, cost: 0 });
});

test("done formats duration and token boundaries", () => {
	for (const [ms, expected] of [[-1000, "0s"], [0, "0s"], [499, "0s"], [500, "1s"], [59_500, "1m 0s"], [61_000, "1m 1s"], [3_661_000, "1h 1m 1s"]]) {
		assert.equal(formatDuration(ms), expected);
	}
	for (const [count, expected] of [[0, "0"], [999, "999"], [1000, "1.0k"], [12_345, "12.3k"], [1_000_000, "1.0M"], [1_250_000, "1.3M"]]) {
		assert.equal(formatTokens(count), expected);
	}
});

test("done notifies only at final settlement, preserving the original text, style and cost", (t) => {
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
		message: "success:本次 5s · 会话累计 8s · tokens 775（输入 675 / 输出 100） · $0.5000",
		level: "info",
	}]);
	// 缺少本轮开始事件时不复用上一轮计时。
	now = 10_000;
	session.emit("agent_settled");
	assert.doesNotMatch(session.notifications.at(-1).message, /本次/);
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
	assert.match(session.notifications.at(-1).message, /^success:本次 3s · 会话累计 5s/);
});

test("done hides zero cost and abbreviates cached-inclusive input and total tokens", () => {
	const session = create();
	session.ctx.sessionManager.getEntries = () => [{ type: "usage", usage: { input: 900, cacheRead: 100, output: 1_000_000 } }];
	session.emit("agent_settled");
	const { message } = session.notifications.at(-1);
	assert.match(message, /tokens 1.0M（输入 1.0k \/ 输出 1.0M）/);
	assert.doesNotMatch(message, /\$/);
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
	assert.doesNotMatch(reloaded.notifications.at(-1).message, /本次/);
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
	assert.match(updates.at(-1), /^本次 .*tokens 775/);
	assert.doesNotMatch(updates.at(-1), /success:/, "theme colors belong to render time");
	assert.deepEqual(session.notifications, []);
	await session.commands.get("omp-done").handler("off", session.ctx);
	assert.equal(updates.at(-1), "");
	await session.commands.get("omp-done").handler("on", session.ctx);
	assert.match(updates.at(-1), /^本次/);
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
