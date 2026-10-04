// 文章点赞 API（设计 DESIGN-USER-SYSTEM.md C）
//   GET  /api/likes?slug=<slug>   读计数 + 当前用户是否已赞（匿名也可见计数）
//   POST /api/likes/toggle        切换点赞（需登录；幂等，一人一文一赞可取消）

import {
	getAuthUser,
	isSameOriginRequest,
	originForbiddenResponse,
} from "@server/auth/userSession";
import { getLikeState, toggleLike } from "@server/likes/service";
import { withRateLimit } from "@server/utils/rateLimiter";
import type { APIRoute } from "astro";
import {
	cfEnv,
	fromServiceError,
	json,
	methodNotAllowed,
	notFound,
} from "../../../lib/api";
import { pathSegments } from "../../../lib/routePath";

export const prerender = false;

// ---------- GET ----------

export const GET: APIRoute = async ({ params, request, url }) => {
	const action = pathSegments(params)[0] || "";

	try {
		if (action) return notFound();

		const slug = url.searchParams.get("slug") || "";
		if (!slug) return notFound("缺少 slug");

		const me = await getAuthUser(request, cfEnv);
		const state = await getLikeState(cfEnv.DB, slug, me?.id ?? null);
		return json(
			{
				...state,
				authenticated: Boolean(me),
			},
			200,
			me ? "private" : "default",
		);
	} catch (error) {
		return fromServiceError(error);
	}
};

// ---------- POST ----------

export const POST: APIRoute = async ({ params, request }) => {
	const action = pathSegments(params)[0] || "";

	// 所有写 API 校验 Origin（设计 G.3 CSRF）
	if (!isSameOriginRequest(request)) return originForbiddenResponse();

	try {
		if (action !== "toggle") return notFound();

		const me = await getAuthUser(request, cfEnv);
		if (!me) return json({ message: "请先登录", needLogin: true }, 401);

		// 点赞是轻量动作，按 IP 给一个宽松上限（60 次/分钟），scope 独立
		return await withRateLimit(
			cfEnv,
			request,
			{ windowMs: 60_000, maxRequests: 60, scope: "post-like" },
			async () => {
				const body = (await request.json().catch(() => null)) as {
					slug?: string;
				} | null;
				if (!body?.slug) return json({ message: "缺少 slug" }, 400);

				const state = await toggleLike(
					cfEnv.DB,
					String(body.slug),
					me.id,
				);
				return json({ ok: true, ...state }, 200, "private");
			},
		);
	} catch (error) {
		return fromServiceError(error);
	}
};

export const ALL: APIRoute = async () => methodNotAllowed(["GET", "POST"]);
