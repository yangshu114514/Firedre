// 注册 / 邮箱验证 / Turnstile（设计 DESIGN-USER-SYSTEM.md D.1、D.4）
// 防枚举：注册与重发接口对「邮箱是否存在」返回完全一致的文案，差异只留在服务端日志

import type { CloudflareEnv } from "../../types/env";
import { loadAdminEnv } from "./loadAdminEnv";
import { hashPassword } from "./userSession";
import { renderVerifyEmail, sendMail, type MailEnv } from "../mail/brevo";

export const SIGNUP_VERIFY_HOURS = 24;
export const PASSWORD_MIN_LENGTH = 8;
export const NAME_MAX_LENGTH = 30;
export const EMAIL_MAX_LENGTH = 254;

export interface RegisterEnv extends MailEnv {
	TURNSTILE_SECRET_KEY?: string;
}

// ---------- 基础校验 ----------

export function normalizeEmail(raw: string): string {
	return raw.trim().toLowerCase();
}

export function isValidEmail(email: string): boolean {
	if (!email || email.length > EMAIL_MAX_LENGTH) return false;
	// 轻量格式校验（不做域名 MX，避免 Workers 额外网络依赖）
	return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** 返回 null 表示通过，否则为用户可读错误文案 */
export function validatePassword(pw: string): string | null {
	if (!pw) return "密码不能为空";
	if (pw.length < PASSWORD_MIN_LENGTH)
		return `密码至少 ${PASSWORD_MIN_LENGTH} 位`;
	if (pw.length > 128) return "密码过长（最多 128 位）";
	return null;
}

export function validateName(name: string): string | null {
	const v = name.trim();
	if (!v) return "昵称不能为空";
	if (v.length > NAME_MAX_LENGTH) return `昵称最多 ${NAME_MAX_LENGTH} 个字符`;
	return null;
}

/** 本地 dev：cf-dev-shim 的 env 不带自定义变量，空值时兜底读 process.env（.dev.vars 已由 shim 灌入） */
function resolveVar(value: string | undefined, key: string): string | undefined {
	if (value?.trim()) return value.trim();
	if (typeof process !== "undefined" && process.env) {
		loadAdminEnv();
		return process.env[key]?.trim() || undefined;
	}
	return undefined;
}

// ---------- token 工具 ----------

function randomToken(bytes = 32): string {
	const arr = crypto.getRandomValues(new Uint8Array(bytes));
	return [...arr].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function sha256Hex(input: string): Promise<string> {
	const buf = await crypto.subtle.digest(
		"SHA-256",
		new TextEncoder().encode(input),
	);
	return [...new Uint8Array(buf)]
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

// ---------- Turnstile（D.4：仅 register/login 校验） ----------

export interface TurnstileResult {
	ok: boolean;
	message?: string;
}

function isLoopbackHost(host?: string): boolean {
	if (!host) return false;
	const h = host.toLowerCase().split(":")[0];
	return (
		h === "localhost" ||
		h === "127.0.0.1" ||
		h === "[::1]" ||
		h === "::1" ||
		h === "0.0.0.0"
	);
}

/**
 * 是否必须强制人机校验。判定为「需要强制」时，密钥缺失必须 fail-closed。
 *
 * - 本地回环地址：视为开发环境，允许在未配密钥时跳过（保证 .dev.vars 未配时的本地体验）；
 *   但若显式声明 ENVIRONMENT=prod，本地也强制。
 * - 任何非本地部署（含 Pages 预览域与正式域）：一律强制。
 *   避免密钥被误删/漏配时，线上人机校验「静默关闭」而无人察觉。
 */
function shouldEnforceTurnstile(
	env: RegisterEnv,
	requestHost?: string,
): boolean {
	if (isLoopbackHost(requestHost)) {
		const tag = resolveVar(env.ENVIRONMENT, "ENVIRONMENT")?.trim().toLowerCase();
		return tag === "prod" || tag === "production";
	}
	return true;
}

/**
 * 服务端 siteverify。
 * - 未配置 TURNSTILE_SECRET_KEY：本地开发跳过并告警；**非本地部署一律拒绝（fail-closed）**；
 * - 已配置：token 缺失或校验失败一律拒绝；网络故障同样拒绝（绝不放行）。
 */
export async function verifyTurnstile(
	env: RegisterEnv,
	token: string,
	remoteip: string,
	requestHost?: string,
): Promise<TurnstileResult> {
	const secret = resolveVar(env.TURNSTILE_SECRET_KEY, "TURNSTILE_SECRET_KEY");
	if (!secret) {
		if (shouldEnforceTurnstile(env, requestHost)) {
			console.error(
				"[turnstile] 未配置 TURNSTILE_SECRET_KEY，本环境强制人机校验 → 已拒绝本次请求（fail-closed）。" +
					"请检查 Cloudflare 环境变量是否被清空。",
			);
			return {
				ok: false,
				message: "人机验证服务暂不可用，请稍后再试",
			};
		}
		console.warn(
			"[turnstile] TURNSTILE_SECRET_KEY 未配置，跳过人机校验（本地开发）",
		);
		return { ok: true };
	}
	if (!token) return { ok: false, message: "请完成人机验证" };

	const remoteIp = remoteip?.trim();
	try {
		const body = new URLSearchParams({
			secret,
			response: token,
		});
		if (remoteIp) body.set("remoteip", remoteIp);

		const r = await fetch(
			"https://challenges.cloudflare.com/turnstile/v0/siteverify",
			{ method: "POST", body },
		);
		const data = (await r.json().catch(() => null)) as {
			success?: boolean;
			"error-codes"?: string[];
		} | null;
		if (data?.success) return { ok: true };
		console.warn("[turnstile] 校验失败:", data?.["error-codes"] || r.status);
		return { ok: false, message: "人机验证未通过，请重试" };
	} catch (e) {
		// 网络故障：拒绝而非放行，避免人机校验被静默绕过
		console.error("[turnstile] siteverify 请求异常:", e);
		return { ok: false, message: "人机验证服务不可用，请稍后再试" };
	}
}

// ---------- 注册 ----------

export interface RegisterInput {
	email: string;
	name: string;
	password: string;
}

export type RegisterOutcome =
	| { kind: "created" }
	| { kind: "duplicate" } // 邮箱已存在（对客户端不外泄，响应与 created 一致）
	| { kind: "invalid"; message: string };

interface UserRow {
	id: string;
	email_verified: number;
}

/** 建号（未验证）+ 生成验证 token + 发信；发信失败不改变结果（落库即注册成功） */
export async function registerUser(
	db: D1Database,
	env: RegisterEnv,
	input: RegisterInput,
	siteOrigin: string,
	siteName: string,
): Promise<RegisterOutcome> {
	const email = normalizeEmail(input.email);
	const name = input.name.trim();

	if (!isValidEmail(email)) return { kind: "invalid", message: "邮箱格式不正确" };
	const nameErr = validateName(name);
	if (nameErr) return { kind: "invalid", message: nameErr };
	const pwErr = validatePassword(input.password);
	if (pwErr) return { kind: "invalid", message: pwErr };

	const existing = await db
		.prepare("SELECT id, email_verified FROM users WHERE email = ?")
		.bind(email)
		.first<UserRow>();

	if (existing) {
		// 防枚举：对调用方返回 duplicate，由 API 层渲染与 created 完全相同的响应；
		// 额度控制——仅「已注册但未验证」的账号重发验证信（限流在 API 层兜底）
		if (existing.email_verified !== 1) {
			await issueSignupVerification(db, env, existing.id, email, siteOrigin, siteName);
		}
		return { kind: "duplicate" };
	}

	let passwordHash: string;
	try {
		passwordHash = await hashPassword(input.password);
	} catch (e) {
		console.error("[register] bcrypt 失败:", e);
		return { kind: "invalid", message: "密码处理失败，请稍后再试" };
	}

	let userId: string;
	try {
		userId = crypto.randomUUID();
		await db
			.prepare(
				`INSERT INTO users (id, email, email_verified, name, password, role, banned)
         VALUES (?, ?, 0, ?, ?, 'user', 0)`,
			)
			.bind(userId, email, name, passwordHash)
			.run();
	} catch (e) {
		// 唯一索引并发冲突：视作已存在
		console.warn("[register] INSERT users 冲突:", e);
		return { kind: "duplicate" };
	}

	await issueSignupVerification(db, env, userId, email, siteOrigin, siteName);
	return { kind: "created" };
}

/** 生成一次性 signup token：库存 sha256，明文只进邮件链接；24h 有效 */
async function issueSignupVerification(
	db: D1Database,
	env: RegisterEnv,
	userId: string,
	email: string,
	siteOrigin: string,
	siteName: string,
): Promise<void> {
	try {
		const token = randomToken(32);
		const tokenHash = await sha256Hex(token);

		// 同用户同 purpose 只保留最新一条未使用的
		await db
			.prepare(
				"DELETE FROM email_verifications WHERE user_id = ? AND purpose = 'signup' AND used_at IS NULL",
			)
			.bind(userId)
			.run();
		await db
			.prepare(
				`INSERT INTO email_verifications (id, user_id, token_hash, purpose, expires_at)
         VALUES (?, ?, ?, 'signup', datetime('now', '+${SIGNUP_VERIFY_HOURS} hours'))`,
			)
			.bind(crypto.randomUUID(), userId, tokenHash)
			.run();

		// 站点 trailingSlash:"always"，路径必须带尾斜杠否则 404
		const verifyUrl = `${siteOrigin}/verify/?token=${encodeURIComponent(token)}`;
		// 失败不抛出：注册以落库为准，可走重发按钮（设计 G.6）
		await sendMail(env, {
			to: email,
			subject: `验证你的邮箱 - ${siteName}`,
			html: renderVerifyEmail({
				siteName,
				verifyUrl,
				expireHours: SIGNUP_VERIFY_HOURS,
			}),
		});
	} catch (e) {
		console.error("[register] 发送验证邮件失败:", e);
	}
}

// ---------- 验证 ----------

export type VerifyOutcome =
	| { ok: true; userId: string }
	| { ok: false; reason: "invalid" | "expired" };

/** hash 比对 → 置 email_verified=1 → 标记 token 已用 */
export async function verifySignupToken(
	db: D1Database,
	token: string,
): Promise<VerifyOutcome> {
	if (!token || token.length > 128) return { ok: false, reason: "invalid" };
	const tokenHash = await sha256Hex(token);

	const row = await db
		.prepare(
			`SELECT id, user_id FROM email_verifications
       WHERE token_hash = ? AND purpose = 'signup' AND used_at IS NULL
       ORDER BY created_at DESC LIMIT 1`,
		)
		.bind(tokenHash)
		.first<{ id: string; user_id: string }>();

	if (!row) {
		// 区分「从未存在/已用」与「过期」都对用户呈现同一只读文案，此处仅日志区分
		const used = await db
			.prepare(
				"SELECT id FROM email_verifications WHERE token_hash = ? AND purpose = 'signup' LIMIT 1",
			)
			.bind(tokenHash)
			.first<{ id: string }>();
		return { ok: false, reason: used ? "expired" : "invalid" };
	}

	const fresh = await db
		.prepare(
			"SELECT id FROM email_verifications WHERE id = ? AND expires_at > datetime('now')",
		)
		.bind(row.id)
		.first<{ id: string }>();
	if (!fresh) return { ok: false, reason: "expired" };

	try {
		// 不用 db.batch：cf-dev-shim 的本地 D1 仅实现 prepare（兼容 dev/生产两条路径）
		await db
			.prepare(
				"UPDATE users SET email_verified = 1, updated_at = datetime('now') WHERE id = ?",
			)
			.bind(row.user_id)
			.run();
		await db
			.prepare(
				"UPDATE email_verifications SET used_at = datetime('now') WHERE id = ?",
			)
			.bind(row.id)
			.run();
	} catch (e) {
		console.error("[verify] 激活失败:", e);
		return { ok: false, reason: "invalid" };
	}

	return { ok: true, userId: row.user_id };
}

/**
 * 重发验证邮件（防枚举：邮箱不存在/已验证也返回成功，且不发信）。
 * 库内只存 hash、明文不可恢复，故直接签发新 token 并作废旧的未使用记录
 * （内部 issueSignupVerification 先 DELETE 未使用的再 INSERT）。
 */
export async function resendVerification(
	db: D1Database,
	env: RegisterEnv,
	rawEmail: string,
	siteOrigin: string,
	siteName: string,
): Promise<void> {
	const email = normalizeEmail(rawEmail);
	if (!isValidEmail(email)) return;

	try {
		const user = await db
			.prepare("SELECT id, email_verified FROM users WHERE email = ?")
			.bind(email)
			.first<UserRow>();
		if (!user || user.email_verified === 1) return;

		await issueSignupVerification(
			db,
			env,
			user.id,
			email,
			siteOrigin,
			siteName,
		);
	} catch (e) {
		console.error("[resend] 重发验证邮件失败:", e);
	}
}
