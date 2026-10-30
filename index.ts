/**
 * DeepSeek 账号 provider —— 把 DSH 里的「登录 DeepSeek 账号就能用 DeepSeek 模型、
 * 每天领额度」搬到 pi 里。
 *
 *   /login deepseek-account   登录（本机有 DSH 登录就直接复用，否则走浏览器 PKCE）
 *   /model                   选 deepseek-account/deepseek-flash 或 deepseek-v4-pro
 *   /deepseek                账号、余额、赠金状态
 *   /deepseek claim          立刻领取赠金（启动时每天自动领一次）
 *
 * 代码分工：
 *   constants.ts   地址、请求头、超时、开关
 *   platform.ts    平台接口（PKCE、资料、余额、赠金、注销）
 *   login.ts       登录流程（复用 DSH 登录 / 浏览器 PKCE + 本机回跳）
 *   dsh-import.ts  从 ~/.dsh/.credentials.yaml 读 DSH 的账号 token
 *   models.ts      模型目录（GET /models + 兜底目录）
 *   credential.ts  读 pi 存下来的凭据
 *   claim.ts       赠金领取 + 金额格式化
 *   commands.ts    /deepseek 系列命令
 *   state.ts       设备标识 + 每天只自动领一次的记账
 *
 * 推理走 pi 内置的 anthropic-messages 实现（DSH 用的也是 Messages 协议），
 * 只是把鉴权头换成 `x-dsh-auth-token`。
 */

import type { AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext, ProviderConfig } from "@earendil-works/pi-coding-agent";
import { AUTO_CLAIM_ENABLED, INFERENCE_BASE_URL, PROVIDER_ID, PROVIDER_NAME, TOKEN_HEADER } from "./constants.ts";
import { accountToken, readAccountCredential } from "./credential.ts";
import { claimBonuses, describeBonus, formatWallets } from "./claim.ts";
import { fallbackModels, fetchCatalog } from "./models.ts";
import { PlatformError } from "./platform.ts";
import { login, getApiKey, refreshToken } from "./login.ts";
import { localDayKey, readState, writeState } from "./state.ts";
import { registerCommands } from "./commands.ts";

/**
 * 401 说明账号 token 失效了（平台没有续期流程），换成一句能照着做的提示。
 * 其他错误原样返回，别把真实原因盖掉。
 */
function friendlyError(message: string): string {
	if (/401|authentication|unauthorized|invalid.*token|token.*invalid/i.test(message)) {
		return `DeepSeek 账号登录已失效，请重新执行 /login ${PROVIDER_ID}。（原始错误：${message}）`;
	}
	return message;
}

function errorStream(
	model: Model<never> | Model<any>,
	message: string,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();
	stream.push({
		type: "error",
		reason: "error",
		error: {
			role: "assistant",
			content: [],
			api: model.api,
			provider: model.provider,
			model: model.id,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "error",
			errorMessage: message,
			timestamp: Date.now(),
		},
	});
	stream.end();
	return stream;
}

/** 复用 pi 的 anthropic-messages 实现，只把鉴权头换成账号 token。 */
function streamDeepSeekAccount(
	model: Model<any>,
	context: TranscriptContext,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const token = options?.apiKey;
	if (typeof token !== "string" || token === "") {
		return errorStream(model, `未登录 DeepSeek 账号：先执行 /login ${PROVIDER_ID}。`);
	}

	const stream = createAssistantMessageEventStream();
	void (async () => {
		try {
			const inner = anthropicMessagesApi().streamSimple(
				{ ...model, baseUrl: model.baseUrl === "" ? INFERENCE_BASE_URL : model.baseUrl } as Model<"anthropic-messages">,
				context,
				{
					...options,
					// anthropic-messages 要求有 apiKey；平台只看 x-dsh-auth-token，两个都带上无害。
					apiKey: token,
					headers: { ...(options?.headers ?? {}), [TOKEN_HEADER]: token },
				},
			);
			for await (const event of inner) {
				if (event.type === "error") {
					stream.push({ ...event, error: { ...event.error, errorMessage: friendlyError(event.error.errorMessage) } });
					continue;
				}
				stream.push(event);
			}
			stream.end();
		} catch (error) {
			stream.push({
				type: "error",
				reason: "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: "error",
					errorMessage: friendlyError(error instanceof Error ? error.message : String(error)),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();
	return stream;
}

/**
 * 启动时领取赠金。
 *
 * 没有领取记录时每次启动都读一次（平台什么时候发赠金不确定，DSH 也是每次从
 * 账号界面读一次）；真的领到东西才弹提示，登录失效每天只提醒一次。
 */
async function autoClaim(ctx: ExtensionContext): Promise<void> {
	if (!AUTO_CLAIM_ENABLED) return;
	const today = localDayKey();
	const token = accountToken(readAccountCredential());
	if (token === undefined) return; // 没登录就不打扰（登录后的下一次启动会领）

	const signal = AbortSignal.timeout(20_000);
	try {
		const outcome = await claimBonuses(token, signal);
		if (outcome.bonuses.length === 0) return;
		const amountText = outcome.bonuses.map((bonus) => describeBonus(bonus)).join("；");
		if (outcome.failed === 0) {
			writeState({ lastClaimDay: today, lastClaimAt: new Date().toISOString(), lastClaimAmount: amountText });
		}
		if (ctx.mode !== "tui") return;
		const balance =
			outcome.summary === null
				? ""
				: `\n充值余额 ${formatWallets(outcome.summary.normal)}，赠金余额 ${formatWallets(outcome.summary.bonus)}`;
		ctx.ui.notify(
			`DeepSeek 账号领取到 ${outcome.acked} 笔赠金：${amountText}${outcome.failed === 0 ? "" : `（${outcome.failed} 笔确认失败）`}${balance}`,
			outcome.failed === 0 ? "info" : "warning",
		);
	} catch (error) {
		if (ctx.mode !== "tui") return;
		if (error instanceof PlatformError && error.code === "unauthorized" && readState().lastAuthWarnDay !== today) {
			writeState({ lastAuthWarnDay: today });
			ctx.ui.notify(`DeepSeek 账号登录已失效，赠金没能领取。重新执行 /login ${PROVIDER_ID}。`, "warning");
		}
	}
}

const providerConfig: ProviderConfig = {
	name: PROVIDER_NAME,
	baseUrl: INFERENCE_BASE_URL,
	api: "anthropic-messages",
	models: fallbackModels(),

	/** 目录来自平台的 GET /models；离线、未登录、失败都退回内置目录。 */
	async refreshModels(context) {
		const credential = context.credential;
		return fetchCatalog({
			token: credential?.type === "oauth" && typeof credential.access === "string" ? credential.access : undefined,
			signal: context.signal,
			force: context.force,
			allowNetwork: context.allowNetwork,
		});
	},

	oauth: {
		name: PROVIDER_NAME,
		isSubscription: true,
		login: (callbacks) => login(callbacks),
		refreshToken: (credentials, signal) => refreshToken(credentials, signal),
		getApiKey: (credentials) => getApiKey(credentials),
	},

	streamSimple: streamDeepSeekAccount,
};

export default function (pi: ExtensionAPI): void {
	pi.registerProvider(PROVIDER_ID, providerConfig);
	registerCommands(pi);
	pi.on("session_start", (_event, ctx) => {
		// 不阻塞启动：领取是后台动作，网络慢时最多丢一条提示。
		void autoClaim(ctx).catch(() => {});
	});
}
