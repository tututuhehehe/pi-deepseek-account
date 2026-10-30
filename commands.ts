/**
 * 斜杠命令：
 *
 *   /deepseek            账号、余额、赠金状态
 *   /deepseek claim      立刻领取（读取 + 确认）未领取的赠金
 *   /deepseek balance    只看余额
 *   /deepseek login      提示怎么登录
 *   /deepseek logout     注销云端 token / 删除本地凭据
 */

import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { AUTO_CLAIM_ENABLED, INFERENCE_BASE_URL, PROVIDER_ID } from "./constants.ts";
import {
	accountToken,
	describeAccount,
	describeLoginSource,
	readAccountCredential,
	type StoredAccountCredential,
} from "./credential.ts";
import {
	claimBonuses,
	describeBonus,
	describeBonusOrder,
	formatWallets,
	sortBonusOrders,
	type ClaimOutcome,
} from "./claim.ts";
import {
	PlatformError,
	fetchBonusOrders,
	fetchProfile,
	fetchSummary,
	revokeToken,
	type AccountProfile,
	type BonusOrder,
} from "./platform.ts";
import { localDayKey, readState, writeState } from "./state.ts";

const SIGN_IN_HINT = "未登录 DeepSeek 账号。执行 /login deepseek-account 登录（本机开着 DeepSeek Harness 时会直接复用它的登录）。";
const REQUEST_TIMEOUT_MS = 20_000;

function timeoutSignal(): AbortSignal {
	return AbortSignal.timeout(REQUEST_TIMEOUT_MS);
}

function describeError(error: unknown): string {
	if (error instanceof PlatformError) return error.message;
	if (error instanceof Error) return error.message;
	return String(error);
}

function isUnauthorized(error: unknown): boolean {
	return error instanceof PlatformError && error.code === "unauthorized";
}

/** 账号行：昵称（脱敏联系方式）。 */
function accountLine(credential: StoredAccountCredential, profile: AccountProfile | null): string {
	const name = profile?.name ?? credential.account?.name ?? undefined;
	const contact = profile?.contact ?? credential.account?.contact ?? undefined;
	if (name !== undefined && contact !== undefined) return `账号: ${name}（${contact}）`;
	if (name !== undefined) return `账号: ${name}`;
	if (contact !== undefined) return `账号: ${contact}`;
	return `账号: ${describeAccount(credential)}`;
}

export async function showStatus(ctx: ExtensionCommandContext, options: { balanceOnly?: boolean } = {}): Promise<void> {
	const credential = readAccountCredential();
	const token = accountToken(credential);
	if (credential === undefined || token === undefined) {
		ctx.ui.notify(SIGN_IN_HINT, "warning");
		return;
	}

	const lines: string[] = [];
	let profile: AccountProfile | null = null;
	try {
		profile = await fetchProfile(token, timeoutSignal());
	} catch (error) {
		if (isUnauthorized(error)) {
			ctx.ui.notify(`${describeError(error)}\n本地凭据还能用 /logout ${PROVIDER_ID} 删除。`, "warning");
			return;
		}
		// 资料读不到不算故障：余额才是用户要的。
	}
	if (!options.balanceOnly) {
		lines.push(`DeepSeek 账号: 已登录`);
		lines.push(accountLine(credential, profile));
		lines.push(`登录方式: ${describeLoginSource(credential.loginSource)}${credential.loginAt === undefined ? "" : `（${credential.loginAt}）`}`);
	}

	try {
		const summary = await fetchSummary(token, timeoutSignal());
		lines.push(`充值余额: ${formatWallets(summary.normal)}`);
		lines.push(`赠金余额: ${formatWallets(summary.bonus)}`);
	} catch (error) {
		lines.push(isUnauthorized(error) ? `余额: 登录已失效，请重新 /login ${PROVIDER_ID}` : `余额: 查询失败（${describeError(error)}）`);
	}

	if (!options.balanceOnly) {
		const orders = await loadBonusOrders(token);
		if (orders !== undefined) {
			if (orders.length === 0) lines.push("赠金记录: 平台没有给这个账号发过赠金");
			else {
				const sorted = sortBonusOrders(orders);
				const active = sorted.filter((order) => order.status === "ACTIVE");
				lines.push(`赠金记录: 共 ${orders.length} 笔，其中 ${active.length} 笔可用`);
				for (const order of active) lines.push(`  · ${describeBonusOrder(order)}`);
				const inactive = orders.length - active.length;
				if (inactive > 0) lines.push(`  其余 ${inactive} 笔已失效，明细见 /deepseek bonuses`);
			}
		}
	}

	const state = readState();
	if (!options.balanceOnly) {
		lines.push(
			state.lastClaimDay === undefined
				? "上次领取: 还没有领取记录"
				: `上次领取: ${state.lastClaimDay}${state.lastClaimAmount === undefined ? "" : `（${state.lastClaimAmount}）`}`,
		);
		lines.push(`自动领取: ${AUTO_CLAIM_ENABLED ? "每天启动时自动领取一次" : "已关闭（DEEPSEEK_ACCOUNT_AUTO_CLAIM=0）"}`);
		lines.push(`推理地址: ${INFERENCE_BASE_URL}`);
	}
	ctx.ui.notify(lines.join("\n"), "info");
}

