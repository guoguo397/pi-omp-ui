import assert from "node:assert/strict";
import { test } from "node:test";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { OmpEditor } from "../extensions/omp-editor.js";

const summary = "本轮 29s · 会话累计 3m 39s";
function create(getCompletion = () => summary) {
	return new OmpEditor(
		{ terminal: { rows: 30 }, requestRender() {} },
		{ borderColor: (text) => `\x1b[35m${text}\x1b[0m`, selectList: {} },
		{ matches: () => false },
		{ getCompletion },
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
