import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { installToolUi } from "../extensions/tool-ui/runtime.js";
import { callSummary, outputText, plain, resultSummary } from "../extensions/tool-ui/format.js";
import { diffStats, parseDiff, renderDiffRows } from "../extensions/tool-ui/diff.js";

initTheme("dark");
const theme = { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text };
const originalRender = ToolExecutionComponent.prototype.render;
const originalMouse = ToolExecutionComponent.prototype.handleMouse;
const originalContainerRender = Container.prototype.render;
let patch;
afterEach(() => {
	patch?.dispose();
	delete globalThis[Symbol.for("pi.ccstyle.global-tool-render-patch")];
	assert.equal(ToolExecutionComponent.prototype.render, originalRender);
	assert.equal(ToolExecutionComponent.prototype.handleMouse, originalMouse);
	assert.equal(Container.prototype.render, originalContainerRender);
});

function install(options = {}) {
	patch = installToolUi({ theme: () => theme, hint: () => "click to show more", ...options });
	return patch;
}

function tool(name = "read", args = { path: "extensions/工具😀.js" }, options = {}) {
	const value = new ToolExecutionComponent(name, crypto.randomUUID(), args, { showImages: false }, options.definition, { requestRender() { value.renders++; } });
	value.renders = 0;
	if (!options.pending) value.updateResult({ content: [{ type: "text", text: "one\ntwo\nthree" }], isError: false, durationMs: 451, ...options.result });
	return value;
}

function click(component, y, width = 120) {
	const height = component.render(width).length;
	return component.handleMouse({ type: "click", button: "left", x: 2, y, width, height });
}

function plainLines(component, width = 120) {
	return component.render(width).map(stripTerminalSequences);
}

test("single tool is compact; clicking reveals input/output and collapses again", () => {
	install();
	const value = tool();
	assert.match(plainLines(value).join("\n"), /✓ Read extensions\/工具😀\.js/);
	assert.match(plainLines(value).join("\n"), /3 lines loaded · 451ms · click to show more/);
	assert.equal(value.render(120).length, 3);
	assert.equal(click(value, 1).handled, true);
	assert.equal(value.expanded, true);
	assert.match(plainLines(value).join("\n"), /Input[\s\S]*Output[\s\S]*one/);
	click(value, 1);
	assert.equal(value.expanded, false);
	assert.ok(value.renders >= 2);
});

test("groups are render-only projections and preserve native tool traversal", () => {
	install();
	const container = new Container();
	const a = tool("read");
	const b = tool("ls", { path: "extensions" });
	const spacer = new Spacer(1);
	const assistant = new AssistantMessageComponent();
	for (const value of [a, spacer, assistant, b]) container.addChild(value);
	const originalChildren = [...container.children];
	assert.match(plainLines(container).join("\n"), /Multiple Tools: 2 done · Read×1, Ls×1/);
	assert.match(plainLines(container).join("\n"), /├ ✓ Read[\s\S]*└ ✓ Ls/);
	assert.deepEqual(container.children, originalChildren);
	assert.equal(click(container, 1).handled, true);
	assert.ok(a.expanded && b.expanded);
	assert.match(plainLines(container).join("\n"), /Output/);
	// Pi 的原生 Ctrl+O 逐个 setExpanded；不需要认识虚拟分组。
	for (const value of container.children) if (value instanceof ToolExecutionComponent) value.setExpanded(false);
	assert.doesNotMatch(plainLines(container).join("\n"), /Output/);
	container.removeChild(b);
	assert.doesNotMatch(plainLines(container).join("\n"), /Multiple Tools/);
	container.clear();
	assert.deepEqual(container.render(120), []);
});

test("expanded group mouse events reach the correct child after resize", () => {
	install();
	const container = new Container();
	const a = tool();
	const b = tool("ls", { path: "src" });
	container.addChild(a); container.addChild(b);
	click(container, 1);
	const lines = plainLines(container, 60);
	const secondHeader = lines.findIndex((line) => line.includes("✓ Ls"));
	assert.ok(secondHeader > 1);
	assert.equal(click(container, secondHeader, 60).handled, true);
	assert.equal(a.expanded, true);
	assert.equal(b.expanded, false);
});

