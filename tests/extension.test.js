import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, beforeEach, test } from "node:test";

// 在加载 Pi 配置模块前隔离 agent 目录，测试绝不修改用户的真实配置。
const agentDir = mkdtempSync(join(tmpdir(), "omp-extension-"));
process.env.PI_CODING_AGENT_DIR = agentDir;
const settingsPath = join(agentDir, "extension-settings", "omp-editor.json");
const { default: extension, OmpEditor } = await import("../extensions/omp-editor.js");
const { FooterComponent, ToolExecutionComponent } = await import("@earendil-works/pi-coding-agent");
const originalRender = ToolExecutionComponent.prototype.render;
const originalFooterRender = FooterComponent.prototype.render;
beforeEach(() => rmSync(settingsPath, { force: true }));
after(() => rmSync(agentDir, { recursive: true, force: true }));

function mock(mode) {
	const events = new Map();
	const commands = new Map();
	const notifications = [];
	let editor;
	let editorInstance;
	let footer;
	let renders = 0;
	let sessionName;
	const branch = [];
	const titleRequests = [];
	const tui = { terminal: { rows: 30 }, requestRender() { renders++; } };
	const ctx = {
		mode,
		isIdle: () => true,
		model: { id: "test-model" },
		modelRegistry: {
			streamSimple(model, context, options) {
				titleRequests.push({ model, context, options });
				return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: "AI 概括的会话标题" }] }) };
			},
		},
		sessionManager: { getEntries: () => [], getBranch: () => branch, getSessionId: () => "test-session" },
		ui: {
			theme: { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text },
			notify: (text) => notifications.push(text),
			setStatus() {},
			onTerminalInput: () => () => {},
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
		getSessionName: () => sessionName,
		setSessionName: (name) => { sessionName = name; },
		on(name, handler) { if (!events.has(name)) events.set(name, []); events.get(name).push(handler); },
		registerCommand(name, command) { commands.set(name, command); },
		appendEntry() {},
	});
	return {
		ctx, commands, notifications, branch, titleRequests,
		setSessionName(name) { sessionName = name; },
		get editor() { return editorInstance; },
		get footer() { return footer; },
		get renders() { return renders; },
		async emit(name, event = { systemPromptOptions: { sections: {} } }) {
			for (const handler of events.get(name) ?? []) await handler(event, ctx);
		},
	};
}

test("entry point re-exports the standalone editor component", async () => {
	const { OmpEditor: component } = await import("../extensions/lib/editor.js");
	assert.equal(OmpEditor, component);
});

test("all features stay enabled across reloads without UI switch commands or settings writes", async () => {
	for (let reload = 0; reload < 2; reload++) {
		const session = mock("tui");
		try {
			assert.deepEqual([...session.commands.keys()], ["omp-mode"]);
			await session.emit("session_start");
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.notEqual(ToolExecutionComponent.prototype.render, originalRender);
			assert.notEqual(FooterComponent.prototype.render, originalFooterRender);
			assert.ok(session.editor instanceof OmpEditor);
			assert.equal(session.footer, undefined, "custom footers are left untouched");
			await session.emit("input", { text: "需要优化工具分组和状态栏的显示", source: "interactive" });
			assert.doesNotMatch(session.editor.render(200)[0], /需要优化/);
			session.branch.push(
				{ type: "message", message: { role: "user", content: "需要优化工具分组和状态栏的显示" } },
				{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "已调整工具分组和状态栏。" }] } },
			);
			await session.emit("before_agent_start");
			await session.emit("agent_settled");
			await new Promise((resolve) => setImmediate(resolve));
			assert.match(session.editor.render(200)[0], /本轮 .*会话累计 .*AI 概括的会话标题/);
			assert.equal(session.titleRequests.length, 1);
			assert.match(session.titleRequests[0].context.messages[0].content, /已调整工具分组和状态栏/);
			assert.deepEqual(session.notifications, []);
			assert.equal(existsSync(settingsPath), false, "no settings file is created");
		} finally {
			await session.emit("session_shutdown");
			assert.equal(session.ctx.ui.getEditorComponent(), undefined);
			assert.equal(ToolExecutionComponent.prototype.render, originalRender);
			assert.equal(FooterComponent.prototype.render, originalFooterRender);
		}
	}
});

