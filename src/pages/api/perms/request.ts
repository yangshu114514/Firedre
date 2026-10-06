// 前台：提交权限申请（如 post:create 发文权限），等待管理员审批
import type { APIRoute } from "astro";
import { requestPerm } from "@server/auth/perms";
import {
	getAuthUser,
	isSameOriginRequest,
	originForbiddenResponse,
} from "@server/auth/userSession";
import { withRateLimit } from "@server/utils/rateLimiter";
import { cfEnv, fromServiceError, json, methodNotAllowed } from "../../../lib/api";

export const prerender = false;

export const POST: APIRoute = async ({ request }) => {
	// 写接口统一同源校验（CSRF）
	if (!isSameOriginRequest(request)) return originForbiddenResponse();

	try {
		const me = await getAuthUser(request, cfEnv);
		if (!me) return json({ message: "请先登录" }, 401);
		if (me.email_verified !== 1)
			return json({ message: "请先完成邮箱验证再申请" }, 403);

		return await withRateLimit(
			cfEnv,
			request,
			{ windowMs: 60 * 60_000, maxRequests: 5, scope: "perm-request" },
			async () => {
				const body = (await request.json().catch(() => null)) as {
					perm?: string;
					note?: string;
				} | null;
				if (!body?.perm) return json({ message: "缺少权限点" }, 400);

				const out = await requestPerm(
					cfEnv.DB,
					me.id,
					String(body.perm),
					String(body.note ?? ""),
				);
				if (!out.ok) return json({ message: out.message }, 400);
				return json({ ok: true, request: out.request }, 200, "private");
			},
		);
	} catch (error) {
		return fromServiceError(error);
	}
};

export const ALL: APIRoute = async () => methodNotAllowed(["POST"]);