test("assistant text, unknown custom tools, edit and write are grouping boundaries", () => {
	install();
	for (const boundary of [new Text("Visible assistant text", 0, 0), tool("edit"), tool("write"), tool("custom")]) {
		const container = new Container();
		container.addChild(tool()); container.addChild(boundary); container.addChild(tool());
		assert.doesNotMatch(plainLines(container).join("\n"), /Multiple Tools:|Read: 2 done/);
	}
});

test("dynamic assistant visibility breaks a previously projected group", () => {
	install();
	const container = new Container();
	const assistant = new AssistantMessageComponent();
	container.addChild(tool()); container.addChild(assistant); container.addChild(tool());
	assert.match(plainLines(container).join("\n"), /Read: 2 done/);
	assistant.contentContainer.addChild(new Text("New text", 0, 0));
	assert.doesNotMatch(plainLines(container).join("\n"), /Read: 2 done/);
});

test("pending, failed, cancelled nested calls and codemode summaries", () => {
	install();
	const container = new Container();
	const pending = tool("ls", {}, { pending: true });
	const failed = tool("grep", {}, { result: { isError: true, content: [{ type: "text", text: "Permission denied" }] } });
	container.addChild(pending); container.addChild(failed);
	assert.match(plainLines(container).join("\n"), /1 running · 1 failed/);
	const code = tool("codemode", { code: "await tools.read({path:'test'});" }, { result: {
		content: [{ type: "text", text: "Script completed\nWall time 1.2 seconds\nOutput:\n" }, { type: "text", text: "hello\nworld" }],
		details: { calls: [{ name: "read", args: '{"path":"test"}', status: "ok", durationMs: 20 }, { name: "ls", args: "{}", status: "cancelled" }] },
	} });
	const output = plainLines(code).join("\n");
	assert.match(output, /├ ✓ Read test/);
	assert.match(output, /└ ⊘ Ls/);
	assert.match(output, /2 calls · 1 failed · 2 lines output/);
	assert.equal(outputText(code.result, "codemode"), "hello\nworld");
	assert.equal(resultSummary(failed), "Permission denied");
});

test("collapsed groups cap long runs and retain totals", () => {
	install();
	const container = new Container();
	for (let i = 0; i < 20; i++) container.addChild(tool());
	const output = plainLines(container).join("\n");
	assert.match(output, /Read: 20 done/);
	assert.match(output, /12 earlier calls/);
	assert.equal(container.render(120).length, 11);
});

test("width safety for CJK, emoji, tabs, ANSI and expanded output", () => {
	install();
	const value = tool("powershell", { command: "显示😀\tpath\nnext" }, { result: { content: [{ type: "text", text: "中文😀".repeat(80) + "\n\x1b[31mANSI\x1b[0m" }] } });
	for (const width of [0, 1, 2, 5, 10, 40, 80, 120]) {
		for (const expanded of [false, true]) {
			value.setExpanded(expanded);
			for (const line of value.render(width)) assert.ok(visibleWidth(line) <= width, `width ${width}: ${line}`);
		}
	}
	assert.equal(plain("a\x1b[2J\x00\r\nb"), "a\nb");
	assert.equal(callSummary("read", { path: "a", offset: null, limit: null }), "a");
	assert.equal(callSummary("read", { path: "a", offset: 0, limit: 20 }), "a (offset=0, limit=20)");
});

const details = { patch: "--- file\n+++ file\n@@ -1,3 +1,4 @@\n one\n-two\n+二😀\n+extra\n three\n@@ -10,1 +11,1 @@\n-ten\n+十一\n" };

