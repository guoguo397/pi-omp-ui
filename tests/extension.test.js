import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// 在加载 Pi 配置模块前隔离 agent 目录，测试绝不修改用户的真实配置。
const agentDir = mkdtempSync(join(tmpdir(), "omp-extension-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: extension } = await import("../extensions/omp-editor.js");
const { readSettings } = await import("../extensions/lib/settings.js");
const { ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
const originalRender = ToolExecutionComponent.prototype.render;

function mock(mode) {
	const events = new Map();
	const commands = new Map();
	const notifications = [];
	let editor;
	const ctx = {
		mode,
		sessionManager: { getEntries: () => [] },
		ui: {
			theme: { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text },
			notify: (text) => notifications.push(text),
			getEditorComponent: () => editor,
			setEditorComponent: (factory) => { editor = factory; },
			setWidget(_name, factory) { factory?.({ requestRender() {} }); },
		},
	};
	extension({
		on(name, handler) { if (!events.has(name)) events.set(name, []); events.get(name).push(handler); },
		registerCommand(name, command) { commands.set(name, command); },
	});
	return { ctx, commands, notifications, async emit(name) { for (const handler of events.get(name) ?? []) await handler({}, ctx); } };
}

test("entry point registers all three features, persists independent switches and cleans up reloads", async () => {
	try {
		const first = mock("tui");
		await first.emit("session_start");
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.notEqual(ToolExecutionComponent.prototype.render, originalRender);
		assert.ok(first.ctx.ui.getEditorComponent());
		await first.commands.get("omp-tools").handler("off", first.ctx);
		assert.equal(ToolExecutionComponent.prototype.render, originalRender);
		assert.ok(first.ctx.ui.getEditorComponent());
		await first.commands.get("omp-editor").handler("off", first.ctx);
		assert.equal(readSettings().enabled, false);
		assert.equal(readSettings().toolsEnabled, false);
		await first.emit("before_agent_start");
		await first.emit("agent_settled");
		assert.match(first.notifications.at(-1), /本次 .*会话累计 .*tokens 0/);
		await first.commands.get("omp-done").handler("off", first.ctx);
		assert.equal(readSettings().doneEnabled, false);
		await first.commands.get("omp-tools").handler("on", first.ctx);
		assert.equal(readSettings().enabled, false);
		assert.equal(readSettings().toolsEnabled, true);
		assert.equal(readSettings().doneEnabled, false);
		assert.equal(first.ctx.ui.getEditorComponent(), undefined);
		await first.emit("session_shutdown");
		assert.equal(ToolExecutionComponent.prototype.render, originalRender);

		const reloaded = mock("tui");
		await reloaded.emit("session_start");
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.notEqual(ToolExecutionComponent.prototype.render, originalRender);
		assert.equal(reloaded.ctx.ui.getEditorComponent(), undefined);
		await reloaded.commands.get("omp-done").handler("status", reloaded.ctx);
		assert.match(reloaded.notifications.at(-1), /disabled/);
		const count = reloaded.notifications.length;
		await reloaded.emit("agent_settled");
		assert.equal(reloaded.notifications.length, count);
		await reloaded.emit("session_shutdown");
		assert.equal(ToolExecutionComponent.prototype.render, originalRender);

		for (const mode of ["rpc", "json", "print"]) {
			const nonTui = mock(mode);
			await nonTui.emit("session_start");
			assert.equal(ToolExecutionComponent.prototype.render, originalRender);
			assert.equal(nonTui.ctx.ui.getEditorComponent(), undefined);
			await nonTui.emit("session_shutdown");
		}
	} finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("an active ccstyle renderer is left alone regardless of startup order", async () => {
	const key = Symbol.for("pi.ccstyle.global-tool-render-patch");
	try {
		for (const late of [false, true]) {
			if (!late) globalThis[key] = { active: true };
			const session = mock("tui");
			await session.emit("session_start");
			if (late) globalThis[key] = { active: true };
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(ToolExecutionComponent.prototype.render, originalRender);
			await session.commands.get("omp-tools").handler("status", session.ctx);
			assert.match(session.notifications.at(-1), /yielding to pi-cc-extensions/);
			await session.emit("session_shutdown");
			delete globalThis[key];
		}
	} finally { delete globalThis[key]; rmSync(agentDir, { recursive: true, force: true }); }
});
