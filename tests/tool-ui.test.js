import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { homedir } from "node:os";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Spacer, Text, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { installToolUi } from "../extensions/tool-ui/runtime.js";
import { callSummary, displayPath, invalidateToolCache, outputText, plain, resultSummary } from "../extensions/tool-ui/format.js";
import { diffStats, parseDiff, renderDiffRows } from "../extensions/tool-ui/diff.js";
import * as themes from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

initTheme("dark");
const theme = { fg: (_token, text) => text, bg: (_token, text) => text, bold: (text) => text };
const originalRender = ToolExecutionComponent.prototype.render;
const originalMouse = ToolExecutionComponent.prototype.handleMouse;
const originalContainerRender = Container.prototype.render;
const originalUpdateDisplay = ToolExecutionComponent.prototype.updateDisplay;
let patch;
afterEach(() => {
	patch?.dispose();
	delete globalThis[Symbol.for("pi.ccstyle.global-tool-render-patch")];
	assert.equal(ToolExecutionComponent.prototype.render, originalRender);
	assert.equal(ToolExecutionComponent.prototype.handleMouse, originalMouse);
	assert.equal(Container.prototype.render, originalContainerRender);
	assert.equal(ToolExecutionComponent.prototype.updateDisplay, originalUpdateDisplay);
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
	assert.equal(plainLines(container)[1].trim(), "● Multiple Tools (2)");
	assert.doesNotMatch(plainLines(container).join("\n"), /Read×|Ls×/);
	assert.match(plainLines(container).join("\n"), /├ ✓ Read[\s\S]*└ ✓ Ls/);
	assert.deepEqual(container.children, originalChildren);
	assert.equal(click(container, 1).handled, true);
	assert.ok(a.expanded && b.expanded);
	assert.equal(plainLines(container)[1].trim(), "● Multiple Tools (2) · click to collapse");
	assert.match(plainLines(container).join("\n"), /Output/);
	// Pi 的原生 Ctrl+O 逐个 setExpanded；不需要认识虚拟分组。
	for (const value of container.children) if (value instanceof ToolExecutionComponent) value.setExpanded(false);
	assert.doesNotMatch(plainLines(container).join("\n"), /Output/);
	container.removeChild(b);
	assert.doesNotMatch(plainLines(container).join("\n"), /Multiple Tools/);
	container.clear();
	assert.deepEqual(container.render(120), []);
});

test("display paths abbreviate only the user's home directory with correct path boundaries", () => {
	assert.equal(displayPath("C:/Users/hy/.pi/docs/extensions.md", "C:\\Users\\hy"), "~/.pi/docs/extensions.md");
	assert.equal(displayPath("c:\\users\\HY\\docs\\中文😀.md", "C:/Users/hy/"), "~/docs/中文😀.md");
	assert.equal(displayPath("C:/Users/hy", "C:/Users/hy"), "~");
	assert.equal(displayPath("C:/Users/hy-other/file.md", "C:/Users/hy"), "C:/Users/hy-other/file.md");
	assert.equal(displayPath("D:/repo/file.md", "C:/Users/hy"), "D:/repo/file.md");
	assert.equal(displayPath("/home/hy/docs/file.md", "/home/hy"), "~/docs/file.md");
	assert.equal(displayPath("/home/HY/docs/file.md", "/home/hy"), "/home/HY/docs/file.md");
	assert.equal(displayPath("src/file.md", "/home/hy"), "src/file.md");
	assert.equal(displayPath(undefined, "/home/hy"), "");
	assert.equal(displayPath("C:/Users/hy/\x1b[31mdoc\nfile.md", "C:/Users/hy"), "~/doc file.md");
});

