import type { CloudflareEnv } from "../../types/env";
import { constantTimeEqual } from "../utils/timingSafe";
import { loadAdminEnv } from "./loadAdminEnv";
import { verifyPasswordAllowPlaintext } from "./password";

// 前台用户会话（与后台 admin_session 完全隔离，见 DESIGN-USER-SYSTEM.md B.2）
// 无状态 HMAC Cookie：base64url({u,exp,role}).base64url(sig)，30 天有效；
// 代价是无法主动吊销，封禁靠 users.banned 每次请求校验（小站可接受）

export const USER_SESSION_COOKIE = "user_session";

export const USER_SESSION_MAX_AGE = 60 * 60 * 24 * 30; // 30 天（记住我）

export const USER_BCRYPT_ROUNDS = 10; // 与后台 admin 对齐（$2b$ 10 轮）

export interface UserAuthEnv {
	USER_SESSION_SECRET?: string;
}

/**
 * 会话相关 env 的注入形态：生产传完整 CloudflareEnv（其属性在运行时真实存在，
 * 类型上未声明也无妨），本地测试可只传含密钥的窄对象。
 */
export type UserSessionEnv = CloudflareEnv | UserAuthEnv;

/** 统一读取注入值（绕开 CloudflareEnv 未声明该字段的类型弱检查），空则回退 process.env */
function readInjectedSecret(env?: UserSessionEnv): string | undefined {
	const e = env as { USER_SESSION_SECRET?: string } | undefined;
	const direct = e?.USER_SESSION_SECRET?.trim();
	if (direct) return direct;

	// 本地 dev：cf-dev-shim 的 env 只带 DB/BUCKET/SESSION_SECRET，
	// 其余变量由 loadAdminEnv 把 .dev.vars/.env 灌进 process.env 后兜底读取
	if (typeof process !== "undefined" && process.env) {
		loadAdminEnv();
		return process.env.USER_SESSION_SECRET?.trim() || undefined;
	}
	return undefined;
}

export interface UserSessionPayload {
	u: string; // users.id
	role: string;
	exp: number;
}

/** users 表安全投影（密码哈希永不外泄） */
export interface AuthUser {
	id: string;
	email: string;
	email_verified: number;
	name: string;
	avatar: string;
	bio: string;
	role: string;
	banned: number;
	created_at: string;
}

// ---------- 密钥 ----------

export function getUserSecret(env?: UserSessionEnv): string {
	const secret = readInjectedSecret(env);
	if (secret) return secret;

	throw new Error(
		"USER_SESSION_SECRET 未配置。该密钥是前台用户会话签名密钥，用户无法登录。请在 Cloudflare Secrets 中设置 USER_SESSION_SECRET。",
	);
}

/** 读取侧降级：密钥缺失时返回 null 而非抛错，避免公开接口 500 */
function getUserSecretQuietly(env?: UserSessionEnv): string | null {
	try {
		return getUserSecret(env);
	} catch {
		return null;
	}
}

// ---------- 签名 ----------

function base64urlEncode(input: string) {
	if (typeof btoa === "function")
		return btoa(input)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");

	return Buffer.from(input, "utf8").toString("base64url");
}

function base64urlDecode(input: string) {
	const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
	const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);

	if (typeof atob === "function") return atob(padded);

	return Buffer.from(padded, "base64").toString("utf8");
}

