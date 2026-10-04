// 前台用户认证 API（设计 DESIGN-USER-SYSTEM.md C/D.1/D.4/G.3）
// 路由风格仿 src/pages/api/admin/[...path].ts：每域一个 catch-all，按 action 分发
// OAuth（oauth/<provider>/start|callback，GET 302）已在下方 GET 分支接线，走 server/auth/oauth.ts

import {
	isSameOriginRequest,
	originForbiddenResponse,
	buildUserSessionCookie,
	buildClearUserSessionCookie,
	createSessionToken,
	getAuthUser,
	hashPassword,
	verifyPassword,
	validateProfilePatch,
	type AuthUser,
} from "@server/auth/userSession";
import {
	registerUser,
	resendVerification,
	verifyTurnstile,
	validatePassword,
	type RegisterEnv,
} from "@server/auth/register";
import {
	handleOauthStart,
	handleOauthCallback,
	isOAuthProvider,
} from "@server/auth/oauth";
import { withRateLimit } from "@server/utils/rateLimiter";
import { getRequestClientIp } from "@server/auth/loginRateLimit";
import { verifyAdminRequest } from "@server/auth/adminSession";
import type { APIRoute } from "astro";
import {
	cfEnv,
	json,
	unauthorized,
	methodNotAllowed,
	serverError,
} from "../../../lib/api";
import { pathSegments } from "../../../lib/routePath";

export const prerender = false;

function jsonWithHeaders(
	data: unknown,
	status = 200,
	extraHeaders: Record<string, string> = {},
) {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			...extraHeaders,
		},
	});
}

/** 站点 origin（验证邮件链接用） */
function siteOriginOf(request: Request): string {
	return new URL(request.url).origin;
}

/** 站点名（邮件主题用），读失败回退 Firedre */
async function siteNameOf(): Promise<string> {
	try {
		const row = await cfEnv.DB.prepare(
			"SELECT value FROM site_settings WHERE key = 'basic'",
		).first<{ value: string }>();
		if (row?.value) {
			const v = JSON.parse(row.value) as { title?: string };
			if (v.title?.trim()) return v.title.trim();
		}
	} catch {
		// 忽略，用默认名
	}
	return "Firedre";
}

function publicUser(u: AuthUser) {
	return {
		id: u.id,
		email: u.email,
		emailVerified: u.email_verified === 1,
		name: u.name,
		avatar: u.avatar,
		bio: u.bio,
		role: u.role,
		createdAt: u.created_at,
	};
}

// ---------- POST ----------

