/**
 * 复用本机 DeepSeek Harness 的登录态。
 *
 * DSH 把账号凭据存在 `<DSH_HOME>/.credentials.yaml`（默认 `~/.dsh`）：
 *
 *   records:
 *     deepseek-account-platform/default:
 *       kind: grant
 *       payload:
 *         version: 1
 *         token: <账号 token>
 *         issuer: https://platform.deepseek.com
 *
 * 这里只做只读、最小化的解析：找到 `deepseek-account-platform/default` 这一段，
 * 取出 token 和 issuer，并确认 issuer 和当前平台地址一致（DSH 自己也做这个校验）。
 * 任何异常都退回 undefined，交给浏览器登录。
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { PLATFORM_ORIGIN } from "./constants.ts";

export interface DshSession {
	token: string;
	issuer: string;
	path: string;
}

function dshHome(): string {
	const configured = process.env.DSH_HOME;
	if (typeof configured === "string" && configured.trim() !== "") {
		let value = configured.trim();
		if (value === "~") value = homedir();
		else if (value.startsWith("~/") || value.startsWith("~\\")) value = join(homedir(), value.slice(2));
		if (process.platform === "win32") {
			const match = /^\/([a-zA-Z])(\/.*)?$/.exec(value);
			if (match !== null) value = `${match[1].toUpperCase()}:\\${(match[2] ?? "").replaceAll("/", "\\")}`;
		}
		return value;
	}
	return join(homedir(), ".dsh");
}

function credentialsPath(): string {
	return join(dshHome(), ".credentials.yaml");
}

/** 从 YAML 文本里取出 `deepseek-account-platform/default` 这条记录的 token。 */
export function parseDshCredential(text: string): { token: string; issuer: string } | undefined {
	const lines = text.split(/\r?\n/);
	let index = lines.findIndex((line) => /^ {2}deepseek-account-platform\/default:\s*$/.test(line));
	if (index < 0) index = lines.findIndex((line) => /^\s*deepseek-account-platform\/default:\s*$/.test(line));
	if (index < 0) return undefined;

	// 记录体以缩进更浅或同级的下一行结束。
	const baseIndent = (lines[index] as string).length - (lines[index] as string).trimStart().length;
	let token: string | undefined;
	let issuer: string | undefined;
	for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
		const line = lines[cursor] as string;
		if (line.trim() === "") continue;
		const indent = line.length - line.trimStart().length;
		if (indent <= baseIndent) break;
		const tokenMatch = /^\s*token:\s*(\S+)\s*$/.exec(line);
		if (tokenMatch !== null && token === undefined) token = tokenMatch[1];
		const issuerMatch = /^\s*issuer:\s*(\S+)\s*$/.exec(line);
		if (issuerMatch !== null && issuer === undefined) issuer = issuerMatch[1];
	}
	if (token === undefined) return undefined;
	return { token: token.replace(/^["']|["']$/g, ""), issuer: issuer?.replace(/^["']|["']$/g, "") ?? "" };
}

/** 读本机 DSH 的账号登录；不存在、格式不认、来源不匹配都返回 undefined。 */
export function readDshSession(): DshSession | undefined {
	const path = credentialsPath();
	let text: string;
	try {
		text = readFileSync(path, "utf-8");
	} catch {
		return undefined;
	}
	const parsed = parseDshCredential(text);
	if (parsed === undefined || parsed.token === "") return undefined;
	// 来源不匹配说明这份 token 属于别的部署，不能拿去请求官方平台。
	if (parsed.issuer !== "" && parsed.issuer.replace(/\/+$/, "") !== new URL(PLATFORM_ORIGIN).origin) return undefined;
	return { token: parsed.token, issuer: parsed.issuer, path };
}
