import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CURSOR_MARKER, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { OmpEditor } from "../extensions/lib/editor.js";

const directory = mkdtempSync(join(tmpdir(), "omp-image-"));
const first = join(directory, "first.png");
const second = join(directory, "截图 two.jpg");
const document = join(directory, "notes.txt");
for (const path of [first, second, document]) writeFileSync(path, "fixture");
after(() => rmSync(directory, { recursive: true, force: true }));

function create() {
	return new OmpEditor(
		{ terminal: { rows: 40 }, requestRender() {} },
		{ borderColor: (text) => `\x1b[35m${text}\x1b[0m`, selectList: {} },
		{ matches: () => false },
		{ cwd: directory },
	);
}
const paste = (editor, text) => editor.handleInput(`\x1b[200~${text}\x1b[201~`);
const display = (editor, width = 100) => editor.render(width).map(stripTerminalSequences).join("\n");
const undo = (editor) => editor.handleInput("\x1f");

test("dropped image displays a Claude-style label while submission retains its actual path", () => {
	const editor = create();
	editor.focused = true;
	let submitted;
	editor.onSubmit = (text) => { submitted = text; };
	editor.setText("看看");
	paste(editor, first);
	assert.match(display(editor), /看看 \[Image #1\]/);
	assert.doesNotMatch(display(editor), /first\.png|\[paste/);
	assert.ok(editor.render(100).some((line) => line.includes(CURSOR_MARKER)));
	assert.equal(editor.getText(), `看看 ${first}`);
	assert.equal(editor.getExpandedText(), `看看 ${first}`);
	editor.handleInput("\r");
	assert.equal(submitted, `看看 ${first}`);
	assert.equal(editor.getText(), "");
	paste(editor, second);
	assert.match(display(editor), /\[Image #1\]/, "new input resets numbering");
});

test("multiple quoted files, clipboard lines and paths with spaces retain exact text", () => {
	for (const text of [`"${first}" "${second}"`, `${first}\n${second}`, `${first}\r\n${second}`]) {
		const editor = create();
		editor.insertTextAtCursor(text);
		assert.match(display(editor), /\[Image #1\]/);
		assert.match(display(editor), /\[Image #2\]/);
		assert.equal(editor.getExpandedText(), text.replace(/\r\n/g, "\n"));
		assert.equal(editor.getText(), text.replace(/\r\n/g, "\n"));
	}
	const editor = create();
	paste(editor, second);
	assert.match(display(editor), /\[Image #1\]/);
	assert.equal(editor.getText(), second);
});

test("fragmented bracketed paste and unbracketed path drops both work", () => {
	const editor = create();
	editor.handleInput(`\x1b[200~${first.slice(0, 10)}`);
	assert.equal(editor.getText(), "");
	editor.handleInput(`${first.slice(10)}\x1b[201~`);
	assert.match(display(editor), /\[Image #1\]/);
	editor.handleInput(`"${second}"`);
	assert.match(display(editor), /\[Image #2\]/);
	assert.equal(editor.getExpandedText(), `${first} "${second}"`);
});

test("labels remain atomic for cursor movement and deletion, with native undo restoring paths", () => {
	const editor = create();
	paste(editor, `"${first}" "${second}"`);
	editor.render(100);
	const end = editor.getCursor().col;
	editor.handleInput("\x1b[D");
	assert.equal(editor.getCursor().col, end - "[Image #2]".length);
	editor.handleInput("\x1b[3~");
	assert.doesNotMatch(display(editor), /\[Image #2\]/);
	assert.equal(editor.getExpandedText(), `"${first}" `);
	undo(editor);
	assert.equal(editor.getExpandedText(), `"${first}" "${second}"`);
	editor.handleInput("\x1b[F");
	editor.handleInput("\x7f");
	assert.doesNotMatch(display(editor), /\[Image #2\]/);
	undo(editor);
	assert.match(display(editor), /\[Image #2\]/);
	assert.equal(editor.getExpandedText(), `"${first}" "${second}"`);
	undo(editor);
	assert.equal(editor.getText(), "", "one undo removes the entire original drop");
});

test("deleting the first image renumbers remaining mappings without losing file associations", () => {
	const editor = create();
	paste(editor, `"${first}" "${second}"`);
	editor.handleInput("\x01");
	editor.handleInput("\x1b[C");
	editor.handleInput("\x7f");
	assert.match(display(editor), /\[Image #1\]/);
	assert.doesNotMatch(display(editor), /\[Image #2\]/);
	assert.equal(editor.getExpandedText(), ` "${second}"`);
});

test("image labels coexist with large text pastes and leave literal labels unchanged", () => {
	const editor = create();
	const long = "long text\n".repeat(12);
	paste(editor, long);
	paste(editor, first);
	assert.match(display(editor), /\[paste #1 \+13 lines\]/);
	assert.match(display(editor), /\[Image #2\]/);
	assert.equal(editor.getExpandedText(), long + first);
	editor.handleInput("\x01");
	editor.handleInput("\x1b[C");
	editor.handleInput("\x7f");
	assert.match(display(editor), /\[Image #1\]/);
	assert.equal(editor.getExpandedText(), first, "deleting a text paste also renumbers images safely");
	editor.setText("[Image #1] [paste #1]");
	assert.equal(editor.getExpandedText(), "[Image #1] [paste #1]");
	assert.equal(editor.getText(), "[Image #1] [paste #1]");
});

test("non-images, missing files, ordinary prose and shell commands are not collapsed", () => {
	for (const text of [document, join(directory, "missing.png"), "说明.png", `说明 ${first}`, "[Image #1]"]) {
		const editor = create();
		paste(editor, text);
		assert.equal(editor.getText(), text);
		assert.equal(editor.pastes.size, 0);
	}
	const editor = create();
	editor.setText("!cat ");
	paste(editor, first);
	assert.equal(editor.getText(), `!cat ${first}`);
	assert.doesNotMatch(display(editor), /\[Image/);
});

test("relative and shell-escaped local paths are recognized without changing submitted text", () => {
	for (const text of ["first.png", "./first.png", "截图\\ two.jpg"]) {
		const editor = create();
		paste(editor, text);
		assert.match(display(editor), /\[Image #1\]/);
		assert.equal(editor.getExpandedText(), text);
	}
});

test("narrow layouts stay within terminal columns and never expose internal paste labels", () => {
	const editor = create();
	editor.focused = true;
	editor.setText("你好😀 ");
	paste(editor, `"${first}" "${second}"`);
	editor.handleInput("\x1b[D");
	for (let width = 10; width <= 120; width++) {
		const lines = editor.render(width);
		for (const line of lines) assert.ok(visibleWidth(line) <= width, `overflow at ${width}`);
		assert.doesNotMatch(lines.map(stripTerminalSequences).join(""), /paste|first\.png|two\.jpg/);
	}
});

test("switching editors or restoring a dialog draft cannot lose image paths", () => {
	const editor = create();
	editor.setText("看看 ");
	paste(editor, first);
	const saved = editor.getText();
	const replacement = create();
	replacement.setText(saved);
	assert.equal(replacement.getExpandedText(), `看看 ${first}`);
	editor.setText(saved);
	assert.equal(editor.getExpandedText(), `看看 ${first}`);
	assert.doesNotMatch(editor.getText(), /\[paste/);
});
