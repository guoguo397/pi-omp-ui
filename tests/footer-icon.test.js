import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const directory = mkdtempSync(join(tmpdir(), "omp-footer-icon-"));
process.env.PI_CODING_AGENT_DIR = directory;
const { registerFooterIcon, renderClaudeFooter, countMcpServers, collectToolUsage, collectOutputSpeed } = await import("../extensions/lib/footer-icon.js");
const { readSettings, SETTINGS_PATH } = await import("../extensions/lib/settings.js");
const { FooterComponent } = await import("@earendil-works/pi-coding-agent");
const originalRender = FooterComponent.prototype.render;
beforeEach(() => rmSync(SETTINGS_PATH, { force: true }));
after(() => {
	globalThis[Symbol.for("pi.omp-editor.footer-icon-patch")]?.dispose();
	rmSync(directory, { recursive: true, force: true });
});

function create(mode = "tui") {
	const handlers = new Map();
	const commands = new Map();
	const notifications = [];
	const ctx = { mode, sessionManager: { getEntryCount: () => 0 }, ui: {
		theme: { fg: (_token, text) => text },
		notify: (message, level) => notifications.push({ message, level }),
	} };
	registerFooterIcon({
		on: (name, handler) => handlers.set(name, handler),
		registerCommand: (name, command) => commands.set(name, command),
	});
	return {
		ctx, commands, notifications,
		emit: async (name) => handlers.get(name)?.({}, ctx),
	};
}

const plainTheme = { fg: (_token, text) => text };
const view = {
	modelName: "Opus 5.5", cwd: "C:\\project\\act", branch: "master",
	elapsedMs: 12_000, percent: 25, thinkingLevel: "high", busy: false,
	contextFiles: [{ path: "C:/AGENTS.md" }, { path: "C:/project/AGENTS.md" }],
	mcpCount: 2,
	usage: { input: 1000, output: 200, cacheRead: 2000, cacheWrite: 500, cost: 0.0123 },
	statuses: new Map([["subagents", "← 2 agents"]]),
};

test("Claude footer matches the four-line layout with real usage and extension statuses", () => {
	assert.deepEqual(renderClaudeFooter(view, 120, plainTheme), [
		"[Opus 5.5] | act git:(master) | ⏱ <1m",
		"Context ████░░░░░░░░░░░░ 25%",
		"2 AGENTS.md | 2 MCPs",
		"▶ ready · thinking high · ↑3.5k ↓200 · $0.0123 · ← 2 agents",
	]);
	const working = renderClaudeFooter({ ...view, busy: true, elapsedMs: 3_660_000 }, 120, plainTheme);
	assert.match(working[0], /1h 1m/);
	assert.doesNotMatch(working[3], /working|▶ ready/);
	assert.match(working[3], /^thinking high · ↑3\.5k/);
	assert.match(renderClaudeFooter({ ...view, compacting: true }, 120, plainTheme)[3], /▶ compacting/);
});

test("unknown context is not zero; percentages are clamped and severity uses the current theme", () => {
	const theme = { fg: (token, text) => `<${token}>${text}</${token}>` };
	for (const percent of [undefined, null, NaN, Infinity]) {
		assert.match(renderClaudeFooter({ ...view, percent }, 120, plainTheme)[1], /\?%$/);
	}
	assert.match(renderClaudeFooter({ ...view, percent: -10 }, 120, plainTheme)[1], / 0%$/);
	assert.match(renderClaudeFooter({ ...view, percent: 110 }, 120, plainTheme)[1], / 100%$/);
	for (const [percent, color] of [[25, "success"], [75, "warning"], [95, "error"]]) {
		assert.match(renderClaudeFooter({ ...view, percent }, 500, theme)[1], new RegExp(`<${color}>${percent}%`));
	}
});