export const POST: APIRoute = async ({ params, request }) => {
	const segments = pathSegments(params);
	const action = segments[0] || "";
	const registerEnv = cfEnv as RegisterEnv;
	const secure = new URL(request.url).protocol === "https:";

	// 所有写 API 校验 Origin（设计 G.3 CSRF）
	if (!isSameOriginRequest(request)) return originForbiddenResponse();

	try {
		// ── 注册（防枚举：无论邮箱是否已存在，响应完全一致） ──
		if (action === "register") {
			return await withRateLimit(
				cfEnv,
				request,
				{
					windowMs: 60 * 60_000, // 3 次/时/IP（D.1）
					maxRequests: 3,
					scope: "register",
				},
				async () => {
					const body = (await request.json().catch(() => null)) as {
						email?: string;
						name?: string;
						password?: string;
						turnstileToken?: string;
					} | null;
					if (!body) return json({ message: "请求体格式错误" }, 400);

					const turnstile = await verifyTurnstile(
						registerEnv,
						String(body.turnstileToken || ""),
						getRequestClientIp(request),
					);
					if (!turnstile.ok)
						return json({ message: turnstile.message || "人机验证未通过" }, 403);

					const outcome = await registerUser(
						cfEnv.DB,
						registerEnv,
						{
							email: String(body.email || ""),
							name: String(body.name || ""),
							password: String(body.password || ""),
						},
						siteOriginOf(request),
						await siteNameOf(),
					);

					if (outcome.kind === "invalid")
						return json({ message: outcome.message }, 400);

					// created 与 duplicate 同响应（防枚举）
					return jsonWithHeaders({
						ok: true,
						message:
							"注册提交成功！我们已向你的邮箱发送验证链接，请查收并完成验证（24 小时内有效）。",
					});
				},
			);
		}

		// ── 重发验证邮件（3 次/时/IP，统一响应防枚举） ──
		if (action === "resend") {
			return await withRateLimit(
				cfEnv,
				request,
				{
					windowMs: 60 * 60_000,
					maxRequests: 3,
					scope: "verify-resend",
				},
				async () => {
					const body = (await request.json().catch(() => null)) as {
						email?: string;
					} | null;
					if (!body || !String(body.email || "").trim())
						return json({ message: "请输入邮箱" }, 400);

					await resendVerification(
						cfEnv.DB,
						registerEnv,
						String(body.email),
						siteOriginOf(request),
						await siteNameOf(),
					);
					return jsonWithHeaders({
						ok: true,
						message:
							"如果该邮箱已注册且尚未验证，验证邮件已发送，请查收。",
					});
				},
			);
		}

		// ── 登录（允许未验证账号登录；限流与后台 'login' 锁互不干扰） ──
		if (action === "login") {
			return await withRateLimit(
				cfEnv,
				request,
				{
					windowMs: 15 * 60_000, // 8 次/15 分钟/IP
					maxRequests: 8,
					scope: "user-login",
				},
				async () => {
					const body = (await request.json().catch(() => null)) as {
						email?: string;
						password?: string;
						remember?: boolean;
						turnstileToken?: string;
					} | null;
					if (!body) return json({ message: "请求体格式错误" }, 400);

					const turnstile = await verifyTurnstile(
						registerEnv,
						String(body.turnstileToken || ""),
						getRequestClientIp(request),
					);
					if (!turnstile.ok)
						return json({ message: turnstile.message || "人机验证未通过" }, 403);

					const email = String(body.email || "").trim().toLowerCase();
					const password = String(body.password || "");
					if (!email || !password)
						return json({ message: "邮箱与密码不能为空" }, 400);

					const user = await cfEnv.DB.prepare(
						`SELECT id, email, email_verified, name, avatar, bio, role, banned, created_at, password
             FROM users WHERE email = ?`,
					)
						.bind(email)
						.first<AuthUser & { password: string }>();

					// 统一失败文案（不区分邮箱不存在/密码错误）
					if (!user) return json({ message: "邮箱或密码错误" }, 401);

					const valid = await verifyPassword(password, user.password);
					if (!valid)
						return json({ message: "邮箱或密码错误" }, 401);

					if (user.banned === 1)
						return json({ message: "该账号已被封禁" }, 403);

					const token = await createSessionToken(user.id, user.role, cfEnv);
					const remember = body.remember !== false;
					return jsonWithHeaders(
						{
							ok: true,
							user: publicUser(user),
						},
						200,
						{ "Set-Cookie": buildUserSessionCookie(token, secure, remember) },
					);
				},
			);
		}

		// ── 退出登录 ──
		if (action === "logout") {
			return jsonWithHeaders({ ok: true }, 200, {
				"Set-Cookie": buildClearUserSessionCookie(secure),
			});
		}

		// ── 用户管理：封禁/解封（管理员鉴权；封禁=登录 403 + getAuthUser 拒绝，即时生效） ──
		if (action === "admin-users") {
			const isAdmin = await verifyAdminRequest(request, cfEnv);
			if (!isAdmin) return unauthorized();

			const body = (await request.json().catch(() => null)) as {
				id?: string;
				action?: string;
			} | null;
			if (!body?.id) return json({ message: "缺少用户 id" }, 400);
			if (body.action !== "ban" && body.action !== "unban")
				return json({ message: "未知的用户管理动作" }, 400);

			const exists = await cfEnv.DB.prepare(
				"SELECT id FROM users WHERE id = ?",
			)
				.bind(String(body.id))
				.first<{ id: string }>();
			if (!exists) return json({ message: "用户不存在" }, 404);

			const banned = body.action === "ban" ? 1 : 0;
			await cfEnv.DB.prepare(
				"UPDATE users SET banned = ?, updated_at = datetime('now') WHERE id = ?",
			)
				.bind(banned, String(body.id))
				.run();

			return json({ ok: true, banned });
		}

		// ── 更新个人资料（昵称/头像/bio） ──
		if (action === "profile") {
			const me = await getAuthUser(request, cfEnv);
			if (!me) return json({ message: "请先登录" }, 401);

			const body = (await request.json().catch(() => null)) as {
				name?: string;
				avatar?: string;
				bio?: string;
			} | null;
			if (!body) return json({ message: "请求体格式错误" }, 400);

			const patchErr = validateProfilePatch({
				name: body.name,
				avatar: body.avatar,
				bio: body.bio,
			});
			if (patchErr) return json({ message: patchErr }, 400);

			await cfEnv.DB.prepare(
				`UPDATE users SET name = ?, avatar = ?, bio = ?, updated_at = datetime('now')
         WHERE id = ?`,
			)
				.bind(
					(body.name ?? me.name).trim(),
					String(body.avatar ?? me.avatar).trim(),
					String(body.bio ?? me.bio).trim(),
					me.id,
				)
				.run();

			const updated = await getAuthUser(request, cfEnv);
			return jsonWithHeaders({ ok: true, user: updated ? publicUser(updated) : null });
		}

		// ── 修改密码（需当前密码；无状态会话无法吊销旧 cookie，改密后其余设备最迟 30 天自然过期） ──
		if (action === "password") {
			const me = await getAuthUser(request, cfEnv);
			if (!me) return json({ message: "请先登录" }, 401);

			const body = (await request.json().catch(() => null)) as {
				currentPassword?: string;
				newPassword?: string;
			} | null;
			if (!body) return json({ message: "请求体格式错误" }, 400);

			const current = String(body.currentPassword || "");
			const next = String(body.newPassword || "");
			if (!current || !next)
				return json({ message: "当前密码与新密码不能为空" }, 400);

			const pwErr = validatePassword(next);
			if (pwErr) return json({ message: pwErr }, 400);

			const row = await cfEnv.DB.prepare("SELECT password FROM users WHERE id = ?")
				.bind(me.id)
				.first<{ password: string }>();
			if (!row) return json({ message: "请先登录" }, 401);

			const valid = await verifyPassword(current, row.password);
			if (!valid) return json({ message: "当前密码不正确" }, 403);
			if (current === next) return json({ message: "新密码不能与当前密码相同" }, 400);

			await cfEnv.DB.prepare(
				"UPDATE users SET password = ?, updated_at = datetime('now') WHERE id = ?",
			)
				.bind(await hashPassword(next), me.id)
				.run();

			return jsonWithHeaders({ ok: true, message: "密码已更新" });
		}

		// ── OAuth 只走 GET（start/callback），POST 明确拒绝 ──
		if (segments[0] === "oauth") {
			return json({ message: "OAuth 登录仅支持 GET" }, 405);
		}

		return json({ message: "Not found" }, 404);
	} catch (error) {
		return serverError(error);
	}
};