test("legacy false settings cannot disable features and are not rewritten", async () => {
	mkdirSync(join(agentDir, "extension-settings"), { recursive: true });
	const settings = `${JSON.stringify({ enabled: false, toolsEnabled: false, doneEnabled: false, footerIconEnabled: false, autoTitle: false, future: 42 }, null, 2)}\n`;
	writeFileSync(settingsPath, settings);
	const session = mock("tui");
	try {
		await session.emit("session_start");
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(session.editor instanceof OmpEditor);
		assert.notEqual(ToolExecutionComponent.prototype.render, originalRender);
		assert.notEqual(FooterComponent.prototype.render, originalFooterRender);
		await session.emit("input", { text: "旧配置不再生效", source: "interactive" });
		session.branch.push(
			{ type: "message", message: { role: "user", content: "旧配置不再生效" } },
			{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "所有功能已启用。" }] } },
		);
		await session.emit("before_agent_start");
		await session.emit("agent_settled");
		await new Promise((resolve) => setImmediate(resolve));
		assert.match(session.editor.render(200)[0], /本轮 .*会话累计 .*AI 概括的会话标题/);
		assert.equal(session.titleRequests.length, 1);
	} finally {
		await session.emit("session_shutdown");
	}
	assert.equal(readFileSync(settingsPath, "utf8"), settings);
});

test("non-TUI sessions never install terminal UI or create settings", async () => {
	for (const mode of ["rpc", "json", "print"]) {
		const session = mock(mode);
		try {
			await session.emit("session_start");
			await session.emit("input", { text: "不应调用模型", source: "interactive" });
			await session.emit("before_agent_start");
			await session.emit("agent_settled");
			assert.deepEqual(session.titleRequests, []);
			assert.equal(ToolExecutionComponent.prototype.render, originalRender);
			assert.equal(FooterComponent.prototype.render, originalFooterRender);
			assert.equal(session.ctx.ui.getEditorComponent(), undefined);
			assert.equal(session.footer, undefined);
			assert.deepEqual(session.notifications, []);
			assert.equal(existsSync(settingsPath), false);
		} finally { await session.emit("session_shutdown"); }
	}
});

test("deferred installation restores the editor after reload resets the UI", async () => {
	const session = mock("tui");
	try {
		await session.emit("session_start");
		session.ctx.ui.setEditorComponent(undefined);
		await new Promise((resolve) => setTimeout(resolve, 5));
		assert.ok(session.editor instanceof OmpEditor);
	} finally { await session.emit("session_shutdown"); }
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(session.ctx.ui.getEditorComponent(), undefined);
});

test("shutdown cancels deferred installation and restores the previous editor", async () => {
	const session = mock("tui");
	const previousFactory = () => ({ render: () => ["previous editor"] });
	session.ctx.ui.setEditorComponent(previousFactory);
	try {
		await session.emit("session_start");
		assert.ok(session.editor instanceof OmpEditor);
	} finally { await session.emit("session_shutdown"); }
	await new Promise((resolve) => setTimeout(resolve, 5));
	assert.equal(session.ctx.ui.getEditorComponent(), previousFactory);
	assert.equal(ToolExecutionComponent.prototype.render, originalRender);
	assert.equal(FooterComponent.prototype.render, originalFooterRender);
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
		await session.emit("before_agent_start");
		assert.doesNotMatch(session.editor.render(200)[0], /本轮|tokens/);
		await session.emit("agent_settled");
		await session.emit("session_start");
		assert.doesNotMatch(session.editor.render(200)[0], /本轮|tokens/);
	} finally {
		await session.emit("session_shutdown");
		assert.equal(session.footer, undefined);
	}
});