test("tool summaries shorten home paths and hide Read ranges, while expanded input stays complete", () => {
	install();
	const path = `${homedir().replace(/\\/g, "/")}/docs/extensions.md`;
	for (const name of ["read", "ls", "edit", "write"]) {
		assert.equal(callSummary(name, { path, offset: 1, limit: 450 }), "~/docs/extensions.md");
	}
	assert.equal(callSummary("read", JSON.stringify({ file_path: path, offset: 1, limit: 450 })), "~/docs/extensions.md");
	assert.equal(callSummary("find", { path, pattern: "*.md" }), "*.md in ~/docs/extensions.md");
	assert.equal(callSummary("grep", { path, pattern: "events" }), '"events" in ~/docs/extensions.md');
	const args = { path, offset: 1, limit: 450 };
	const value = tool("read", args);
	assert.match(plainLines(value).join("\n"), /Read ~\/docs\/extensions\.md/);
	assert.doesNotMatch(plainLines(value).join("\n"), /offset|limit/);
	value.setExpanded(true);
	const output = plainLines(value, 240).join("\n");
	assert.ok(output.includes(path), "expanded input must retain the full path");
	assert.match(output, /"offset": 1/);
	assert.match(output, /"limit": 450/);
	assert.deepEqual(args, { path, offset: 1, limit: 450 }, "display changes must not mutate tool arguments");
	const code = tool("codemode", {}, { result: { details: { calls: [
		{ name: "read", args: JSON.stringify(args), status: "ok" },
	] } } });
	assert.match(plainLines(code).join("\n"), /Read ~\/docs\/extensions\.md/);
	assert.doesNotMatch(plainLines(code).join("\n"), /offset=|limit=/);
});

