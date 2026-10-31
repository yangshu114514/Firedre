import type { APIRoute } from "astro";
import { cfEnv, methodNotAllowed } from "../../../lib/api";
import {
	issueMediaTicket,
	ticketFromCookie,
	ticketSetCookie,
	verifyMediaTicket,
} from "@server/media/ticket";

export const prerender = false;

/**
 * 媒体门票种发端点。
 * - 已持有效票（剩余 > 15 天）→ 204，不重设（减少无谓 Set-Cookie）；
 * - 无票 / 即将过期 → 200 + Set-Cookie（30 天滚动续期）。
 * 播放器在无票 403 时也会引导浏览器先打本端点再重试。
 */
export const GET: APIRoute = async ({ request }) => {
	const secret = (cfEnv.USER_SESSION_SECRET as string) || "";
	if (!secret) return new Response("Media disabled", { status: 503 });

	const url = new URL(request.url);

	// r=<媒体路径>：来自 serveMedia 的 302 引导。种/续票后必须 302 回媒体 URL，
	// 让 <audio>/<img> 的请求链闭环（不能返回 204/JSON，否则媒体元素加载失败）。
	const returnPath = url.searchParams.get("r") || "";
	const redirectToMedia = (status: number, extraHeaders: HeadersInit = {}) => {
		if (!returnPath.startsWith("/") || returnPath.startsWith("//")) return null;
		const target = new URL(returnPath, url.origin);
		target.searchParams.set("mtr", "1");
		return new Response(null, {
			status,
			headers: {
				Location: target.toString(),
				"Cache-Control": "no-store",
				...extraHeaders,
			},
		});
	};

	const existing = ticketFromCookie(request.headers.get("Cookie"));
	if (existing) {
		const dot = existing.indexOf(".");
		const exp = dot > 0 ? Number.parseInt(existing.slice(0, dot), 10) : 0;
		const valid =
			Number.isFinite(exp) &&
			exp * 1000 > Date.now() &&
			(await verifyMediaTicket(secret, existing));
		if (valid && exp * 1000 - Date.now() > 15 * 24 * 3600 * 1000) {
			if (returnPath) {
				const resp = redirectToMedia(302);
				if (resp) return resp;
			}
			return new Response(null, {
				status: 204,
				headers: { "Cache-Control": "no-store" },
			});
		}
	}

	const { value, maxAge } = await issueMediaTicket(secret);
	const host = url.hostname;
	const setCookie = ticketSetCookie(value, maxAge, host);
	if (returnPath) {
		const resp = redirectToMedia(302, { "Set-Cookie": setCookie });
		if (resp) return resp;
	}
	return new Response(JSON.stringify({ ok: true }), {
		status: 200,
		headers: {
			"Content-Type": "application/json; charset=utf-8",
			"Cache-Control": "no-store",
			"Set-Cookie": setCookie,
		},
	});
};

export const ALL: APIRoute = async () => methodNotAllowed(["GET"]);
