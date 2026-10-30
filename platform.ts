/**
 * DeepSeek 平台账号接口。
 *
 * 全部端点、请求头与响应信封（`{code, data:{biz_code, biz_data}}`）都对齐 DSH 的
 * `@deepseek-ai/dsh-deepseek-account-platform`：
 *
 *   POST /auth-api/v0/dsh/auth_init      开始 PKCE 登录，拿 authorize_url
 *   POST /auth-api/v0/dsh/auth_exchange  用 code + code_verifier 换账号 token
 *   GET  /auth-api/v0/users/current      账号资料（昵称、脱敏手机/邮箱）
 *   GET  /api/v0/users/get_user_summary  充值钱包 / 赠金钱包余额
 *   GET  /api/v0/users/get_unnotified_bonuses  未读赠金（就是「每日额度」）
 *   POST /api/v0/users/ack_bonus_notified      把赠金标记为已展示（领取）
 *   POST /auth-api/v0/users/logout       注销当前 token
 */

import { CLIENT_VERSION, PLATFORM_ORIGIN, REQUEST_TIMEOUT_MS, TOKEN_HEADER, clientPlatform, wireLocale } from "./constants.ts";

export type PlatformErrorCode = "unauthorized" | "network" | "protocol" | "business";

/** 平台请求失败；code 用来决定提示语（是否要重新登录等）。 */
export class PlatformError extends Error {
	readonly code: PlatformErrorCode;

	constructor(code: PlatformErrorCode, message: string) {
		super(message);
		this.name = "PlatformError";
		this.code = code;
	}
}

export interface AccountProfile {
	id: string | null;
	name: string | null;
	/** 平台脱敏后的手机号或邮箱，原样保留。 */
	contact: string | null;
	avatarUrl: string | null;
}

export interface Wallet {
	currency: string;
	balance: string;
}

export interface AccountSummary {
	normal: Wallet[];
	bonus: Wallet[];
}

/** 赠金账单（比「未读赠金」历史更全：来自 get_all_invoice）。 */
export interface BonusOrder {
	id: string;
	amount: string;
	currency: string;
	/** ACTIVE / EXPIRED / EXHAUSTED */
	status: string;
	/** 发放时间（ISO，带时区）。 */
	insertedAt: string;
	/** 到期时间；null 表示不过期。 */
	expiresAt: string | null;
	/** 账单备注，例如「Harness 赠金」「服务补偿」。 */
	label: string | null;
}

export interface Bonus {
	orderId: string;
	message: string;
	title?: string;
	amount?: string;
	currency?: string;
	expiresAt: string;
	grantedAt?: string;
	campaign?: string;
}

interface Envelope<T> {
	code?: number;
	msg?: string;
	data?: {
		biz_code?: number;
		biz_msg?: string;
		biz_data?: T;
	};
}

interface RequestOptions {
	method?: "GET" | "POST";
	token?: string;
	body?: unknown;
	signal?: AbortSignal;
	timeoutMs?: number;
}

/** DSH 发给平台的五个客户端身份请求头（bundle id 有意留空）。 */
function clientHeaders(): Record<string, string> {
	return {
		"x-client-bundle-id": "",
		"x-client-platform": clientPlatform(),
		"x-client-version": CLIENT_VERSION,
		"x-client-locale": wireLocale(),
		"x-client-timezone-offset": String(-new Date().getTimezoneOffset() * 60),
	};
}

function errorText(error: unknown): string {
	if (error instanceof Error) {
		const cause = (error as { cause?: unknown }).cause;
		const inner = cause instanceof Error ? `：${cause.message}` : "";
		return `${error.message}${inner}`;
	}
	return String(error);
}

function unauthorized(): PlatformError {
	return new PlatformError("unauthorized", "DeepSeek 账号登录已失效，请重新执行 /login deepseek-account。");
}

export function platformLabel(): string {
	return new URL(PLATFORM_ORIGIN).host;
}

