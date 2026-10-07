/**
 * 写请求同源校验（CSRF 纵深防御）。
 *
 * 第一道防线是会话 Cookie 的 `SameSite=Lax`（跨站的非安全方法不会携带 Cookie）；
 * 本模块是第二道：对非安全方法显式校验来源，防止未来 Cookie 策略被放宽、
 * 或出现不依赖 Cookie 的写接口时被跨站调用。
 *
 * 独立成模块（不依赖任何 node 内建/会话代码），便于中间件集中调用。
 */

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * 非安全方法（POST/PUT/PATCH/DELETE）同源判定：
 * - 带 Origin → 必须与请求 URL 同源（`Origin: "null"` 视为不信任，继续看 Sec-Fetch-Site）
 * - 不带 Origin → 看 Sec-Fetch-Site，跨站（cross-site）拒绝
 * - 两者皆无 → 非浏览器客户端（curl 等），无 Cookie 可被冒用，放行
 *
 * 安全方法直接放行（读操作不产生副作用）。
 */
export function isSameOriginRequest(request: Request): boolean {
	const method = request.method.toUpperCase();
	if (SAFE_METHODS.has(method)) return true;

	const origin = request.headers.get("Origin");
	if (origin && origin !== "null") {
		try {
			return new URL(origin).origin === new URL(request.url).origin;
		} catch {
			return false;
		}
	}

	const site = request.headers.get("Sec-Fetch-Site");
	if (site && site !== "same-origin" && site !== "none") return false;

	return true;
}

export function originForbiddenResponse(): Response {
	return new Response(JSON.stringify({ message: "跨站请求被拒绝" }), {
		status: 403,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
		},
	});
}