test("actual edit patch yields correct line numbers, diff stats and split/unified layouts", () => {
	const rows = parseDiff(details);
	assert.deepEqual(diffStats(rows), { added: 3, removed: 2 });
	assert.deepEqual(rows[4], { kind: " ", old: 3, next: 4, text: "three" });
	assert.deepEqual(rows.at(-1), { kind: "+", old: undefined, next: 11, text: "十一" });
	for (const width of [1, 10, 80, 100, 120]) {
		const lines = renderDiffRows(rows, width, theme);
		for (const line of lines) assert.ok(visibleWidth(line) <= width);
		if (width >= 100) assert.match(lines[0], /old.*new/);
		else assert.ok(lines.some((line) => line.startsWith("-")));
	}
	install();
	const value = tool("edit", { path: "test" }, { result: { details } });
	assert.match(plainLines(value).join("\n"), /diff \+3 −2 split/);
	assert.match(plainLines(value, 80).join("\n"), /diff \+3 −2 unified/);
});

test("legacy diff, insertions/deletions and truncated previews expand without loss", () => {
	const rows = parseDiff({ diff: " 1 a\n-2 b\n+2 c\n+3 d\n 3 e\n    ...\n-9 z" });
	assert.deepEqual(rows[4], { kind: " ", old: 3, next: 4, text: "e" });
	assert.deepEqual(diffStats(rows), { added: 2, removed: 2 });
	const many = Array.from({ length: 40 }, (_, i) => ({ kind: "+", next: i + 1, text: "new" }));
	assert.equal(renderDiffRows(many, 80, theme).length, 21);
	assert.equal(renderDiffRows(many, 80, theme, true).length, 40);
});

test("images stay available in expanded cards and unknown renderers remain native", () => {
	install();
	const value = tool("read", {}, { result: { content: [{ type: "image", mimeType: "image/png", data: "" }] } });
	value.showImages = true;
	value.imageComponents = [{ render: () => ["[image rendered]"] }];
	assert.match(plainLines(value).join("\n"), /1 image/);
	assert.doesNotMatch(plainLines(value).join("\n"), /image rendered/);
	value.expanded = true;
	assert.match(plainLines(value).join("\n"), /image rendered/);
	const custom = tool("mcp__app__widget", {}, { definition: { renderShell: "self", renderCall: () => new Text("CUSTOM UI", 0, 0) } });
	assert.match(plainLines(custom).join("\n"), /CUSTOM UI/);
});

test("dispose, re-install and external ownership restore native rendering safely", () => {
	install();
	const value = tool();
	const bundled = plainLines(value).join("\n");
	patch.dispose();
	assert.notEqual(plainLines(value).join("\n"), bundled);
	install();
	assert.equal(plainLines(value).join("\n"), bundled);
	globalThis[Symbol.for("pi.ccstyle.global-tool-render-patch")] = { active: true };
	assert.notEqual(plainLines(value).join("\n"), bundled);
	delete globalThis[Symbol.for("pi.ccstyle.global-tool-render-patch")];
	assert.equal(plainLines(value).join("\n"), bundled);
	const old = patch;
	install();
	old.dispose();
	assert.equal(plainLines(value).join("\n"), bundled);
});

test("colored rendering remains within terminal columns at all tested widths", () => {
	const ansiTheme = {
		fg: (_token, text) => `\x1b[38;2;90;180;120m${text}\x1b[39m`,
		bg: (_token, text) => `\x1b[48;2;40;60;40m${text}\x1b[49m`,
		bold: (text) => `\x1b[1m${text}\x1b[22m`,
	};
	install({ theme: () => ansiTheme });
	const value = tool("edit", { path: "中文😀.js" }, { result: { details } });
	for (const width of [1, 10, 60, 120]) {
		value.expanded = true;
		for (const line of value.render(width)) assert.ok(visibleWidth(line) <= width);
	}
});

test("theme changes are reflected without retaining pre-colored strings", () => {
	let active = theme;
	install({ theme: () => active });
	const value = tool();
	assert.doesNotMatch(value.render(120).join("\n"), /NEW/);
	active = { ...theme, fg: (_token, text) => `NEW${text}` };
	assert.match(value.render(120).join("\n"), /NEW/);
});