/** 发一个平台请求并拆信封；成功时返回 biz_data。 */
async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
	const headers: Record<string, string> = { accept: "application/json", ...clientHeaders() };
	if (options.token !== undefined) headers[TOKEN_HEADER] = options.token;
	if (options.body !== undefined) headers["content-type"] = "application/json";

	const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
	const timeout = AbortSignal.timeout(timeoutMs);
	const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);

	let response: Response;
	try {
		response = await fetch(`${PLATFORM_ORIGIN}${path}`, {
			method: options.method ?? "GET",
			headers,
			body: options.body === undefined ? undefined : JSON.stringify(options.body),
			redirect: "error",
			signal,
		});
	} catch (error) {
		if (options.signal?.aborted === true) throw error;
		throw new PlatformError("network", `连不上 ${platformLabel()}（${path}）：${errorText(error)}`);
	}

	const text = await response.text().catch(() => "");
	let payload: Envelope<T> | undefined;
	try {
		payload = JSON.parse(text) as Envelope<T>;
	} catch {
		payload = undefined;
	}

	if (response.status === 401 || payload?.code === 40003) throw unauthorized();
	if (!response.ok) {
		const detail = typeof payload?.msg === "string" && payload.msg !== "" ? `：${payload.msg}` : "";
		throw new PlatformError("network", `平台请求失败（HTTP ${response.status}${detail}）`);
	}
	if (payload === undefined) {
		throw new PlatformError("protocol", `平台返回了无法解析的响应（${path}）。`);
	}
	if (payload.code !== 0) {
		const detail = typeof payload.msg === "string" && payload.msg !== "" ? `：${payload.msg}` : "";
		throw new PlatformError("business", `平台拒绝了这个请求${detail}（code ${String(payload.code)}）`);
	}
	const envelope = payload.data;
	if (envelope === undefined || typeof envelope !== "object") {
		throw new PlatformError("protocol", `平台响应缺少 data（${path}）。`);
	}
	if (envelope.biz_code !== undefined && envelope.biz_code !== 0) {
		const detail = typeof envelope.biz_msg === "string" && envelope.biz_msg !== "" ? `：${envelope.biz_msg}` : "";
		throw new PlatformError("business", `平台业务失败${detail}（biz_code ${envelope.biz_code}）`);
	}
	return envelope.biz_data as T;
}

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value !== "" ? value : undefined;
}

function projectProfile(raw: unknown): AccountProfile {
	const value = asRecord(raw);
	const identity = asRecord(value.id_profile);
	const contact = asString(value.mobile_number) ?? asString(value.mobile) ?? asString(value.email);
	return {
		id: asString(value.id) ?? null,
		name: asString(identity.name) ?? null,
		contact: contact ?? null,
		avatarUrl: asString(identity.picture) ?? null,
	};
}

function projectWallets(raw: unknown): Wallet[] {
	if (!Array.isArray(raw)) return [];
	const wallets: Wallet[] = [];
	for (const entry of raw) {
		const wallet = asRecord(entry);
		const currency = asString(wallet.currency);
		const balance = asString(wallet.balance);
		if (currency !== undefined && balance !== undefined) wallets.push({ currency, balance });
	}
	return wallets;
}

function projectBonuses(raw: unknown): Bonus[] {
	if (!Array.isArray(raw)) return [];
	const bonuses: Bonus[] = [];
	for (const entry of raw) {
		const bonus = asRecord(entry);
		const orderId = asString(bonus.order_id);
		if (orderId === undefined) continue;
		bonuses.push({
			orderId,
			message: asString(bonus.msg) ?? "",
			title: asString(bonus.title),
			amount: asString(bonus.amount),
			currency: asString(bonus.currency),
			expiresAt: asString(bonus.expires_at) ?? "",
			grantedAt: asString(bonus.granted_at),
			campaign: asString(bonus.campaign),
		});
	}
	return bonuses;
}

/** 读账号资料；token 失效时抛 unauthorized。 */
export async function fetchProfile(token: string, signal?: AbortSignal): Promise<AccountProfile> {
	return projectProfile(await request<unknown>("/auth-api/v0/users/current", { token, signal }));
}

/** 读充值余额与赠金余额。 */
export async function fetchSummary(token: string, signal?: AbortSignal): Promise<AccountSummary> {
	const raw = asRecord(
		await request<unknown>("/api/v0/users/get_user_summary", { token, signal, timeoutMs: REQUEST_TIMEOUT_MS }),
	);
	return { normal: projectWallets(raw.normal_wallets), bonus: projectWallets(raw.bonus_wallets) };
}

/** 读平台尚未记录为「已展示」的赠金。 */
export async function fetchBonuses(token: string, signal?: AbortSignal): Promise<Bonus[]> {
	return projectBonuses(await request<unknown>("/api/v0/users/get_unnotified_bonuses", { token, signal }));
}

/**
 * 读赠金账单：每一笔发放（活动名、金额、发放时间、到期时间、状态）。
 *
 * 这是回答「礼金是什么规则、什么时候开始」的唯一权威来源——未读赠金列表只会
 * 出现还没展示过的那几笔，历史要到这里看。
 */
