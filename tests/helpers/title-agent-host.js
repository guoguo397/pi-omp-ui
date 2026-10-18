// 仅模拟供应商注册表与流式响应；测试运行真实 Pi Agent，不访问网络或用户配置。
export function titleResponse(text = "AI 概括的会话标题", stopReason = "stop") {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		stopReason,
		model: "deepseek-flash",
		provider: "deepseek",
		api: "openai-completions",
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		timestamp: Date.now(),
	};
}

export function createTitleAgentHost({ result = () => titleResponse(), available = true } = {}) {
	const lookups = [];
	const requests = [];
	const model = { id: "deepseek-flash", provider: "deepseek", api: "openai-completions", reasoning: true };
	const modelRegistry = {
		find(provider, modelId) {
			lookups.push({ provider, modelId });
			return available && provider === model.provider && modelId === model.id ? model : undefined;
		},
		streamSimple(selectedModel, context, options) {
			if (selectedModel !== model) throw new Error("title generation must never fall back to the parent model");
			const request = { model: selectedModel, context: structuredClone(context), options, signal: options.signal };
			requests.push(request);
			// 故意不响应 AbortSignal，以验证调用方即使面对迟到结果也能取消并释放任务。
			const message = Promise.resolve().then(() => result(request));
			return {
				result: () => message,
				async *[Symbol.asyncIterator]() {
					const answer = await message;
					yield { type: ["error", "aborted"].includes(answer.stopReason) ? "error" : "done", message: answer };
				},
			};
		},
	};
	return {
		modelRegistry, lookups, requests,
		setResult(next) { result = next; },
		setAvailable(next) { available = next; },
	};
}
