/**
 * 读 pi 存下来的账号凭据。
 *
 * pi 把 OAuth 凭据写在 `<agent dir>/auth.json`（provider id = deepseek-account）。
 * 我们除了 token 还额外存了账号资料和登录方式，用来给 /deepseek 直接显示，
 * 不必每次都请求平台。这里只读。
 */

import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { PROVIDER_ID } from "./constants.ts";

export interface StoredAccount {
	id?: string | null;
	name?: string | null;
	contact?: string | null;
}

export interface StoredAccountCredential {
	type?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	/** 登录那一刻的账号资料（昵称、脱敏手机/邮箱、账号 ID）。 */
	account?: StoredAccount;
	/** 登录时间（ISO）。 */
	loginAt?: string;
	/** browser（浏览器授权）/ dsh-import（复用 DeepSeek Harness 的登录）。 */
	loginSource?: string;
}

export function readAccountCredential(): StoredAccountCredential | undefined {
	try {
		const value = readStoredCredential(PROVIDER_ID);
		return typeof value === "object" && value !== null ? (value as StoredAccountCredential) : undefined;
	} catch {
		return undefined;
	}
}

export function accountToken(credential: StoredAccountCredential | undefined): string | undefined {
	const token = credential?.access;
	return typeof token === "string" && token !== "" ? token : undefined;
}

/** 登录方式的人话。 */
export function describeLoginSource(source: string | undefined): string {
	switch (source) {
		case "dsh-import":
			return "复用 DeepSeek Harness 的登录";
		case "browser":
			return "浏览器授权";
		default:
			return "未知";
	}
}

/** 账号显示名：昵称 → 脱敏手机/邮箱 → 账号 ID。 */
export function describeAccount(credential: StoredAccountCredential): string {
	const account = credential.account ?? {};
	if (typeof account.name === "string" && account.name !== "") return account.name;
	if (typeof account.contact === "string" && account.contact !== "") return account.contact;
	if (typeof account.id === "string" && account.id !== "") return account.id;
	return "已登录";
}