// ---------- GET ----------

export const GET: APIRoute = async ({ params, request }) => {
	const segments = pathSegments(params);
	const action = segments[0] || "";

	try {
		// ── 用户管理：列表（后台面板用，管理员鉴权） ──
		if (action === "admin-users") {
			const isAdmin = await verifyAdminRequest(request, cfEnv);
			if (!isAdmin) return unauthorized();

			const url2 = new URL(request.url);
			const page = Math.max(1, Number(url2.searchParams.get("page") || 1));
			const pageSize = Math.min(
				100,
				Math.max(1, Number(url2.searchParams.get("pageSize") || 20)),
			);
			const q = String(url2.searchParams.get("q") || "").trim();
			const like = `%${q.replace(/([\\%_])/g, "\\$&")}%`;

			const where = q
				? "WHERE email LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\'"
				: "";
			const params = q ? [like, like] : [];

			const total = await cfEnv.DB.prepare(
				`SELECT count(*) AS n FROM users ${where}`,
			)
				.bind(...params)
				.first<{ n: number }>();

			const { results } = await cfEnv.DB.prepare(
				`SELECT u.id, u.email, u.name, u.avatar, u.email_verified, u.banned,
				        u.created_at,
				        (SELECT count(*) FROM oauth_accounts o WHERE o.user_id = u.id) AS oauth_count,
				        (SELECT count(*) FROM comments c WHERE c.user_id = u.id AND c.status != 'deleted') AS comment_count
				 FROM users u ${where}
				 ORDER BY u.created_at DESC
				 LIMIT ? OFFSET ?`,
			)
				.bind(...params, pageSize, (page - 1) * pageSize)
				.all();

			return json(
				{
					users: (results || []).map((r0: unknown) => {
						const row = r0 as Record<string, unknown>;
						return {
							...row,
							email_verified: Number(row.email_verified),
							banned: Number(row.banned),
						};
					}),
					total: total?.n ?? 0,
					page,
					pageSize,
				},
				200,
				"private",
			);
		}

		// 登录态：未登录也返回 200 + authenticated:false（前端自查用）
		if (action === "me") {
			const me = await getAuthUser(request, cfEnv);
			if (!me)
				return json({ authenticated: false, user: null }, 200, "private");
			return json(
				{ authenticated: true, user: publicUser(me) },
				200,
				"private",
			);
		}

		// ── OAuth：start（302 授权页）/ callback（换 token → 三分支 → 登录）（D.2） ──
		if (segments[0] === "oauth") {
			const provider = segments[1] || "";
			const sub = segments[2] || "";
			if (!isOAuthProvider(provider))
				return json({ message: "不支持的登录方式" }, 404);
			// 限流复用 withRateLimit 新 scope 'oauth'（10 分钟 30 次/IP，覆盖 start+callback）
			return await withRateLimit(
				cfEnv,
				request,
				{
					windowMs: 10 * 60_000,
					maxRequests: 30,
					scope: "oauth",
				},
				async () => {
					if (sub === "start") return handleOauthStart(cfEnv, request, provider);
					if (sub === "callback")
						return handleOauthCallback(cfEnv, request, provider);
					return json({ message: "Not found" }, 404);
				},
			);
		}

		return json({ message: "Not found" }, 404);
	} catch (error) {
		if (action === "me") return json({ authenticated: false, user: null }, 200, "private");
		return serverError(error);
	}
};

export const ALL: APIRoute = async () => methodNotAllowed(["GET", "POST"]);
