import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";

const directory = mkdtempSync(join(tmpdir(), "omp-footer-icon-"));
process.env.PI_CODING_AGENT_DIR = directory;
const { registerFooterIcon, renderClaudeFooter, countMcpServers } = await import("../extensions/lib/footer-icon.js");
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
	const ctx = { mode, ui: {
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
	assert.match(working[3], /▶ working/);
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
		assert.match(footer.render(120)[3], /working/);
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
