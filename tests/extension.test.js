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
	let editorInstance;
	let footer;
	let renders = 0;
	const tui = { terminal: { rows: 30 }, requestRender() { renders++; } };
	const ctx = {
		mode,
		sessionManager: { getEntries: () => [] },
		ui: {
			theme: { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text },
			notify: (text) => notifications.push(text),
			getEditorComponent: () => editor,
			setEditorComponent: (factory) => {
				editor = factory;
				editorInstance = factory?.(tui, { borderColor: (text) => text, selectList: {} }, { matches: () => false });
			},
			setFooter: (factory) => {
				footer?.dispose?.();
				footer = factory?.(tui);
			},
			setWidget(_name, factory) { factory?.({ requestRender() {} }); },
		},
	};
	extension({
		on(name, handler) { if (!events.has(name)) events.set(name, []); events.get(name).push(handler); },
		registerCommand(name, command) { commands.set(name, command); },
	});
	return {
		ctx, commands, notifications,
		get editor() { return editorInstance; },
		get footer() { return footer; },
		get renders() { return renders; },
		async emit(name) { for (const handler of events.get(name) ?? []) await handler({}, ctx); },
	};
}

test("entry point registers all three features, persists independent switches and cleans up reloads", async () => {
	try {
		const first = mock("tui");
		await first.emit("session_start");
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.notEqual(ToolExecutionComponent.prototype.render, originalRender);
		assert.ok(first.ctx.ui.getEditorComponent());
		assert.equal(first.footer, undefined, "footer is left untouched");
		await first.commands.get("omp-tools").handler("off", first.ctx);
		assert.equal(ToolExecutionComponent.prototype.render, originalRender);
		assert.ok(first.ctx.ui.getEditorComponent());
		await first.commands.get("omp-editor").handler("off", first.ctx);
		assert.equal(readSettings().enabled, false);
		assert.equal(readSettings().toolsEnabled, false);
		assert.equal(first.footer, undefined, "turning off the editor leaves the footer alone");
		await first.emit("before_agent_start");
		await first.emit("agent_settled");
		assert.match(first.notifications.at(-1), /本轮 .*会话累计 .*s$/);
		assert.doesNotMatch(first.notifications.at(-1), /tokens|输入|输出|\$/);
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
			assert.equal(nonTui.footer, undefined);
			await nonTui.emit("session_shutdown");
		}
	} finally { rmSync(agentDir, { recursive: true, force: true }); }
});

test("completion is rendered in the editor border without duplicate notifications", async () => {
	const session = mock("tui");
	try {
		await session.emit("session_start");
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(session.footer, undefined, "footer is left untouched");
		assert.doesNotMatch(session.editor.render(200)[0], /本轮/);
		await session.emit("before_agent_start");
		const previousRenders = session.renders;
		await session.emit("agent_settled");
		assert.match(session.editor.render(200)[0], /本轮 .*会话累计/);
		assert.doesNotMatch(session.editor.render(200)[0], /tokens|输入|输出|\$/);
		assert.deepEqual(session.notifications, [], "embedded stats must not also notify");
		assert.ok(session.renders > previousRenders, "settlement requests a redraw");

		await session.commands.get("omp-done").handler("off", session.ctx);
		assert.doesNotMatch(session.editor.render(200)[0], /本轮|会话累计/);
		assert.equal(session.footer, undefined, "done switch leaves the footer alone");
		await session.commands.get("omp-done").handler("on", session.ctx);
		assert.match(session.editor.render(200)[0], /本轮 .*会话累计/);
		await session.emit("before_agent_start");
		assert.doesNotMatch(session.editor.render(200)[0], /本轮|tokens/);
		await session.emit("agent_settled");
		await session.emit("session_start");
		assert.doesNotMatch(session.editor.render(200)[0], /本轮|tokens/);
	} finally {
		await session.emit("session_shutdown");
		assert.equal(session.footer, undefined);
		rmSync(agentDir, { recursive: true, force: true });
	}
});

test("external footers are left alone on startup, toggle and shutdown", async () => {
	const session = mock("tui");
	try {
		await session.emit("session_start");
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.equal(session.footer, undefined);
		session.ctx.ui.setFooter(() => ({ render: () => ["other extension"], invalidate() {} }));
		await session.commands.get("omp-editor").handler("off", session.ctx);
		assert.deepEqual(session.footer.render(120), ["other extension"]);
		await session.commands.get("omp-editor").handler("on", session.ctx);
		assert.deepEqual(session.footer.render(120), ["other extension"]);
		await session.emit("session_shutdown");
		assert.deepEqual(session.footer.render(120), ["other extension"]);
	} finally {
		await session.emit("session_shutdown");
		rmSync(agentDir, { recursive: true, force: true });
	}
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
