/**
 * 模型目录。
 *
 * DSH 的账号路由用 `GET https://api.deepseek.com/models`（带 x-dsh-auth-token）拿目录，
 * 返回里除了 OpenAI 风格的字段，还有 DeepSeek 自己的扩展：
 *
 *   context_window / max_output_tokens / input_modalities
 *   effort: { supported_levels: ["low","high","max"], default_level: "high" }
 *   api_capabilities.anthropic_messages: { system_prompt_update, tool_update }
 *
 * 这里把它翻译成 pi 的 ProviderModelConfig：思考档位映射到 output_config.effort，
 * 走 pi 内置的 anthropic-messages 实现（forceAdaptiveThinking）。
 */

import type { ProviderModelConfig } from "@earendil-works/pi-coding-agent";
import { CATALOG_TTL_MS, CATALOG_URL, TOKEN_HEADER } from "./constants.ts";

/** 拿不到目录时的兜底（和 DSH 内置默认目录一致）。 */
export function fallbackModels(): ProviderModelConfig[] {
	return [
		{
			id: "deepseek-flash",
			name: "DeepSeek-V4.1-Flash",
			reasoning: true,
			input: ["text", "image"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 393_216,
			thinkingLevelMap: { minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
			compat: { forceAdaptiveThinking: true },
		},
		{
			id: "deepseek-v4-pro",
			name: "DeepSeek-V4-Pro",
			reasoning: true,
			input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 1_048_576,
			maxTokens: 393_216,
			thinkingLevelMap: { minimal: "low", low: "low", medium: "high", high: "high", xhigh: "max", max: "max" },
			compat: { forceAdaptiveThinking: true },
		},
	];
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function asPositiveInt(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.trunc(value) : undefined;
}

/** pi 的思考档位 → 平台 supported_levels 里最接近的一档。 */
function mapThinkingLevels(levels: string[], defaultLevel: string | undefined): ProviderModelConfig["thinkingLevelMap"] {
	const pool = levels.filter((level) => level !== "off");
	if (pool.length === 0) return undefined;
	const pick = (preferences: string[]): string => {
		for (const level of preferences) if (pool.includes(level)) return level;
		return defaultLevel !== undefined && pool.includes(defaultLevel) ? defaultLevel : (pool[pool.length - 1] as string);
	};
	return {
		minimal: pick(["minimal", "low", "medium", "high", "max"]),
		low: pick(["low", "minimal", "medium", "high", "max"]),
		medium: pick(["medium", "high", "low", "max"]),
		high: pick(["high", "medium", "max", "low"]),
		xhigh: pick(["xhigh", "max", "high", "medium"]),
		max: pick(["max", "xhigh", "high", "medium"]),
	};
}

function modelFromListing(entry: unknown): ProviderModelConfig | undefined {
	const value = asRecord(entry);
	const id = asString(value.id);
	if (id === undefined) return undefined;

	const modalities = Array.isArray(value.input_modalities)
		? value.input_modalities.filter((item): item is "text" | "image" => item === "text" || item === "image")
		: [];
	const input = modalities.length > 0 ? modalities : (["text"] as ("text" | "image")[]);

	const effort = asRecord(value.effort);
	const levels = Array.isArray(effort.supported_levels)
		? effort.supported_levels.filter((item): item is string => typeof item === "string")
		: [];
	const defaultLevel = asString(effort.default_level);

	return {
		id,
		name: asString(value.name) ?? id,
		reasoning: levels.length > 0,
		input,
		// 账号按钱包计费，平台不给单价；真实花费看 /deepseek 报的余额。
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: asPositiveInt(value.context_window) ?? 1_048_576,
		maxTokens: asPositiveInt(value.max_output_tokens) ?? 65_536,
		...(levels.length === 0 ? {} : { thinkingLevelMap: mapThinkingLevels(levels, defaultLevel) }),
		compat: { forceAdaptiveThinking: true },
	};
}

let cached: { at: number; models: ProviderModelConfig[] } | undefined;

/**
 * 拉取远程目录。
 *
 * 失败/未登录/离线都退回内置目录：模型选择器不该因为一次网络抖动就空掉。
 * 结果进程内缓存 CATALOG_TTL_MS。
 */
export async function fetchCatalog(credentials: {
	token: string | undefined;
	signal: AbortSignal;
	force?: boolean;
	allowNetwork: boolean;
}): Promise<ProviderModelConfig[]> {
	if (!credentials.allowNetwork) return cached?.models ?? fallbackModels();
	if (
		credentials.force !== true &&
		cached !== undefined &&
		Date.now() - cached.at < CATALOG_TTL_MS
	) {
		return cached.models;
	}

	const token = credentials.token;
	if (token === undefined || token === "") return cached?.models ?? fallbackModels();

	let payload: unknown;
	try {
		const response = await fetch(CATALOG_URL, {
			method: "GET",
			headers: { accept: "application/json", [TOKEN_HEADER]: token },
			redirect: "error",
			signal: credentials.signal,
		});
		if (!response.ok) return cached?.models ?? fallbackModels();
		payload = (await response.json()) as unknown;
	} catch {
		return cached?.models ?? fallbackModels();
	}

	const list = asRecord(payload);
	const entries = Array.isArray(list.data) ? list.data : Array.isArray(payload) ? payload : [];
	const models = entries
		.map((entry) => modelFromListing(entry))
		.filter((model): model is ProviderModelConfig => model !== undefined);
	if (models.length === 0) return cached?.models ?? fallbackModels();

	cached = { at: Date.now(), models };
	return models;
}