/** 读赠金账单；失败不打断状态展示。 */
async function loadBonusOrders(token: string): Promise<BonusOrder[] | undefined> {
	try {
		return await fetchBonusOrders(token, timeoutSignal());
	} catch {
		return undefined;
	}
}

/** /deepseek bonuses：完整赠金账单（活动名、金额、发放时间、到期时间、状态）。 */
export async function showBonuses(ctx: ExtensionCommandContext): Promise<void> {
	const token = accountToken(readAccountCredential());
	if (token === undefined) {
		ctx.ui.notify(SIGN_IN_HINT, "warning");
		return;
	}
	let orders: BonusOrder[];
	try {
		orders = await fetchBonusOrders(token, timeoutSignal());
	} catch (error) {
		ctx.ui.notify(
			isUnauthorized(error) ? describeError(error) : `赠金记录查询失败：${describeError(error)}`,
			isUnauthorized(error) ? "warning" : "error",
		);
		return;
	}
	if (orders.length === 0) {
		ctx.ui.notify("平台还没有给这个账号发过赠金。", "info");
		return;
	}
	const lines = [`赠金账单（共 ${orders.length} 笔）:`];
	for (const order of sortBonusOrders(orders)) {
		const when = order.insertedAt.slice(0, 19).replace("T", " ");
		lines.push(`${when}  ${describeBonusOrder(order)}`);
	}
	const active = orders.filter((order) => order.status === "ACTIVE");
	if (active.length > 0) {
		lines.push("说明: 赠金有有效期，过期作废；扣费时平台先用赠金、后用充值余额。");
	}
	ctx.ui.notify(lines.join(String.fromCharCode(10)), "info");
}

