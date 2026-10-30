/**
 * 固定常量与环境变量。
 *
 * 这些值全部来自 DeepSeek Harness（DSH）里 `@deepseek-ai/dsh-deepseek-account-platform`
 * 与 `@deepseek-ai/dsh-deepseek-account` 的实现：同一个平台地址、同一条 PKCE 流程、
 * 同一组 `x-client-*` 请求头、同一个 `x-dsh-auth-token` 推理鉴权头。
 */

function trimmedEnv(name: string, fallback: string): string {
	const raw = process.env[name];
	const value = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : fallback;
	return value.replace(/\/+$/, "");
}

function positiveIntEnv(name: string, fallback: number): number {
	const raw = Number(process.env[name]);
	return Number.isFinite(raw) && raw > 0 ? Math.trunc(raw) : fallback;
}

/** pi 的 provider id，同时是 auth.json 里的键名。 */
export const PROVIDER_ID = "deepseek-account";

/** /login 与 /model 里显示的提供方名称。 */
export const PROVIDER_NAME = "DeepSeek 账号";

/** 推理请求的鉴权头：账号 token 走这里，而不是 x-api-key / Authorization。 */
export const TOKEN_HEADER = "x-dsh-auth-token";

/** 账号、余额、赠金、登录协议所在的平台地址（DSH 的 platformOrigin）。 */
export const PLATFORM_ORIGIN = trimmedEnv("DEEPSEEK_PLATFORM_ORIGIN", "https://platform.deepseek.com");

/** 推理地址的 origin（模型列表 GET /models 在这里）。 */
export const INFERENCE_ORIGIN = trimmedEnv("DEEPSEEK_INFERENCE_ORIGIN", "https://api.deepseek.com");

/** Anthropic Messages 兼容根地址；SDK 会拼成 {baseURL}/v1/messages。 */
export const INFERENCE_BASE_URL = `${INFERENCE_ORIGIN}/anthropic`;

/** 模型目录接口。 */
export const CATALOG_URL = `${INFERENCE_ORIGIN}/models`;

/** 本机回跳路径，必须和 auth_init 提交的 redirect_uri 完全一致。 */
export const CALLBACK_PATH = "/oauth/callback";

/** 单次平台 HTTP 请求（资料、余额、赠金、换令牌）的超时。 */
export const REQUEST_TIMEOUT_MS = positiveIntEnv("DEEPSEEK_ACCOUNT_REQUEST_TIMEOUT_MS", 30_000);

/** 浏览器登录的整体等待时间（DSH 的 attemptTimeoutMs 默认也是 10 分钟）。 */
export const LOGIN_TIMEOUT_MS = positiveIntEnv("DEEPSEEK_ACCOUNT_LOGIN_TIMEOUT_MS", 10 * 60_000);

/**
 * `x-client-version` 上报的版本。
 *
 * 平台会把这一组请求头当客户端身份，账号接口本身不依赖具体取值；这里沿用
 * DSH 桌面端当前发布的版本号，避免平台按未知版本做灰度/拦截。
 */
export const CLIENT_VERSION = trimmedEnv("DEEPSEEK_ACCOUNT_CLIENT_VERSION", "0.2.1-rc.5");

/** 模型目录的进程内缓存时长，避免每次 /model 都打一次接口。 */
export const CATALOG_TTL_MS = positiveIntEnv("DEEPSEEK_ACCOUNT_CATALOG_TTL_MS", 10 * 60_000);

/**
 * 存进 auth.json 的凭据有效期。
 *
 * 平台签发的账号 token 没有过期时间、也没有 refresh 流程（DSH 里也一样），
 * 所以给一个很远的到期时间，让 pi 不要去「续期」；真的失效时请求会 401，
 * 我们把它翻译成「重新 /login」的提示。
 */
export const CREDENTIAL_LIFETIME_MS = 50 * 365 * 24 * 60 * 60 * 1000;

/**
 * 启动时自动领取（读取 + 确认）赠金。
 *
 * DSH 的「赠金已到账」提示就是读 `get_unnotified_bonuses` 再 `ack_bonus_notified`，
 * 平台每天发放的额度会以未读赠金的形式出现。设 `DEEPSEEK_ACCOUNT_AUTO_CLAIM=0` 关掉。
 */
export const AUTO_CLAIM_ENABLED = process.env.DEEPSEEK_ACCOUNT_AUTO_CLAIM !== "0";

/** 界面语言：决定 `locale` 字段与 `x-client-locale`。 */
export function wireLocale(): "zh_CN" | "en_US" {
	const configured = process.env.DEEPSEEK_ACCOUNT_LOCALE;
	const source =
		typeof configured === "string" && configured.trim() !== ""
			? configured.trim()
			: (process.env.LC_ALL ?? process.env.LC_MESSAGES ?? process.env.LANG ?? Intl.DateTimeFormat().resolvedOptions().locale);
	return /^zh/i.test(source) ? "zh_CN" : "en_US";
}

/** 客户端平台标识，和 DSH 桌面端一致；非 Windows/macOS 退回 web。 */
export function clientPlatform(): string {
	if (process.platform === "win32") return "desktop-win";
	if (process.platform === "darwin") return "desktop-mac";
	return "web";
}
