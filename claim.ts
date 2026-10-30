/**
 * 领取（读取 + 确认）平台发放的赠金。
 *
 * 平台的「赠金」就是 DSH 里那个「赠金已到账」提示：
 *   GET  /api/v0/users/get_unnotified_bonuses   → 还没展示过的赠金列表
 *   POST /api/v0/users/ack_bonus_notified       → 标记为已展示（= 已领取）
 *
 * 每次成功领取后顺带读一次余额，好把「领了多少、现在还剩多少」一起告诉用户。
 */

import {
	PlatformError,
	ackBonus,
	fetchBonuses,
	fetchSummary,
	type AccountSummary,
	type Bonus,
	type BonusOrder,
	type Wallet,
} from "./platform.ts";

export interface ClaimOutcome {
	bonuses: Bonus[];
	/** 成功确认的笔数。 */
	acked: number;
	/** 确认失败的笔数（下次启动会再试）。 */
	failed: number;
	summary: AccountSummary | null;
}

/** 读取未领取赠金并逐笔确认；余额只是附带信息，失败不影响领取结果。 */
export async function claimBonuses(token: string, signal: AbortSignal): Promise<ClaimOutcome> {
	const bonuses = await fetchBonuses(token, signal);
	let acked = 0;
	let failed = 0;
	for (const bonus of bonuses) {
		try {
			await ackBonus(token, bonus.orderId, signal);
			acked += 1;
		} catch (error) {
			// token 失效要立刻抛出去，让调用方提示重新登录。
			if (error instanceof PlatformError && error.code === "unauthorized") throw error;
			failed += 1;
		}
	}

	let summary: AccountSummary | null = null;
	try {
		summary = await fetchSummary(token, signal);
	} catch (error) {
		if (error instanceof PlatformError && error.code === "unauthorized") throw error;
		summary = null;
	}
	return { bonuses, acked, failed, summary };
}

/** ¥ / $ 之类的符号。 */
export function currencySymbol(currency: string): string {
	switch (currency.toUpperCase()) {
		case "CNY":
			return "¥";
		case "USD":
			return "$";
		default:
			return `${currency} `;
	}
}

/** 余额字符串（平台给 16 位小数）→ 至少两位、最多四位的短金额。 */
export function shortAmount(value: string): string {
	const parsed = Number(value);
	if (!Number.isFinite(parsed)) return value;
	const rounded = Math.round(parsed * 10000) / 10000;
	const text = String(rounded);
	if (!text.includes(".")) return `${text}.00`;
	const [whole, decimals] = text.split(".");
	return decimals.length < 2 ? `${whole}.${decimals}0` : text;
}

export function formatWallet(wallet: Wallet): string {
	return `${currencySymbol(wallet.currency)}${shortAmount(wallet.balance)}`;
}

/** 多币种钱包合并成一行，例如「¥7.72 / $1.20」。 */
export function formatWallets(wallets: Wallet[], empty = "0"): string {
	if (wallets.length === 0) return empty;
	return wallets.map((wallet) => formatWallet(wallet)).join(" / ");
}

/** 一笔赠金的人话，例如「+0.50 CNY（每日赠送）」。 */
export function describeBonus(bonus: Bonus): string {
	const amount =
		bonus.amount === undefined
			? undefined
			: `${bonus.currency === undefined ? "" : `${currencySymbol(bonus.currency)}`}${shortAmount(bonus.amount)}`;
	const amountText = amount === undefined ? bonus.message : `${amount}${bonus.currency === undefined ? "" : ` ${bonus.currency}`}`;
	const title = bonus.title ?? bonus.campaign;
	return title === undefined ? amountText : `${amountText}（${title}）`;
}

/** 赠金账单状态的人话。 */
export function bonusStatusLabel(status: string): string {
	switch (status) {
		case "ACTIVE":
			return "可用";
		case "EXPIRED":
			return "已过期";
		case "EXHAUSTED":
			return "已用完";
		default:
			return status;
	}
}

/** 距离到期还有多久；空字符串表示不过期/无到期时间。 */
export function describeRemaining(expiresAt: string | null, now = Date.now()): string {
	if (expiresAt === null || expiresAt === "") return "";
	const at = Date.parse(expiresAt);
	if (!Number.isFinite(at)) return "";
	const delta = at - now;
	if (delta <= 0) return "已到期";
	const days = delta / 86_400_000;
	const text = days >= 1 ? `${days.toFixed(1)} 天` : `${Math.max(1, Math.round(delta / 3_600_000))} 小时`;
	return `剩余 ${text}`;
}

/** 一行赠金账单，例如「Harness 赠金 ¥6.00 · 可用 · 2026-11-06 到期（剩余 6.3 天）」。 */
export function describeBonusOrder(order: BonusOrder, now = Date.now()): string {
	const label = order.label ?? "赠金";
	const amount = `${currencySymbol(order.currency)}${shortAmount(order.amount)}`;
	const status = bonusStatusLabel(order.status);
	const remaining = order.status === "ACTIVE" ? describeRemaining(order.expiresAt, now) : "";
	const when =
		order.expiresAt === null || order.expiresAt === "" ? "" : `${order.expiresAt.slice(0, 10)} 到期`;
	const tail = [status, when, remaining].filter((part) => part !== "").join(" · ");
	return `${label} ${amount}${tail === "" ? "" : ` · ${tail}`}`;
}

/** 账单排序：可用的排前面（快到期的更前），其余按发放时间倒序。 */
export function sortBonusOrders(orders: BonusOrder[]): BonusOrder[] {
	const rank = (status: string): number => (status === "ACTIVE" ? 0 : 1);
	return [...orders].sort((left, right) => {
		const byRank = rank(left.status) - rank(right.status);
		if (byRank !== 0) return byRank;
		if (left.status === "ACTIVE" && right.status === "ACTIVE") {
			return (left.expiresAt ?? "9999").localeCompare(right.expiresAt ?? "9999");
		}
		return right.insertedAt.localeCompare(left.insertedAt);
	});
}