test("codemode titles hide script previews without changing progress, results or expanded input", () => {
	install();
	const code = 'const results = await Promise.allSettled([\n  tools.read({ path: "package.json" })\n]);';
	const args = { code };
	assert.equal(callSummary("codemode", args), "");
	assert.equal(callSummary("codemode", JSON.stringify(args)), "");
	assert.equal(callSummary("codemode", { code: "await tools.ls({});" }), "");
	const value = tool("codemode", args, { pending: true });
	const pending = plainLines(value).join("\n");
	assert.match(pending, /Codemode/);
	assert.doesNotMatch(pending, /const results|Promise\.allSettled/);
	const result = { content: [{ type: "text", text: "package loaded" }], durationMs: 23, details: {
		calls: [{ name: "read", args: { path: "package.json" }, status: "ok", durationMs: 20 }],
	} };
	value.updateResult(result);
	const completed = plainLines(value);
	assert.equal(completed[1].trim(), "✓ Codemode");
	assert.match(completed.join("\n"), /Read package\.json/);
	assert.match(completed.join("\n"), /1 calls · 1 lines output · 23ms/);
	const group = new Container();
	group.addChild(value);
	group.addChild(tool("ls", { path: "." }));
	const grouped = plainLines(group).join("\n");
	assert.doesNotMatch(grouped, /const results|Promise\.allSettled/);
	assert.match(grouped, /Codemode 1 calls · 1 lines output/);
	value.setExpanded(true);
	const expanded = plainLines(value, 240).join("\n");
	assert.match(expanded, /Input[\s\S]*const results = await Promise\.allSettled\(\[/);
	assert.match(expanded, /Output[\s\S]*package loaded/);
	assert.equal(value.args, args);
	assert.equal(value.args.code, code);
	assert.equal(value.result, result);
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
		assert.doesNotMatch(plainLines(container).join("\n"), /Multiple Tools \(|Read \(2\)/);
	}
});

test("dynamic assistant visibility breaks a previously projected group", () => {
	install();
	const container = new Container();
	const assistant = new AssistantMessageComponent();
	container.addChild(tool()); container.addChild(assistant); container.addChild(tool());
	assert.equal(plainLines(container)[1].trim(), "● Read (2)");
	assistant.contentContainer.addChild(new Text("New text", 0, 0));
	assert.doesNotMatch(plainLines(container).join("\n"), /Read \(2\)/);
});

test("pending, failed, cancelled nested calls and codemode summaries", () => {
	install();
	const container = new Container();
	const pending = tool("ls", {}, { pending: true });
	const failed = tool("grep", {}, { result: { isError: true, content: [{ type: "text", text: "Permission denied" }] } });
	container.addChild(pending); container.addChild(failed);
	assert.equal(plainLines(container)[1].trim(), "● Multiple Tools (2) · 1 running · 1 failed");
	assert.doesNotMatch(plainLines(container)[1], /Ls×|Grep×/);
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
	assert.match(output, /Read \(20\)/);
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
	assert.equal(callSummary("read", { path: "a", offset: 0, limit: 20 }), "a");
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

test("collapsed diffs paint only visible rows and preserve exact split/unified previews", () => {
	for (const kinds of [
		Array(200).fill("+"),
		Array(200).fill("-"),
		[...Array(100).fill("-"), ...Array(100).fill("+")],
		Array.from({ length: 200 }, (_, i) => [" ", "-", "+", "+", "gap"][i % 5]),
	]) {
		let reads = 0;
		const rows = kinds.map((kind, i) => ({
			kind, old: kind === "+" ? undefined : i + 1, next: kind === "-" ? undefined : i + 1,
			get text() { reads++; return `中文😀 row ${i}`; },
		}));
		for (const width of [80, 120]) {
			reads = 0;
			const preview = renderDiffRows(rows, width, theme);
			assert.ok(reads <= 40, `width ${width} must not paint hidden rows: ${reads} text reads`);
			const full = renderDiffRows(rows, width, theme, true);
			assert.deepEqual(preview, [...full.slice(0, 20), `… ${full.length - 20} more rows`]);
			for (const line of preview) assert.ok(visibleWidth(line) <= width);
		}
	}
});

test("diff previews do not report hidden rows at the exact height limit", () => {
	for (const [width, count] of [[80, 20], [120, 19]]) {
		const rows = Array.from({ length: count }, (_, i) => ({ kind: "+", next: i + 1, text: "new" }));
		assert.equal(renderDiffRows(rows, width, theme).length, 20);
		assert.deepEqual(renderDiffRows(rows, width, theme), renderDiffRows(rows, width, theme, true));
	}
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

test("completed summaries reuse cleaned output, while partial results stay live", () => {
	let reads = 0;
	let text = "one\ntwo";
	const value = { toolName: "read", isPartial: false, result: {
		content: [{ type: "text", get text() { reads++; return text; } }],
	} };
	assert.equal(resultSummary(value), "2 lines loaded");
	assert.equal(resultSummary(value), "2 lines loaded");
	assert.equal(reads, 1);
	value.isPartial = true;
	text += "\nthree";
	assert.equal(resultSummary(value), "3 lines loaded");
	text += "\nfour";
	assert.equal(resultSummary(value), "4 lines loaded");
	value.isPartial = false;
	assert.equal(resultSummary(value), "4 lines loaded");
	const previous = reads;
	assert.equal(resultSummary(value), "4 lines loaded");
	assert.equal(reads, previous);
	text = "replaced";
	invalidateToolCache(value);
	assert.equal(resultSummary(value), "1 line loaded");
});

test("completed cards reuse layout and cleaned output across redraws and width changes", () => {
	install();
	let reads = 0;
	const value = tool("read", { path: "example.txt" }, { result: {
		content: [{ type: "text", get text() { reads++; return "one\ntwo\nthree"; } }],
	} });
	const first = value.render(120);
	const previous = reads;
	assert.equal(value.render(120), first, "unchanged cards reuse the rendered array");
	assert.equal(value.render(120), first);
	assert.equal(reads, previous, "redraws must not rescan output");
	assert.notEqual(value.render(60), first, "width changes rebuild layout");
	assert.equal(reads, previous, "width changes reuse width-independent output summaries");
	value.setExpanded(true);
	const beforeExpanded = reads;
	const expanded = value.render(120);
	const expandedReads = reads;
	assert.equal(expandedReads, beforeExpanded + 1, "summary and expanded output share one cleanup pass");
	assert.match(expanded.join("\n"), /Output[\s\S]*one/);
	assert.equal(value.render(120), expanded);
	assert.equal(reads, expandedReads, "expanded output is not rewrapped every frame");
});

test("native updates and invalidation refresh caches even when objects are reused", () => {
	install();
	const value = tool("read", { path: "old.txt" });
	value.render(120);
	value.args.path = "new.txt";
	value.updateArgs(value.args);
	assert.match(plainLines(value).join("\n"), /Read new\.txt/);
	value.result.content[0].text = "changed";
	value.updateResult(value.result);
	assert.match(plainLines(value).join("\n"), /1 line loaded/);
	value.result.content[0].text = "changed\nagain";
	value.invalidate();
	assert.match(plainLines(value).join("\n"), /2 lines loaded/);
	const edit = tool("edit", {}, { result: { details: { patch: "@@ -1 +1 @@\n-old\n+new" } } });
	assert.match(plainLines(edit).join("\n"), /diff \+1 −1/);
	edit.result.details.patch += "\n+extra";
	edit.updateResult(edit.result);
	assert.match(plainLines(edit).join("\n"), /diff \+2 −1/);
	const before = value.render(120);
	value.setOutputPad(3);
	assert.notEqual(value.render(120), before);
	assert.ok(value.render(120)[1].startsWith("   "));
	patch.dispose();
	value.result.content[0].text = "after disposal";
	value.updateResult(value.result);
	install();
	assert.match(plainLines(value).join("\n"), /1 line loaded/);
});

test("cached cards follow live hints and same-object theme color updates", () => {
	let hint = "first hint";
	let mode = "first mode";
	const active = { ...theme, colors: {}, getColorMode: () => mode,
		fg: (_token, text) => `${mode}:${text}`,
	};
	install({ theme: () => active, hint: () => hint });
	const value = tool();
	const first = value.render(160);
	assert.equal(value.render(160), first);
	hint = "updated hint";
	assert.match(value.render(160).join("\n"), /updated hint/);
	mode = "second mode";
	assert.match(value.render(160).join("\n"), /second mode:/);
	const before = value.render(160);
	active.colors = {};
	assert.notEqual(value.render(160), before, "terminal color updates may keep the same Theme instance");
	active.fg = (_token, text) => `NEW:${text}`;
	assert.match(value.render(160).join("\n"), /NEW:/);
});

test("real Theme terminal color updates invalidate cached cards without replacing the theme", () => {
	install({ theme: () => themes.theme });
	const value = tool();
	try {
		const active = themes.theme;
		const first = value.render(120);
		assert.equal(value.render(120), first);
		themes.setTerminalColors({ background: { r: 20, g: 30, b: 40 } });
		assert.equal(themes.theme, active);
		assert.notEqual(value.render(120), first);
		const dark = value.render(120);
		initTheme("light");
		assert.notDeepEqual(value.render(120), dark);
	} finally {
		themes.setTerminalColors({});
		initTheme("dark");
	}
});

test("running and partial cards keep animating and showing fresh output", (t) => {
	install();
	let now = 0;
	t.mock.method(Date, "now", () => now);
	const value = tool("read", {}, { pending: true });
	const first = value.render(120).join("\n");
	now = 90;
	assert.notEqual(value.render(120).join("\n"), first);
	const result = { content: [{ type: "text", text: "one" }] };
	value.updateResult(result, true);
	assert.match(plainLines(value).join("\n"), /1 line loaded/);
	result.content[0].text += "\ntwo";
	assert.match(plainLines(value).join("\n"), /2 lines loaded/);
	value.updateResult(result);
	const finished = value.render(120);
	now = 180;
	assert.equal(value.render(120), finished);
	assert.match(finished.join("\n"), /✓ Read/);
});

test("cached text never freezes native images or unfinished nested-call spinners", (t) => {
	install();
	const image = tool();
	image.expanded = true;
	image.showImages = true;
	let frame = 0;
	image.imageComponents = [{ render: () => [`image frame ${++frame}`] }];
	assert.match(image.render(120).join("\n"), /image frame 1/);
	assert.match(image.render(120).join("\n"), /image frame 2/);
	let now = 0;
	t.mock.method(Date, "now", () => now);
	const code = tool("codemode", {}, { result: { details: { calls: [{ name: "read", args: {}, status: "running" }] } } });
	const first = code.render(120).join("\n");
	now = 90;
	assert.notEqual(code.render(120).join("\n"), first);
});

test("theme changes are reflected without retaining pre-colored strings", () => {
	let active = theme;
	install({ theme: () => active });
	const value = tool();
	assert.doesNotMatch(value.render(120).join("\n"), /NEW/);
	active = { ...theme, fg: (_token, text) => `NEW${text}` };
	assert.match(value.render(120).join("\n"), /NEW/);
});