test("a background AI title requests a redraw after completion statistics are already visible", async () => {
	const session = mock("tui");
	const deferred = Promise.withResolvers();
	session.ctx.modelRegistry.streamSimple = () => ({ result: () => deferred.promise });
	try {
		await session.emit("session_start");
		await new Promise((resolve) => setTimeout(resolve, 5));
		await session.emit("input", { text: "登录后状态丢失", source: "interactive" });
		session.branch.push(
			{ type: "message", message: { role: "user", content: "登录后状态丢失" } },
			{ type: "message", message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "已修复。" }] } },
		);
		await session.emit("before_agent_start");
		await session.emit("agent_settled");
		assert.match(session.editor.render(200)[0], /本轮 .*会话累计/);
		assert.doesNotMatch(session.editor.render(200)[0], /修复登录状态/);
		const renders = session.renders;
		deferred.resolve({ stopReason: "stop", content: [{ type: "text", text: "修复登录状态" }] });
		await new Promise((resolve) => setImmediate(resolve));
		assert.ok(session.renders > renders);
		assert.match(session.editor.render(200)[0], /本轮 .*会话累计 .*修复登录状态/);
		assert.deepEqual(session.notifications, []);
	} finally { await session.emit("session_shutdown"); }
});

test("editor displays the live session name and updates it across naming and session changes", async () => {
	const session = mock("tui");
	try {
		session.setSessionName("优化工具分组和状态栏");
		await session.emit("session_start");
		assert.match(session.editor.render(160)[0], /优化工具分组和状态栏/);
		session.setSessionName("另一个会话");
		assert.match(session.editor.render(160)[0], /另一个会话/);
		assert.doesNotMatch(session.editor.render(160)[0], /优化工具/);
		await session.emit("before_agent_start");
		await session.emit("agent_settled");
		assert.match(session.editor.render(160)[0], /本轮.*另一个会话/);
		session.setSessionName(undefined);
		await session.emit("session_start");
		assert.doesNotMatch(session.editor.render(160)[0], /另一个会话/);
	} finally { await session.emit("session_shutdown"); }
});

test("completion falls back to notifications when another extension replaces the editor", async () => {
	const session = mock("tui");
	const otherFactory = () => ({ render: () => ["other editor"] });
	try {
		await session.emit("session_start");
		await new Promise((resolve) => setTimeout(resolve, 5));
		session.ctx.ui.setEditorComponent(otherFactory);
		await session.emit("before_agent_start");
		await session.emit("agent_settled");
		assert.match(session.notifications.at(-1), /本轮 .*会话累计 .*s$/);
		assert.doesNotMatch(session.notifications.at(-1), /tokens|输入|输出|\$/);
	} finally { await session.emit("session_shutdown"); }
	assert.equal(session.ctx.ui.getEditorComponent(), otherFactory, "shutdown leaves the other editor alone");
});

test("external footers are left alone on startup, reload and shutdown", async () => {
	const session = mock("tui");
	try {
		session.ctx.ui.setFooter(() => ({ render: () => ["other extension"], invalidate() {} }));
		await session.emit("session_start");
		assert.deepEqual(session.footer.render(120), ["other extension"]);
		await session.emit("session_start");
		assert.deepEqual(session.footer.render(120), ["other extension"]);
		await session.emit("session_shutdown");
		assert.deepEqual(session.footer.render(120), ["other extension"]);
	} finally { await session.emit("session_shutdown"); }
});

test("an active ccstyle renderer is left alone regardless of startup order", async () => {
	const key = Symbol.for("pi.ccstyle.global-tool-render-patch");
	for (const late of [false, true]) {
		const session = mock("tui");
		try {
			if (!late) globalThis[key] = { active: true };
			await session.emit("session_start");
			if (late) globalThis[key] = { active: true };
			await new Promise((resolve) => setTimeout(resolve, 5));
			assert.equal(ToolExecutionComponent.prototype.render, originalRender);
			assert.ok(session.editor instanceof OmpEditor);
		} finally {
			await session.emit("session_shutdown");
			delete globalThis[key];
		}
	}
});
