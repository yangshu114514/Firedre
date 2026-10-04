// 原生评论 API（设计 DESIGN-USER-SYSTEM.md C/D.3/B.4）
// 路由风格仿 src/pages/api/auth/[...path].ts：每域一个 catch-all，按 action 分发
//   GET  /api/comments?target=<slug|guestbook>&page=&pageSize=   前台列表（approved + 自己的 pending）
//   GET  /api/comments/admin?status=pending&page=                后台列表（需管理员）
//   POST /api/comments                                            提交（登录直发 / 匿名待审）
//   POST /api/comments/moderate                                   审核动作（需管理员）

import { verifyAdminRequest } from "@server/auth/adminSession";
import {
	getAuthUser,
	isSameOriginRequest,
	originForbiddenResponse,
} from "@server/auth/userSession";
import {
	COMMENT_PAGE_SIZE,
	listComments,
	listCommentsForAdmin,
	moderateComment,
	submitComment,
	type ModerateAction,
} from "@server/comments/service";
import { withRateLimit } from "@server/utils/rateLimiter";
import type { APIRoute } from "astro";
import {
	cfEnv,
	fromServiceError,
	json,
	methodNotAllowed,
	notFound,
	unauthorized,
} from "../../../lib/api";
import { pathSegments } from "../../../lib/routePath";

export const prerender = false;

const MODERATE_ACTIONS: ModerateAction[] = ["approve", "spam", "delete"];

// ---------- GET ----------

export const GET: APIRoute = async ({ params, request, url }) => {
	const segments = pathSegments(params);
	const action = segments[0] || "";

	try {
		// 后台列表：管理员鉴权
		if (action === "admin") {
			const isAdmin = await verifyAdminRequest(request, cfEnv);
			if (!isAdmin) return unauthorized();

			const result = await listCommentsForAdmin(cfEnv.DB, {
				status: url.searchParams.get("status") || "pending",
				page: Number(url.searchParams.get("page") || 1),
				pageSize: Number(url.searchParams.get("pageSize") || 20),
			});
			return json(result, 200, "private");
		}

		if (action) return notFound();

		// 前台列表（读方法无需 Origin 校验；登录态决定是否可见自己的 pending）
		const target = url.searchParams.get("target") || "";
		if (!target) return notFound("缺少 target");

		const me = await getAuthUser(request, cfEnv);
		const result = await listComments(cfEnv.DB, {
			target,
			page: Number(url.searchParams.get("page") || 1),
			pageSize: Number(url.searchParams.get("pageSize") || COMMENT_PAGE_SIZE),
			viewerId: me?.id ?? null,
		});
		// 含登录态判断的响应不能被共享缓存
		return json(result, 200, me ? "private" : "default");
	} catch (error) {
		return fromServiceError(error);
	}
};

// ---------- POST ----------

export const POST: APIRoute = async ({ params, request }) => {
	const segments = pathSegments(params);
	const action = segments[0] || "";

	// 所有写 API 校验 Origin（设计 G.3 CSRF）
	if (!isSameOriginRequest(request)) return originForbiddenResponse();

	try {
		// ── 后台审核动作（B.4）──
		if (action === "moderate") {
			const isAdmin = await verifyAdminRequest(request, cfEnv);
			if (!isAdmin) return unauthorized();

			const body = (await request.json().catch(() => null)) as {
				id?: string;
				action?: string;
			} | null;
			if (!body?.id) return json({ message: "缺少评论 id" }, 400);
			if (
				!body.action ||
				!MODERATE_ACTIONS.includes(body.action as ModerateAction)
			)
				return json({ message: "未知的审核动作" }, 400);

			const result = await moderateComment(
				cfEnv.DB,
				String(body.id),
				body.action as ModerateAction,
			);
			return json({ ...result, status: body.action });
		}

		if (action) return notFound();

		// ── 提交评论（B.4 限流：匿名 3 条/10 分/IP，登录 20 条/10 分；
		//    scope='comment' 独立于 user-login/register，key 还带 maxRequests 故两档互不串）──
		const me = await getAuthUser(request, cfEnv);

		// 未验证的登录账号：直接拒绝并提示先验证邮箱（B.4）
		if (me && me.email_verified !== 1) {
			return json(
				{ message: "请先完成邮箱验证后再评论", needVerify: true },
				403,
			);
		}

		const limit = me
			? { windowMs: 10 * 60_000, maxRequests: 20, scope: "comment" }
			: {
					windowMs: 10 * 60_000,
					maxRequests: 3,
					scope: "comment",
					message: "评论过于频繁，请稍后再试",
				};

		return await withRateLimit(cfEnv, request, limit, async () => {
			const body = (await request.json().catch(() => null)) as {
				target?: string;
				content?: string;
				guestName?: string;
				guestEmail?: string;
				parentId?: string;
			} | null;
			if (!body) return json({ message: "请求体格式错误" }, 400);

			const outcome = await submitComment(
				cfEnv.DB,
				{
					target: String(body.target || ""),
					content: String(body.content || ""),
					guestName: body.guestName,
					guestEmail: body.guestEmail,
					parentId: body.parentId || null,
					ip: request.headers.get("CF-Connecting-IP") || "unknown",
				},
				me ? { id: me.id, name: me.name, avatar: me.avatar } : null,
			);

			return json(
				{
					ok: true,
					status: outcome.status,
					comment: outcome.comment,
					message:
						outcome.status === "approved"
							? "评论已发布"
							: "评论已提交，审核后展示",
				},
				200,
				"private",
			);
		});
	} catch (error) {
		return fromServiceError(error);
	}
};

export const ALL: APIRoute = async () => methodNotAllowed(["GET", "POST"]);