export async function fetchBonusOrders(token: string, signal?: AbortSignal): Promise<BonusOrder[]> {
	const raw = asRecord(
		await request<unknown>("/auth-api/v0/users/get_all_invoice", { token, signal, timeoutMs: REQUEST_TIMEOUT_MS }),
	);
	const invoices = asRecord(raw.invoices);
	if (!Array.isArray(invoices.bonus_orders)) return [];
	const orders: BonusOrder[] = [];
	for (const entry of invoices.bonus_orders) {
		const order = asRecord(entry);
		const id = asString(order.id);
		const amount = asString(order.amount);
		if (id === undefined || amount === undefined) continue;
		const note = asRecord(order.note);
		orders.push({
			id,
			amount,
			currency: asString(order.currency) ?? "CNY",
			status: asString(order.bonus_order_status) ?? "UNKNOWN",
			insertedAt: asString(order.inserted_at) ?? "",
			expiresAt: asString(order.expires_at) ?? null,
			label: asString(note.zh) ?? asString(note.en) ?? null,
		});
	}
	return orders.sort((left, right) => left.insertedAt.localeCompare(right.insertedAt));
}

/** 把一笔赠金标记为已领取（平台侧就是「已展示」）。 */
export async function ackBonus(token: string, orderId: string, signal?: AbortSignal): Promise<void> {
	await request<unknown>("/api/v0/users/ack_bonus_notified", {
		method: "POST",
		token,
		body: { order_id: orderId },
		signal,
	});
}

/** 云端注销；本地凭据由 /logout 删除。失败也只是警告。 */
export async function revokeToken(token: string, signal?: AbortSignal): Promise<void> {
	await request<unknown>("/auth-api/v0/users/logout", { method: "POST", token, signal });
}

export interface AuthorizeStart {
	authorizeUrl: string;
	authorizeId: string;
	expiresIn: number;
}

/**
 * 校验平台返回的浏览器地址：必须同源，且路径固定为 /dsh/authorize。
 * 防止协议被篡改后把用户带去任意站点。
 */
function browserUrl(value: unknown, path: string): string {
	if (typeof value !== "string") throw new PlatformError("protocol", "平台没有返回登录地址。");
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new PlatformError("protocol", "平台返回的登录地址无法解析。");
	}
	const expectedOrigin = new URL(PLATFORM_ORIGIN).origin;
	if (url.origin !== expectedOrigin || url.pathname !== path || url.username !== "" || url.password !== "") {
		throw new PlatformError("protocol", `平台返回的登录地址不属于 ${platformLabel()}，已中止登录。`);
	}
	return url.href;
}

/** 开始一次浏览器授权（auth_init）。 */
export async function startAuthorize(input: {
	codeChallenge: string;
	state: string;
	redirectUri: string;
	signal?: AbortSignal;
}): Promise<AuthorizeStart> {
	const raw = asRecord(
		await request<unknown>("/auth-api/v0/dsh/auth_init", {
			method: "POST",
			body: {
				code_challenge: input.codeChallenge,
				code_challenge_method: "S256",
				state: input.state,
				redirect_uri: input.redirectUri,
				locale: wireLocale(),
				login_source: clientPlatform() === "web" ? "web" : "desktop",
			},
			signal: input.signal,
		}),
	);
	const authorizeId = asString(raw.authorize_id);
	const expiresIn = typeof raw.expires_in === "number" && raw.expires_in > 0 ? raw.expires_in : 600;
	if (authorizeId === undefined) throw new PlatformError("protocol", "平台没有返回 authorize_id。");
	return { authorizeUrl: browserUrl(raw.authorize_url, "/dsh/authorize"), authorizeId, expiresIn };
}

export interface ExchangeResult {
	token: string;
	/** 平台顺手返回的资料；可能为空。 */
	profile: AccountProfile | null;
}

/** 用回调拿到的 code 换账号 token（auth_exchange）。 */
export async function exchangeCode(input: {
	code: string;
	codeVerifier: string;
	redirectUri: string;
	deviceId: string;
	deviceModel: string;
	osVersion: string;
	signal?: AbortSignal;
}): Promise<ExchangeResult> {
	const raw = asRecord(
		await request<unknown>("/auth-api/v0/dsh/auth_exchange", {
			method: "POST",
			body: {
				code: input.code,
				code_verifier: input.codeVerifier,
				redirect_uri: input.redirectUri,
				device_id: input.deviceId,
				device_model: input.deviceModel,
				os_version: input.osVersion,
			},
			signal: input.signal,
		}),
	);
	const token = asString(raw.token);
	if (token === undefined) throw new PlatformError("protocol", "平台没有返回账号 token。");
	let profile: AccountProfile | null = null;
	if (raw.user !== null && raw.user !== undefined) {
		try {
			profile = projectProfile(raw.user);
		} catch {
			profile = null;
		}
	}
	return { token, profile };
}

/** 放弃一次授权（用户取消、超时）：让平台尽快作废这次 attempt。 */
export async function cancelAuthorize(input: {
	authorizeId: string;
	codeVerifier: string;
	signal?: AbortSignal;
}): Promise<void> {
	await request<unknown>("/auth-api/v0/dsh/auth_cancel", {
		method: "POST",
		body: { authorize_id: input.authorizeId, code_verifier: input.codeVerifier },
		signal: input.signal,
	});
}