async function hmacSign(payload: string, secret: string) {
	const key = await crypto.subtle.importKey(
		"raw",
		new TextEncoder().encode(secret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const signature = await crypto.subtle.sign(
		"HMAC",
		key,
		new TextEncoder().encode(payload),
	);
	const bytes = new Uint8Array(signature);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);

	if (typeof btoa === "function")
		return btoa(binary)
			.replace(/\+/g, "-")
			.replace(/\//g, "_")
			.replace(/=+$/, "");

	return Buffer.from(bytes).toString("base64url");
}

// ---------- 签发 / 校验 ----------

/**
 * 签发 user_session token。
 * @param maxAgeSeconds 缺省 30 天；传 undefined 时 exp 按 30 天（浏览器会话 cookie 由 builder 控制持久性）
 */
export async function createSessionToken(
	userId: string,
	role: string,
	env?: UserSessionEnv,
	maxAgeSeconds: number = USER_SESSION_MAX_AGE,
) {
	const secret = getUserSecret(env);
	const exp = Date.now() + maxAgeSeconds * 1000;
	const payload = base64urlEncode(
		JSON.stringify({ u: userId, exp, role } satisfies UserSessionPayload),
	);
	const sig = await hmacSign(payload, secret);
	return `${payload}.${sig}`;
}

/** 校验 token，成功返回载荷，失败 null */
export async function getSessionPayload(
	token: string,
	env?: UserSessionEnv,
): Promise<UserSessionPayload | null> {
	const secret = getUserSecretQuietly(env);
	if (!secret || !token) return null;

	const [payload, sig] = token.split(".");
	if (!payload || !sig) return null;

	const expected = await hmacSign(payload, secret);
	if (!constantTimeEqual(expected, sig)) return null;

	try {
		const data = JSON.parse(base64urlDecode(payload)) as UserSessionPayload;
		if (!data.exp || Date.now() > data.exp) return null;
		if (!data.u) return null;
		return data;
	} catch {
		return null;
	}
}

// ---------- Cookie ----------

export function getCookieValue(
	cookieHeader: string | null | undefined,
	name: string,
) {
	if (!cookieHeader) return null;

	for (const part of cookieHeader.split(";")) {
		const [rawKey, ...rest] = part.trim().split("=");
		if (rawKey !== name) continue;
		const raw = rest.join("=");
		try {
			return decodeURIComponent(raw);
		} catch {
			return raw;
		}
	}

	return null;
}

/** 请求是否携带 user_session（middleware 用它跳过 HTML 缓存） */
export function hasUserSessionCookie(cookieHeader: string | null | undefined) {
	if (!cookieHeader) return false;
	return /(?:^|;\s*)user_session=/.test(cookieHeader);
}

/**
 * 构造 Set-Cookie。
 * @param persistent true=记住我（Max-Age 30 天）；false=浏览器会话级（不带 Max-Age，关浏览器即失效）
 */
export function buildUserSessionCookie(
	token: string,
	secure: boolean,
	persistent = true,
) {
	const parts = [
		`${USER_SESSION_COOKIE}=${encodeURIComponent(token)}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
	];
	if (persistent) parts.push(`Max-Age=${USER_SESSION_MAX_AGE}`);
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

export function buildClearUserSessionCookie(secure: boolean) {
	const parts = [
		`${USER_SESSION_COOKIE}=`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		"Max-Age=0",
	];
	if (secure) parts.push("Secure");
	return parts.join("; ");
}

// ---------- 请求态 ----------

/**
 * 取当前请求的登录用户（查 users 表；封禁/会话无效返回 null）。
 * 评论、点赞等后续模块统一用它取登录态。
 */
export async function getAuthUser(
	request: Request,
	env?: UserSessionEnv,
): Promise<AuthUser | null> {
	const token = getCookieValue(
		request.headers.get("Cookie"),
		USER_SESSION_COOKIE,
	);
	if (!token) return null;

	const payload = await getSessionPayload(token, env);
	if (!payload) return null;

	const db = (env as CloudflareEnv | undefined)?.DB;
	if (!db) return null;

	let row: AuthUser | null;
	try {
		row = await db
			.prepare(
				`SELECT id, email, email_verified, name, avatar, bio, role, banned, created_at
         FROM users WHERE id = ?`,
			)
			.bind(payload.u)
			.first<AuthUser>();
	} catch {
		return null;
	}
	if (!row) return null;
	if (row.banned === 1) return null;
	return row;
}

// ---------- CSRF：写 API Origin 校验（设计 G.3） ----------
// 实现已抽到 server/utils/csrf.ts（便于中间件集中调用），此处再导出保持既有引用可用。
export { isSameOriginRequest, originForbiddenResponse } from "../utils/csrf";

// ---------- 个人资料校验（profile 更新用） ----------

/** 校验 profile 更新字段；返回 null 表示通过，否则为用户可读错误文案。未提供的字段（undefined）跳过。 */
export function validateProfilePatch(patch: {
	name?: string;
	avatar?: string;
	bio?: string;
}): string | null {
	if (patch.name !== undefined) {
		const v = patch.name.trim();
		if (!v) return "昵称不能为空";
		if (v.length > 30) return "昵称最多 30 个字符";
	}
	if (patch.avatar !== undefined) {
		const v = patch.avatar.trim();
		if (v.length > 500) return "头像地址过长";
		if (
			v &&
			!v.startsWith("/") &&
			!/^https?:\/\/[^\s]+$/i.test(v)
		)
			return "头像地址需为站内路径或 http(s) 链接";
	}
	if (patch.bio !== undefined) {
		const v = patch.bio.trim();
		if (v.length > 500) return "个人简介最多 500 字";
	}
	return null;
}

// ---------- 密码工具（与 admin 同参：bcryptjs $2b$ 10 轮，实现见 ./password） ----------
export { hashPassword, isBcryptHash } from "./password";

/**
 * 校验密码。若库里存的是明文（站长手工写库的场景），恒定时间比对通过后，
 * 只要传入 onUpgrade 就自动回写为 bcrypt 哈希（只升级一次）。
 */
export async function verifyPassword(
	password: string,
	hash: string,
	onUpgrade?: (newHash: string) => Promise<void>,
): Promise<boolean> {
	return verifyPasswordAllowPlaintext(
		password,
		hash,
		onUpgrade ?? (async () => {}),
		USER_BCRYPT_ROUNDS,
	);
}
