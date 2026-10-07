import { env } from "cloudflare:workers";
import { verifyAdminRequest } from "@server/auth/adminSession";
import { UserError } from "@server/utils/userError";
import type { APIContext, APIRoute } from "astro";
import type { CloudflareEnv } from "../../types/env";

// cloudflare:workers env 由运行时注入，模块声明为 Record<string, any>，此处收敛为项目类型
export const cfEnv = env as unknown as CloudflareEnv;

export function json(
	data: unknown,
	status = 200,
	cache: "list" | "default" | "private" = "default",
) {
	const cacheControl =
		status !== 200
			? "no-store"
			: cache === "private"
				? "private, no-store"
				: cache === "list"
					? "public, max-age=0, must-revalidate"
					: "public, max-age=60, stale-while-revalidate=300";

	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": cacheControl,
		},
	});
}

export function unauthorized() {
	return json({ message: "未授权" }, 401);
}

// 405 必须声明允许的方法（RFC 9110 §15.5.6）；未传 allow 时保持原有响应体不变
export function methodNotAllowed(allow?: string[]) {
	const res = json({ message: "Method not allowed" }, 405);
	if (allow?.length) res.headers.set("Allow", allow.join(", "));
	return res;
}

export function notFound(message = "Not found") {
	return json({ message }, 404);
}

export function badRequest(message: string) {
	return json({ message }, 400);
}

export { UserError };

export function serverError(error: unknown) {
	if (!(error instanceof UserError)) {
		// 非预期错误必须留痕，否则生产 500 无法远程诊断
		console.error("[api] serverError:", error);
	}
	const message = error instanceof UserError ? error.message : "服务器错误";
	return json({ message }, 500);
}

export function fromServiceError(error: unknown) {
	if (error instanceof UserError) return badRequest(error.message);
	return serverError(error);
}

/**
 * 登录态相关响应的统一缓存策略。
 *
 * - 已登录：`private, no-store`，绝不落入任何共享缓存；
 * - 匿名：可公共缓存（省 D1 查询），但**必须声明 `Vary: Cookie`**。
 *
 * 为什么要 Vary：边缘缓存默认不按 Cookie 分片。若匿名响应可缓存却不声明 Vary，
 * 已登录用户可能命中缓存的匿名版本——表现为点赞状态退化成未赞、
 * 看不到自己刚提交的待审评论。声明 Vary 后两种登录态各自独立缓存。
 */
export function jsonAuthVariant(data: unknown, authenticated: boolean) {
	const response = json(data, 200, authenticated ? "private" : "default");
	if (!authenticated) response.headers.set("Vary", "Cookie");
	return response;
}

// 写路径通用样板：统一后台身份鉴权（传统 admin 会话或 users.admin）+ 统一错误映射
export function withAdmin(
	handler: (context: APIContext) => Promise<Response>,
): APIRoute {
	return async (context) => {
		const isAdmin = await verifyAdminRequest(context.request, cfEnv);
		if (!isAdmin) return unauthorized();
		try {
			return await handler(context);
		} catch (error) {
			return fromServiceError(error);
		}
	};
}
