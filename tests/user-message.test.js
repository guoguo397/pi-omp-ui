import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { UserMessageComponent, initTheme } from "@earendil-works/pi-coding-agent";
import { backgroundAnsi, mixColors, rgbColor, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import * as themes from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { installUserMessageStyle, registerUserMessageStyle } from "../extensions/lib/user-message.js";

const originalRender = UserMessageComponent.prototype.render;
let patch;
afterEach(() => {
	patch?.dispose();
	globalThis[Symbol.for("pi.omp-ui.user-message-style")]?.dispose();
	UserMessageComponent.prototype.render = originalRender;
	themes.setTerminalColors({});
	initTheme("dark");
});

test("sent user message background is mixed 20% toward the terminal, without altering content or layout", () => {
	themes.setTerminalColors({ background: { r: 10, g: 12, b: 15 } });
	initTheme("dark");
	const theme = themes.theme;
	const message = new UserMessageComponent("文字 😀 **bold**\n\n```js\nconst a = 1;\n```\n\n[link](https://example.com)");
	const before = message.render(80);
	const source = theme.getBgAnsi("userMessageBg");
	assert.ok(before.some((line) => line.includes(source)));
	const expected = backgroundAnsi(mixColors(theme.colors.userMessageBg, rgbColor(10, 12, 15), 0.2, "srgb"), theme.getColorMode());
	assert.notEqual(expected, source);
	patch = installUserMessageStyle(() => themes.theme);
	const after = message.render(80);
	assert.deepEqual(after, before.map((line) => line.replaceAll(source, expected)));
	assert.deepEqual(after.map(stripTerminalSequences), before.map(stripTerminalSequences));
	assert.match(after[0], /^\x1b\]133;A\x07/);
	assert.match(after.at(-1), /\x1b\]133;B\x07\x1b\]133;C\x07/);
	assert.equal(theme.getBgAnsi("userMessageBg"), source, "the shared theme must not be modified");
	for (const width of [1, 5, 20, 80]) {
		const native = originalRender.call(message, width);
		const styled = message.render(width);
		assert.deepEqual(styled.map(visibleWidth), native.map(visibleWidth), "background styling must not change native widths");
	}
	patch.dispose();
	assert.deepEqual(message.render(80), before, "dispose restores even already rendered messages");
});

test("background follows theme and terminal changes, including light themes", () => {
	patch = installUserMessageStyle(() => themes.theme);
	for (const [name, rgb] of [["dark", { r: 0, g: 0, b: 0 }], ["light", { r: 255, g: 255, b: 255 }], ["dark", { r: 24, g: 28, b: 32 }]]) {
		themes.setTerminalColors({ background: rgb });
		initTheme(name);
		const theme = themes.theme;
		const message = new UserMessageComponent("test");
		const before = originalRender.call(message, 40);
		const source = theme.getBgAnsi("userMessageBg");
		const expected = backgroundAnsi(mixColors(theme.colors.userMessageBg, rgbColor(rgb.r, rgb.g, rgb.b), 0.2, "srgb"), theme.getColorMode());
		assert.deepEqual(message.render(40), before.map((line) => line.replaceAll(source, expected)));
	}
});

test("default backgrounds and unsupported theme APIs are left unchanged", () => {
	initTheme("dark");
	const message = new UserMessageComponent("test");
	const before = message.render(40);
	for (const theme of [{}, { getBgAnsi: () => "\x1b[49m", getColorMode: () => "truecolor" }]) {
		patch = installUserMessageStyle(() => theme);
		assert.deepEqual(message.render(40), before);
	}
});

test("patch is reload-safe and does not overwrite later external renderers on disposal", () => {
	initTheme("dark");
	const first = installUserMessageStyle(() => themes.theme);
	patch = installUserMessageStyle(() => themes.theme);
	const installedRender = UserMessageComponent.prototype.render;
	first.dispose();
	assert.equal(UserMessageComponent.prototype.render, installedRender);
	const external = function () { return ["external"]; };
	UserMessageComponent.prototype.render = external;
	patch.dispose();
	assert.equal(UserMessageComponent.prototype.render, external);
});

test("registration is TUI-only and restores the native renderer on shutdown", async () => {
	for (const mode of ["tui", "rpc", "json", "print"]) {
		const handlers = new Map();
		registerUserMessageStyle({ on: (name, handler) => handlers.set(name, handler) });
		const ctx = { mode, ui: { theme: themes.theme } };
		await handlers.get("session_start")({}, ctx);
		assert.equal(UserMessageComponent.prototype.render === originalRender, mode !== "tui");
		await handlers.get("session_start")({}, ctx);
		await handlers.get("session_shutdown")({}, ctx);
		await handlers.get("session_shutdown")({}, ctx);
		assert.equal(UserMessageComponent.prototype.render, originalRender);
	}
});
