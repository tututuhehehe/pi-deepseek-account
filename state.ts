/**
 * 扩展自己的小状态文件：`<agent dir>/deepseek-account.json`。
 *
 * 只放两样东西：
 *   deviceId  登录时上报给平台的设备标识（DSH 也持久化一份，换设备不该每次都变）
 *   领取记录  当天是否已经自动领过赠金，避免每次启动都打接口、都弹提示
 *
 * 账号 token 本身不在这里——那是 pi 的 auth.json。
 */

import { randomUUID } from "node:crypto";
import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir, release } from "node:os";
import { join } from "node:path";

export interface ExtensionState {
	deviceId?: string;
	/** 最后一次真正领到赠金的本地日期（YYYY-MM-DD）。 */
	lastClaimDay?: string;
	/** 最后一次提醒「登录失效」的本地日期，同一天只提醒一次。 */
	lastAuthWarnDay?: string;
	lastClaimAt?: string;
	lastClaimAccount?: string;
	/** 给人看的摘要，例如「+0.50 CNY」。 */
	lastClaimAmount?: string;
}

function expandHome(value: string): string {
	if (value === "~") return homedir();
	if (value.startsWith("~/") || value.startsWith("~\\")) return join(homedir(), value.slice(2));
	return value;
}

/** Git Bash 风格的 /c/foo 在 Windows 上要换成 C:\foo。 */
function normalizeWindowsPath(value: string): string {
	if (process.platform !== "win32") return value;
	const match = /^\/([a-zA-Z])(\/.*)?$/.exec(value);
	if (match === null) return value;
	return `${match[1].toUpperCase()}:\\${(match[2] ?? "").replaceAll("/", "\\")}`;
}

/** 和 pi 一致：只认 PI_CODING_AGENT_DIR，否则 ~/.pi/agent。 */
export function agentDir(): string {
	const override = process.env.PI_CODING_AGENT_DIR;
	if (typeof override === "string" && override.trim() !== "") return normalizeWindowsPath(expandHome(override.trim()));
	return join(homedir(), ".pi", "agent");
}

export function statePath(): string {
	return join(agentDir(), "deepseek-account.json");
}

export function readState(): ExtensionState {
	try {
		const parsed = JSON.parse(readFileSync(statePath(), "utf-8").replace(/^\uFEFF/, "")) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as ExtensionState) : {};
	} catch {
		return {};
	}
}

/** 合并写回；先写临时文件再改名，避免半截 JSON。 */
export function writeState(patch: ExtensionState): ExtensionState {
	const next = { ...readState(), ...patch };
	const path = statePath();
	const temp = `${path}.${process.pid}.tmp`;
	try {
		writeFileSync(temp, JSON.stringify(next, null, 2), { encoding: "utf-8", mode: 0o600 });
		renameSync(temp, path);
	} catch {
		/* 状态文件写不进去不影响主流程：最多下次再领一次 */
	}
	return next;
}

/** 本地日期键，用来做「每天只自动领一次」。 */
export function localDayKey(at = new Date()): string {
	const month = String(at.getMonth() + 1).padStart(2, "0");
	const day = String(at.getDate()).padStart(2, "0");
	return `${at.getFullYear()}-${month}-${day}`;
}

let cachedDeviceId: string | undefined;

/** 取（必要时创建）本扩展的设备标识。 */
export function deviceId(): string {
	if (cachedDeviceId !== undefined) return cachedDeviceId;
	const state = readState();
	if (typeof state.deviceId === "string" && state.deviceId !== "") {
		cachedDeviceId = state.deviceId;
		return cachedDeviceId;
	}
	const created = randomUUID();
	writeState({ deviceId: created });
	cachedDeviceId = created;
	return created;
}

/** DSH 上报的 device_model 是 `<platform>-<arch>`。 */
export function deviceModel(): string {
	return `${process.platform}-${process.arch}`;
}

/** 上报给平台的系统版本串（DSH 用 os.release()）。 */
export function osVersion(): string {
	try {
		const value = release().trim();
		return value === "" ? `${process.platform} ${process.arch}` : value;
	} catch {
		return `${process.platform} ${process.arch}`;
	}
}
