import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { OmpEditor } from "../extensions/lib/editor.js";

const summary = "本轮 29s · 会话累计 3m 39s";
function create(getCompletion = () => summary, getSessionTitle = () => "") {
	return new OmpEditor(
		{ terminal: { rows: 30 }, requestRender() {} },
		{ borderColor: (text) => `\x1b[35m${text}\x1b[0m`, selectList: {} },
		{ matches: () => false },
		{ getCompletion, getSessionTitle },
	);
}

test("completion is centered in the existing top border without adding rows", () => {
	const editor = create();
	const blank = create(() => "");
	for (const width of [160, 180, 200, 240]) {
		const lines = editor.render(width);
		const top = stripTerminalSequences(lines[0]);
		assert.ok(top.startsWith("╭"));
		assert.ok(top.endsWith("─"));
		assert.ok(top.includes(summary));
		const start = top.indexOf(summary);
		const left = visibleWidth(top.slice(0, start));
		const right = visibleWidth(top.slice(start + summary.length));
		assert.ok(Math.abs(left - right) <= 1, `not centered at width ${width}: ${left}/${right}`);
		assert.equal(visibleWidth(lines[0]), width);
		assert.equal(lines.length, blank.render(width).length);
	}
});

test("completion handles narrow widths, resizing, ANSI, Chinese and emoji within terminal columns", () => {
	const editor = create(() => `\x1b[32m${summary} 中文😀\x1b[0m`);
	for (const width of [10, 20, 30, 40, 60, 80, 100, 120, 200, 40, 180]) {
		const lines = editor.render(width);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `overflow at ${width}: ${visibleWidth(line)}`);
		assert.equal(visibleWidth(lines[0]), width);
	}
	assert.match(stripTerminalSequences(editor.render(20)[0]), /…/);
	assert.match(stripTerminalSequences(editor.render(200)[0]), /中文😀/);
});

test("completion respects current theme colors and preserves the focused input/IME cursor", () => {
	let color = "32";
	const editor = create(() => `\x1b[${color}m${summary}\x1b[0m`);
	editor.focused = true;
	editor.setText("你好😀");
	const lines = editor.render(180);
	assert.ok(lines[0].includes("\x1b[32m"));
	assert.ok(lines.some((line) => line.includes(CURSOR_MARKER)));
	assert.match(stripTerminalSequences(lines.at(-1)), /你好😀/);
	color = "36";
	editor.invalidate();
	assert.ok(editor.render(180)[0].includes("\x1b[36m"));
	assert.ok(!editor.render(180)[0].includes("\x1b[32m"));
});

test("session title sits on the right without shifting centered timing or adding rows", () => {
	const title = "优化工具分组和状态栏";
	const editor = create(() => summary, () => title);
	const blank = create();
	for (const width of [120, 160, 200, 240]) {
		const lines = editor.render(width);
		const top = stripTerminalSequences(lines[0]);
		const original = stripTerminalSequences(blank.render(width)[0]);
		assert.ok(top.includes(title));
		assert.equal(top.indexOf(summary), original.indexOf(summary), "timing stays at the same column");
		assert.ok(visibleWidth(top.slice(0, top.indexOf(title))) >= width / 2);
		assert.ok(top.endsWith(" ──"));
		assert.equal(visibleWidth(top), width);
		assert.equal(lines.length, blank.render(width).length);
	}
});

test("session title reads live names, strips controls, truncates safely and follows border colors", () => {
	let title = "";
	const editor = create(() => "", () => title);
	const original = editor.render(160)[0];
	title = "First title";
	assert.match(stripTerminalSequences(editor.render(160)[0]), /First title/);
	title = "新会话😀\n\x1b[31m标题\t\x07";
	const top = editor.render(160)[0];
	assert.match(stripTerminalSequences(top), /新会话😀 标题/);
	assert.doesNotMatch(top, /\x1b\[31m|[\n\t\x07]/);
	assert.match(top, /\x1b\[35m 新会话😀 标题/);
	title = "长标题中文😀".repeat(30);
	for (let width = 7; width <= 180; width++) {
		const line = editor.render(width)[0];
		assert.equal(visibleWidth(line), width);
	}
	assert.match(stripTerminalSequences(editor.render(80)[0]), /…/);
	title = undefined;
	assert.equal(editor.render(160)[0], original, "unnamed sessions retain the original border");
});

test("title yields to timing, working status and scroll indicators on constrained layouts", () => {
	const title = "RIGHT TITLE";
	const editor = create(() => summary, () => title);
	assert.doesNotMatch(stripTerminalSequences(editor.render(30)[0]), /RIGHT/);
	assert.equal(editor.render(30)[0], create().render(30)[0]);
	const working = create(() => "", () => title);
	working.setWorkingStatusIndicator({ renderInBorder: () => "working", renderSpinnerInBorder: () => "●" });
	assert.match(stripTerminalSequences(working.render(120)[0]), /working.*RIGHT TITLE/);
	assert.match(stripTerminalSequences(working.render(20)[0]), /working/);
	working.setText(Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"));
	assert.match(stripTerminalSequences(working.render(120)[0]), /↑/);
	assert.doesNotMatch(stripTerminalSequences(working.render(120)[0]), /RIGHT TITLE/);
});

test("native working and multiline scroll indicators remain available", () => {
	let message = "";
	const editor = create(() => message);
	editor.setWorkingStatusIndicator({
		renderInBorder: () => "working",
		renderSpinnerInBorder: () => "●",
	});
	assert.match(stripTerminalSequences(editor.render(120)[0]), /working/);
	message = summary;
	assert.match(stripTerminalSequences(editor.render(180)[0]), /本轮/);
	editor.setText(Array.from({ length: 30 }, (_, index) => `line ${index}`).join("\n"));
	const lines = editor.render(120);
	assert.match(stripTerminalSequences(lines[0]), /↑/);
	assert.doesNotMatch(stripTerminalSequences(lines[0]), /本轮/);
	for (const line of lines) assert.ok(visibleWidth(line) <= 120);
});