/** 领取并把结果说清楚；返回值给自动领取复用。 */
export async function runClaim(ctx: ExtensionCommandContext, options: { force: boolean }): Promise<ClaimOutcome | undefined> {
	const credential = readAccountCredential();
	const token = accountToken(credential);
	if (credential === undefined || token === undefined) {
		ctx.ui.notify(SIGN_IN_HINT, "warning");
		return undefined;
	}

	let outcome: ClaimOutcome;
	try {
		outcome = await claimBonuses(token, timeoutSignal());
	} catch (error) {
		ctx.ui.notify(
			isUnauthorized(error) ? describeError(error) : `领取失败：${describeError(error)}`,
			isUnauthorized(error) ? "warning" : "error",
		);
		return undefined;
	}

	const today = localDayKey();
	if (outcome.bonuses.length === 0) {
		writeState({ lastClaimDay: today, lastClaimAt: new Date().toISOString(), lastClaimAmount: undefined });
		ctx.ui.notify(
			`今天没有新的赠金。${outcome.summary === null ? "" : `\n充值余额: ${formatWallets(outcome.summary.normal)}\n赠金余额: ${formatWallets(outcome.summary.bonus)}`}`,
			"info",
		);
		return outcome;
	}

	const amountText = outcome.bonuses.map((bonus) => describeBonus(bonus)).join("；");
	if (outcome.failed === 0) {
		writeState({
			lastClaimDay: today,
			lastClaimAt: new Date().toISOString(),
			lastClaimAmount: amountText,
			lastClaimAccount: credential.account?.id ?? undefined,
		});
	} else if (options.force) {
		writeState({ lastClaimAt: new Date().toISOString(), lastClaimAmount: amountText });
	}

	const lines = [
		`已领取 ${outcome.acked} 笔赠金：${amountText}`,
		...(outcome.failed === 0 ? [] : [`有 ${outcome.failed} 笔确认失败，下次启动会再试。`]),
		...(outcome.summary === null
			? []
			: [`充值余额: ${formatWallets(outcome.summary.normal)}`, `赠金余额: ${formatWallets(outcome.summary.bonus)}`]),
	];
	const orders = await loadBonusOrders(token);
	const expiring = (orders ?? []).filter((order) => order.status === "ACTIVE" && order.expiresAt !== null);
	if (expiring.length > 0) lines.push(`赠金有效期: ${describeBonusOrder(expiring[0] as BonusOrder)}`);
	ctx.ui.notify(lines.join("\n"), outcome.failed === 0 ? "info" : "warning");
	return outcome;
}

export async function signOut(ctx: ExtensionCommandContext): Promise<void> {
	const credential = readAccountCredential();
	const token = accountToken(credential);
	if (token === undefined) {
		ctx.ui.notify(`本机没有 DeepSeek 账号凭据。`, "info");
		return;
	}
	let remote = "unknown";
	try {
		await revokeToken(token, timeoutSignal());
		remote = "ok";
	} catch {
		remote = "failed";
	}
	ctx.ui.notify(
		`${remote === "ok" ? "云端 token 已注销。" : "连不上平台，云端 token 可能仍然有效。"}\n本地凭据请执行 /logout ${PROVIDER_ID} 删除。`,
		remote === "ok" ? "info" : "warning",
	);
}

export function helpText(): string {
	return [
		"/deepseek            账号、余额、赠金状态",
		"/deepseek claim      立刻领取平台发放的赠金（每天启动会自动领一次）",
		"/deepseek balance    只看余额",
		"/deepseek bonuses    赠金账单（活动、金额、发放时间、到期时间）",
		"/deepseek login      怎么登录",
		"/deepseek logout     注销云端 token（本地凭据用 /logout 删除）",
	].join("\n");
}

export function registerCommands(pi: ExtensionAPI): void {
	pi.registerCommand("deepseek", {
		description: "DeepSeek 账号：登录状态、余额、赠金领取",
		getArgumentCompletions: (prefix) => {
			const items = [
				{ value: "claim", description: "领取赠金" },
				{ value: "balance", description: "只看余额" },
				{ value: "bonuses", description: "赠金账单与有效期" },
				{ value: "login", description: "登录说明" },
				{ value: "logout", description: "注销云端 token" },
			];
			const filtered = items.filter((item) => item.value.startsWith(prefix.trim()));
			return filtered.length === 0 ? null : filtered;
		},
		handler: async (args, ctx) => {
			const sub = args.trim().toLowerCase();
			switch (sub) {
				case "":
				case "status":
					return showStatus(ctx);
				case "claim":
				case "领取":
					return void (await runClaim(ctx, { force: true }));
				case "balance":
				case "额度":
					return showStatus(ctx, { balanceOnly: true });
				case "bonuses":
				case "bill":
				case "赠金":
					return showBonuses(ctx);
				case "login":
				case "登录":
					ctx.ui.notify(`执行 /login ${PROVIDER_ID}（或 /login 后在列表里选 DeepSeek 账号）。`, "info");
					return;
				case "logout":
				case "退出":
					return signOut(ctx);
				case "help":
				case "?":
					ctx.ui.notify(helpText(), "info");
					return;
				default:
					ctx.ui.notify(`不认识的子命令「${args.trim()}」。\n${helpText()}`, "warning");
					return;
			}
		},
	});
}