test("every line fits narrow widths including Chinese, emoji and ANSI", () => {
	const theme = { fg: (_token, text) => `\x1b[32m${text}\x1b[0m` };
	const wide = { ...view, modelName: "模型 🦊", cwd: "C:/中文/项目", branch: "分支🌿" };
	for (let width = 0; width <= 120; width++) {
		const lines = renderClaudeFooter(wide, width, theme);
		assert.equal(lines.length, 4);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width}: ${line}`);
	}
	const lines = renderClaudeFooter({ ...view, modelName: "bad\n\x1b[31mname", branch: "x\r\ny" }, 120, plainTheme);
	assert.match(lines[0], /\[bad name\]/);
	assert.equal(lines.some((line) => /[\r\n\x1b]/.test(line)), false);
});

test("missing model, resources and git do not invent Claude-specific information", () => {
	const lines = renderClaudeFooter({ elapsedMs: 60_000, cwd: "/" }, 120, plainTheme);
	assert.match(lines[0], /^\[no-model\] \| \/ \| ⏱ 1m$/);
	assert.equal(lines[2], "0 context files | 0 MCPs");
	assert.equal(lines[3], "▶ ready");
	assert.doesNotMatch(lines.join("\n"), /auto mode|shift\+tab|agents/);
	assert.match(renderClaudeFooter({ ...view, contextFiles: [{ path: "/a/CLAUDE.md" }] }, 120, plainTheme)[2], /1 CLAUDE.md/);
});

test("tool usage counts saved results once, including failed, custom and nested calls", () => {
	const entries = [
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", name: "read" }] } },
		{ type: "message", message: { role: "toolResult", toolName: "read" } },
		{ type: "message", message: { role: "toolResult", toolName: "read", isError: true } },
		{ type: "message", message: { role: "toolResult", toolName: "codemode", nestedCalls: {
			calls: [{ name: "edit" }, { name: "read" }, { name: "mcp__wordcraft__open" }], complete: true,
		}, details: { calls: [{ name: "edit" }, { name: "read" }, { name: "models.classifier" }] } } },
		{ type: "compaction" }, { type: "branch_summary" }, { type: "custom" },
		{ type: "message", message: { role: "user", toolName: "ignored" } },
		{ type: "message", message: { role: "toolResult" } },
	];
	const usage = collectToolUsage(entries);
	assert.equal(usage.total, 6);
	assert.deepEqual([...usage.counts], [["read", 3], ["codemode", 1], ["edit", 1], ["mcp__wordcraft__open", 1]]);
	assert.equal(usage.incomplete, false);
	assert.deepEqual([...usage.outcomes], [["read", "error"], ["codemode", "ok"], ["edit", "ok"], ["mcp__wordcraft__open", "ok"]]);
	assert.deepEqual(collectToolUsage(), { total: 0, counts: new Map(), incomplete: false, outcomes: new Map() });
});

test("Claude-style tool summary sits above status, sorted by frequency and clipped safely", () => {
	const toolUsage = { total: 12, counts: new Map([["read", 5], ["edit", 3], ["powershell", 4]]) };
	const lines = renderClaudeFooter({ ...view, toolUsage }, 120, plainTheme);
	assert.equal(lines.length, 5);
	assert.equal(lines[3], "✓ Read ×5 | ✓ PowerShell ×4 | ✓ Edit ×3");
	assert.deepEqual([...lines.slice(0, 3), lines[4]], renderClaudeFooter(view, 120, plainTheme));
	assert.doesNotMatch(lines[3], /Tools|12/);
	assert.equal(renderClaudeFooter({ ...view, toolUsage: { total: 20, counts: new Map([["read", 19], ["bash", 1]]) } }, 120, plainTheme)[3], "✓ Read ×19 | ✓ Bash ×1");
	assert.equal(renderClaudeFooter({ ...view, toolUsage: collectToolUsage() }, 120, plainTheme).length, 4);
	const theme = { fg: (_token, text) => `\x1b[32m${text}\x1b[0m` };
	const custom = { total: 1, counts: new Map([["自定义😀\n\x1b[31m工具", 1]]) };
	for (let width = 0; width <= 120; width++) {
		for (const line of renderClaudeFooter({ ...view, toolUsage: custom }, width, theme)) {
			assert.ok(visibleWidth(line) <= width);
			assert.doesNotMatch(stripTerminalSequences(line), /[\r\n]/);
		}
	}
});

test("incomplete native nested records are shown as a lower bound", () => {
	const toolUsage = collectToolUsage([{ type: "message", message: {
		role: "toolResult", toolName: "codemode", nestedCalls: { calls: [{ name: "read" }], complete: false },
	} }]);
	assert.equal(toolUsage.incomplete, true);
	assert.equal(renderClaudeFooter({ ...view, toolUsage }, 120, plainTheme)[3], "≥ ✓ Codemode ×1 | ✓ Read ×1");
});

test("tool markers use live theme colors and never mark failed or unfinished calls as successful", () => {
	const toolUsage = collectToolUsage([
		{ type: "message", message: { role: "toolResult", toolName: "read", isError: true } },
		{ type: "message", message: { role: "toolResult", toolName: "read" } },
		{ type: "message", message: { role: "toolResult", toolName: "codemode", nestedCalls: {
			calls: [{ name: "edit", status: "unfinished" }, { name: "write", status: "error" }, { name: "write", status: "unfinished" }], complete: false,
		} } },
	]);
	const theme = { fg: (token, text) => `<${token}>${text}</${token}>` };
	const row = renderClaudeFooter({ ...view, toolUsage, outputSpeed: 42.6 }, 1000, theme)[3];
	assert.match(row, /<error>✗<\/error> <muted>Read<\/muted> <dim>×2<\/dim>/);
	assert.match(row, /<error>✗<\/error> <muted>Write<\/muted>/);
	assert.match(row, /<warning>!<\/warning> <muted>Edit<\/muted>/);
	assert.match(row, /<success>✓<\/success> <muted>Codemode<\/muted>/);
	assert.match(row, /<dim> \| <\/dim>/);
	const lines = renderClaudeFooter({ ...view, toolUsage, outputSpeed: 42.6 }, 120, plainTheme);
	assert.match(lines[4], /↓200 · 42\.6 tok\/s/, "usage and speed remain together on the last line");
	assert.match(renderClaudeFooter({ ...view, toolUsage }, 1000, { fg: (_token, text) => text })[3], /✗ Read ×2/);
});

function response(output, durationMs, stopReason = "stop") {
	return { type: "message", message: { role: "assistant", usage: { output }, durationMs, stopReason } };
}

test("output speed weights successful response durations, excluding tools, failures and deferred work", () => {
	assert.equal(collectOutputSpeed([
		response(100, 1000, "toolUse"), response(300, 9000, "length"),
		response(999, 50_000, "error"), response(999, 50_000, "aborted"),
		response(999, 50_000, "pending"), response(999, undefined, "deferred"),
		{ type: "message", message: { role: "toolResult", usage: { output: 999 }, durationMs: 50_000 } },
		{ type: "compaction" }, { type: "message", message: { role: "user" } },
	]), 40, "use total tokens / total duration, not the mean of individual speeds");
	assert.equal(collectOutputSpeed([response(100, 1000), response(0, 1000)]), 50);
	assert.equal(collectOutputSpeed([response(426, 10_000)]), 42.6);
});

test("output speed hides missing or invalid data rather than showing a partial average", () => {
	assert.equal(collectOutputSpeed(), undefined);
	assert.equal(collectOutputSpeed([response(0, 1000)]), undefined);
	for (const output of [undefined, null, NaN, Infinity, -1, "100"]) {
		assert.equal(collectOutputSpeed([response(100, 1000), response(output, 1000)]), undefined);
	}
	for (const duration of [undefined, null, NaN, Infinity, -1, 0, "1000"]) {
		assert.equal(collectOutputSpeed([response(100, 1000), response(100, duration)]), undefined);
	}
});

test("output speed sits between output usage and cost without adding a row", () => {
	const lines = renderClaudeFooter({ ...view, outputSpeed: 42.64 }, 120, plainTheme);
	assert.equal(lines.length, 4);
	assert.equal(lines[3], "▶ ready · thinking high · ↑3.5k ↓200 · 42.6 tok/s · $0.0123 · ← 2 agents");
	for (const outputSpeed of [undefined, null, NaN, Infinity, -1, 0]) {
		assert.doesNotMatch(renderClaudeFooter({ ...view, outputSpeed }, 120, plainTheme)[3], /tok\/s/);
	}
	assert.doesNotMatch(renderClaudeFooter({ ...view, outputSpeed: 42.6, busy: true }, 120, plainTheme)[3], /tok\/s/);
	const theme = { fg: (_token, text) => `\x1b[32m${text}\x1b[0m` };
	for (let width = 0; width <= 120; width++) {
		for (const line of renderClaudeFooter({ ...view, outputSpeed: 42.6 }, width, theme)) {
			assert.ok(visibleWidth(line) <= width);
		}
	}
});

test("MCP count deduplicates namespaces and excludes hidden tools", () => {
	assert.equal(countMcpServers([
		{ name: "mcp__wordcraft__read" }, { name: "mcp__wordcraft__write" },
		{ name: "mcp__gridcraft__read" }, { name: "mcp__private__read", exposure: "hidden" },
		{ name: "other", namespace: { name: "mcp__wordcraft" } }, { name: "read" },
	]), 2);
	assert.equal(countMcpServers(), 0);
	assert.equal(countMcpServers([
		{ name: "mcp__with__underscores__run", namespace: { name: "mcp__with__underscores" } },
		{ name: "other", namespace: { name: "mcp__with__underscores" } },
	]), 1);
});

test("patched native footer reads live data, theme, busy state and resets on reload", async () => {
	const session = create();
	const agent = {
		state: { model: { name: "Live model" }, thinkingLevel: "low" },
		sessionManager: { getCwd: () => "/repo/project" },
		resourceLoader: { getAgentsFiles: () => ({ agentsFiles: [{ path: "/repo/AGENTS.md" }] }) },
		getAllTools: () => [{ name: "mcp__test__run" }],
	};
	const data = { getGitBranch: () => "main", getExtensionStatuses: () => new Map([["x", "plugin status"]]) };
	const footer = new FooterComponent(agent, data);
	footer.getSessionStats = () => ({ contextUsage: { percent: 42 }, usageTotals: view.usage });
	try {
		await session.emit("session_start");
		let lines = footer.render(120);
		assert.match(lines[0], /\[Live model\] \| project git:\(main\)/);
		assert.match(lines[1], /42%/);
		assert.equal(lines[2], "1 AGENTS.md | 1 MCPs");
		assert.match(lines[3], /ready.*plugin status/);
		await session.emit("before_agent_start");
		assert.doesNotMatch(footer.render(120)[3], /working|ready/);
		assert.match(footer.render(120)[3], /^thinking low/);
		await session.emit("agent_settled");
		assert.match(footer.render(120)[3], /ready/);
		agent.state.model.name = "Changed model";
		session.ctx.ui.theme = { fg: (_token, text) => `\x1b[33m${text}\x1b[0m` };
		lines = footer.render(120);
		assert.match(lines[0], /\x1b\[33m/);
		assert.match(stripTerminalSequences(lines[0]), /\[Changed model\]/);
		await session.emit("before_agent_start");
		await session.emit("session_start");
		assert.match(stripTerminalSequences(footer.render(120)[3]), /ready/);
	} finally { await session.emit("session_shutdown"); }
});

test("real native stats aggregate cached input, output and cost without replacing usage logic", async () => {
	const session = create();
	const entries = [{ type: "message", message: { role: "assistant", usage: {
		input: 100, output: 200, cacheRead: 300, cacheWrite: 400, cost: { total: 0.02 },
	} } }];
	const agent = {
		state: { model: { id: "test-model", contextWindow: 10000 }, thinkingLevel: "off" },
		sessionManager: {
			getCwd: () => "/repo", getEntryCount: () => entries.length,
			getSessionId: () => "test", getLeafId: () => "leaf", getEntries: () => entries,
		},
		getContextUsage: () => ({ percent: 10, tokens: 1000, contextWindow: 10000 }),
	};
	const footer = new FooterComponent(agent, {
		getGitBranch: () => null, getExtensionStatuses: () => new Map(),
	});
	try {
		await session.emit("session_start");
		const lines = footer.render(120);
		assert.match(lines[0], /^\[test-model\] \| repo \|/);
		assert.match(lines[1], /10%/);
		assert.match(lines[3], /↑800 ↓200 · \$0\.0200/);
		assert.equal(lines.join("\n").includes("NaN"), false);
	} finally { await session.emit("session_shutdown"); }
});

test("tool summary resets each run, retains settled results and avoids per-frame scans", async () => {
	const session = create();
	let entries = [{ type: "message", message: { role: "toolResult", toolName: "read" } }];
	let sessionId = "first";
	let scans = 0;
	const agent = {
		state: { model: { id: "test" } },
		sessionManager: {
			getCwd: () => "/repo", getEntryCount: () => entries.length,
			getSessionId: () => sessionId, getLeafId: () => entries.length,
			getEntries: () => { scans++; return entries; },
		},
		getContextUsage: () => ({ percent: 10 }),
	};
	session.ctx.sessionManager = agent.sessionManager;
	const footer = new FooterComponent(agent, {
		getGitBranch: () => null, getExtensionStatuses: () => new Map(),
	});
	try {
		await session.emit("session_start");
		assert.equal(footer.render(120).length, 4, "old session history is excluded");
		await session.emit("before_agent_start");
		entries.push({ type: "message", message: { role: "toolResult", toolName: "codemode", nestedCalls: {
			calls: [{ name: "edit" }, { name: "read" }], complete: true,
		} } });
		assert.equal(footer.render(120)[3], "✓ Codemode ×1 | ✓ Edit ×1 | ✓ Read ×1");
		const previous = scans;
		footer.render(100);
		footer.render(120);
		assert.equal(scans, previous, "unchanged run must reuse cached counts");

		await session.emit("before_agent_start");
		assert.equal(footer.render(120).length, 4, "new run resets even before entries change");
		entries.push({ type: "message", message: { role: "toolResult", toolName: "read", isError: true } });
		assert.equal(footer.render(120)[3], "✗ Read ×1");
		await session.emit("agent_end");
		entries.push({ type: "message", message: { role: "toolResult", toolName: "write" } });
		assert.equal(footer.render(120)[3], "✗ Read ×1 | ✓ Write ×1", "continuation before settlement stays in this run");
		await session.emit("agent_settled");
		assert.equal(footer.render(120)[3], "✗ Read ×1 | ✓ Write ×1");
		await session.commands.get("omp-footer").handler("off", session.ctx);
		await session.commands.get("omp-footer").handler("on", session.ctx);
		assert.equal(footer.render(120)[3], "✗ Read ×1 | ✓ Write ×1", "footer toggle does not reset the run");

		await session.emit("before_agent_start");
		assert.equal(footer.render(120).length, 4);
		entries.push({ type: "compaction" }, { type: "message", message: { role: "toolResult", toolName: "edit" } });
		assert.equal(footer.render(120)[3], "✓ Edit ×1");
		await session.emit("session_start");
		assert.equal(footer.render(120).length, 4, "reload clears current-run stats");
		entries = [];
		sessionId = "second";
		await session.emit("session_start");
		assert.equal(footer.render(120).length, 4, "new session must not inherit old counts");
	} finally { await session.emit("session_shutdown"); }
});

test("output speed appears only on settlement, stays stable and resets across runs and sessions", async () => {
	const session = create();
	const entries = [response(1000, 1000)];
	let scans = 0;
	const manager = {
		getCwd: () => "/repo", getEntryCount: () => entries.length,
		getEntries: () => { scans++; return entries; },
	};
	session.ctx.sessionManager = manager;
	const footer = new FooterComponent({ state: {}, sessionManager: manager }, {
		getGitBranch: () => null, getExtensionStatuses: () => new Map(),
	});
	// Keep native usage independent: the speed must not use the cumulative output total.
	footer.getSessionStats = () => ({ usageTotals: view.usage });
	const line = () => footer.render(120)[3];
	try {
		await session.emit("session_start");
		await session.emit("agent_settled");
		assert.doesNotMatch(line(), /tok\/s/, "history and idle settlement do not create speed");
		await session.emit("before_agent_start");
		entries.push(response(100, 1000, "toolUse"));
		assert.doesNotMatch(line(), /tok\/s/, "no intermediate speed while working");
		await session.emit("agent_end");
		entries.push(response(999, 60_000, "error"), response(326, 9000));
		assert.doesNotMatch(line(), /tok\/s/, "retries and continuations must settle first");
		const previous = scans;
		await session.emit("agent_settled");
		assert.equal(scans, previous + 1, "speed is collected once at settlement");
		assert.match(line(), /↓200 · 42\.6 tok\/s · \$/);
		entries.push(response(999, 1000));
		assert.match(line(), /42\.6 tok\/s/, "later entries do not change the finalized speed");
		await session.emit("agent_settled");
		assert.match(line(), /42\.6 tok\/s/, "duplicate settlement does not recalculate");
		await session.commands.get("omp-footer").handler("off", session.ctx);
		await session.commands.get("omp-footer").handler("on", session.ctx);
		assert.match(line(), /42\.6 tok\/s/, "toggle retains the last result");
		await session.emit("before_agent_start");
		assert.doesNotMatch(line(), /tok\/s/);
		entries.push(response(50, undefined));
		await session.emit("agent_settled");
		assert.doesNotMatch(line(), /tok\/s/, "missing native timing hides speed");
		await session.emit("before_agent_start");
		entries.push(response(100, 1000));
		await session.emit("agent_settled");
		assert.match(line(), /100\.0 tok\/s/);
		await session.emit("session_start");
		assert.doesNotMatch(line(), /tok\/s/, "reload or session switch clears speed");
	} finally { await session.emit("session_shutdown"); }
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
		nonTui.ctx.sessionManager = { getEntries() { throw new Error("non-TUI must not read speed data"); } };
		await nonTui.emit("before_agent_start");
		await nonTui.emit("agent_settled");
		assert.equal(FooterComponent.prototype.render, originalRender);
		await nonTui.emit("session_shutdown");
	}
});
