/**
 * 登录：PKCE + 本机回跳，完全照 DSH 的桌面登录流程走。
 *
 *   ① POST {PLATFORM}/auth-api/v0/dsh/auth_init {code_challenge, state, redirect_uri, locale, login_source}
 *   ② 浏览器打开返回的 {PLATFORM}/dsh/authorize?authorize_id=…
 *   ③ 平台回调 http://127.0.0.1:<随机端口>/oauth/callback?code=&state=
 *   ④ POST {PLATFORM}/auth-api/v0/dsh/auth_exchange {code, code_verifier, redirect_uri, device_id, …}
 *
 * 顺手做一件 DSH 没有的事：如果本机已经装了 DeepSeek Harness 并且登录着，
 * 直接把 `~/.dsh/.credentials.yaml` 里那条账号 token 拿来验证一下，通过就直接
 * 复用，不再弹浏览器（`/login` 会立刻完成）。做不到或校验失败才走浏览器。
 */

import { spawn } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import type { OAuthCredentials, OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import {
	CALLBACK_PATH,
	CREDENTIAL_LIFETIME_MS,
	LOGIN_TIMEOUT_MS,
	PROVIDER_ID,
	PROVIDER_NAME,
	REQUEST_TIMEOUT_MS,
} from "./constants.ts";
import { PlatformError, cancelAuthorize, exchangeCode, fetchProfile, startAuthorize, type AccountProfile } from "./platform.ts";
import { deviceId, deviceModel, osVersion } from "./state.ts";
import { readDshSession } from "./dsh-import.ts";

interface Callback {
	code: string;
	state: string;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve(value: T): void;
	reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

function b64url(buffer: Buffer): string {
	return buffer.toString("base64url");
}

/** 用系统浏览器打开登录页；打不开也没关系，地址已经显示在 /login 界面里。 */
export function openBrowser(url: string): void {
	try {
		const child =
			process.platform === "win32"
				? spawn("cmd", ["/c", "start", "", url], { detached: true, stdio: "ignore" })
				: process.platform === "darwin"
					? spawn("open", [url], { detached: true, stdio: "ignore" })
					: spawn("xdg-open", [url], { detached: true, stdio: "ignore" });
		// 没有可用浏览器命令时 spawn 会异步报错；不接住会变成未处理的 'error' 事件。
		child.on("error", () => {});
		child.unref();
	} catch {
		/* 忽略：用户还能手动打开回调地址完成登录 */
	}
}

function page(res: ServerResponse, status: number, title: string, detail: string): void {
	res.writeHead(status, {
		"content-type": "text/html; charset=utf-8",
		"cache-control": "no-store",
		"referrer-policy": "no-referrer",
		connection: "close",
	});
	res.end(
		`<!doctype html><html lang="zh-CN"><meta charset="utf-8"><title>${title}</title>` +
			`<style>body{font:15px/1.7 system-ui,"Segoe UI",sans-serif;margin:12vh auto;max-width:32rem;padding:0 1.5rem;color:#1f2329}` +
			`h1{font-size:1.25rem;margin:0 0 .75rem}p{margin:.35rem 0;color:#4b5563}</style>` +
			`<h1>${title}</h1><p>${detail}</p></body></html>`,
	);
}

/** 把平台错误翻译成一句人话。 */
function describe(error: unknown): string {
	if (error instanceof PlatformError) return error.message;
	if (error instanceof Error) return error.message;
	return String(error);
}

function credentialsFrom(token: string, profile: AccountProfile | null, source: string): OAuthCredentials {
	return {
		type: "oauth",
		access: token,
		// 平台没有 refresh 流程；占位空串让 pi 不要尝试续期。
		refresh: "",
		expires: Date.now() + CREDENTIAL_LIFETIME_MS,
		provider: PROVIDER_ID,
		loginAt: new Date().toISOString(),
		loginSource: source,
		account: {
			id: profile?.id ?? null,
			name: profile?.name ?? null,
			contact: profile?.contact ?? null,
		},
	};
}

/**
 * 先看本机 DSH 是否已经登录：是的话直接复用它的账号 token。
 * 返回 undefined 表示「没有可复用的登录」，调用方继续走浏览器。
 */
async function tryReuseDshSession(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials | undefined> {
	const session = readDshSession();
	if (session === undefined) return undefined;
	callbacks.onProgress?.("发现本机 DeepSeek Harness 已登录，正在验证它的账号凭据…");
	try {
		const profile = await fetchProfile(session.token, callbacks.signal);
		callbacks.onProgress?.(
			`已复用 DeepSeek Harness 的登录${profile.name === null ? "" : `（${profile.name}）`}，无需浏览器。`,
		);
		return credentialsFrom(session.token, profile, "dsh-import");
	} catch (error) {
		if (error instanceof PlatformError && error.code === "unauthorized") {
			callbacks.onProgress?.("DeepSeek Harness 的登录已失效，改走浏览器登录。");
			return undefined;
		}
		callbacks.onProgress?.(`读取 DeepSeek Harness 登录失败（${describe(error)}），改走浏览器登录。`);
		return undefined;
	}
}

/** 打开浏览器完成一次授权，返回账号 token。 */
async function browserLogin(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const verifier = b64url(randomBytes(32));
	const challenge = createHash("sha256").update(verifier).digest("base64url");
	const state = b64url(randomBytes(32));
	let authorizeId: string | undefined;
	let exchanged = false;

	const received = deferred<Callback>();
	// 下面有几条路径会在真正 await 之前 reject；先挂空 catch，否则 Node 会当成
	// unhandledRejection（pi 会直接退出）。真 await 时仍然拿到 reject 语义。
	void received.promise.catch(() => {});
	let settled = false;
	const finish = (action: () => void) => {
		if (settled) return;
		settled = true;
		action();
	};

	const server = createServer((req, res) => {
		let url: URL;
		try {
			url = new URL(req.url ?? "/", "http://127.0.0.1");
		} catch {
			page(res, 400, "回调地址无效", "请回到 pi 重新登录。");
			return;
		}
		if (url.pathname !== CALLBACK_PATH) {
			page(res, 404, "没有这个地址", "请回到 pi 重新登录。");
			return;
		}
		if (req.method !== "GET") {
			page(res, 405, "只接受 GET", "请回到 pi 重新登录。");
			return;
		}
		if (settled) {
			page(res, 410, "这次登录已经结束", "请回到 pi 重新执行 /login。");
			return;
		}
		const code = url.searchParams.get("code") ?? "";
		const gotState = url.searchParams.get("state") ?? "";
		const sameState =
			gotState.length === state.length && Buffer.byteLength(gotState) === Buffer.byteLength(state)
				? timingSafeEqual(Buffer.from(gotState), Buffer.from(state))
				: false;
		if (code === "" || !sameState) {
			page(res, 400, "登录回调校验失败", "state 不匹配，已中止这次登录。请回到 pi 重试。");
			finish(() => received.reject(new Error("登录回调校验失败（state 不匹配）。")));
			return;
		}
		page(res, 200, "登录成功", "可以关闭这个页面，回到 pi 继续。");
		finish(() => received.resolve({ code, state: gotState }));
	});
	server.on("error", (error) => finish(() => received.reject(error)));

	const onAbort = () => finish(() => received.reject(new Error("登录已取消。")));
	callbacks.signal?.addEventListener("abort", onAbort, { once: true });
	const timer = setTimeout(() => finish(() => received.reject(new Error("等待浏览器登录超时，请回到 pi 重新 /login。"))), LOGIN_TIMEOUT_MS);
	timer.unref?.();
	if (callbacks.signal?.aborted === true) finish(() => received.reject(new Error("登录已取消。")));

	try {
		await new Promise<void>((resolve, reject) => {
			server.once("listening", resolve);
			server.once("error", reject);
			server.listen(0, "127.0.0.1");
		});
		const address = server.address();
		const port = typeof address === "object" && address !== null ? address.port : 0;
		if (port === 0) throw new Error("无法启动本机回调端口。");
		const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;

		const start = await startAuthorize({ codeChallenge: challenge, state, redirectUri, signal: callbacks.signal });
		authorizeId = start.authorizeId;
		callbacks.onAuth({
			url: start.authorizeUrl,
			instructions: "在浏览器里用 DeepSeek 账号完成授权，完成后会自动回到 pi。",
		});
		callbacks.onProgress?.("已在浏览器打开 DeepSeek 授权页，等待授权结果…");
		openBrowser(start.authorizeUrl);

		const { code } = await received.promise;

		const result = await exchangeCode({
			code,
			codeVerifier: verifier,
			redirectUri,
			deviceId: deviceId(),
			deviceModel: deviceModel(),
			osVersion: osVersion(),
			signal: callbacks.signal,
		});
		exchanged = true;

		// exchange 已经证明 token 有效；资料只是为了显示昵称，失败不影响登录。
		let profile = result.profile;
		if (profile === null || profile.id === null) {
			try {
				profile = await fetchProfile(result.token, callbacks.signal);
			} catch {
				/* 保留 exchange 返回的资料或空资料 */
			}
		}
		return credentialsFrom(result.token, profile, "browser");
	} finally {
		clearTimeout(timer);
		callbacks.signal?.removeEventListener("abort", onAbort);
		// 只关空闲连接：正在回写的回调页不会被截断。
		server.close();
		server.closeIdleConnections?.();
		// 没换成 token 就说明这次授权白开了，通知平台作废（失败也无所谓）。
		if (authorizeId !== undefined && !exchanged) {
			void cancelAuthorize({
				authorizeId,
				codeVerifier: verifier,
				signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
			}).catch(() => {});
		}
	}
}

/** pi 的 /login 入口。 */
export async function login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const reused = await tryReuseDshSession(callbacks);
	if (reused !== undefined) return reused;
	return browserLogin(callbacks);
}

/**
 * pi 在 token 临近「到期」时才会调用刷新。账号 token 没有过期时间，
 * 所以只把到期时间往后推；真的被平台拒绝时请求会 401，提示重新登录。
 */
export async function refreshToken(credentials: OAuthCredentials, signal: AbortSignal): Promise<OAuthCredentials> {
	if (signal.aborted) throw new Error("刷新已取消。");
	return { ...credentials, expires: Date.now() + CREDENTIAL_LIFETIME_MS };
}

/** 从凭据里取账号 token（就是推理要用的 x-dsh-auth-token）。 */
export function getApiKey(credentials: OAuthCredentials): string {
	const token = credentials.access;
	if (typeof token !== "string" || token === "") {
		throw new Error(`${PROVIDER_NAME}凭据里没有 token，请重新 /login ${PROVIDER_ID}。`);
	}
	return token;
}
