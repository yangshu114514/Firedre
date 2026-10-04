import type { APIRoute } from "astro";
import { cfEnv } from "../../lib/api";
import { serveMedia } from "@server/media/serve";

export const prerender = false;

// GET 与 HEAD 统一走 serveMedia（<audio> 拖动进度条依赖 HEAD/Range）。
// 注意：不得同时导出 HEAD + ALL——Astro 7 下该组合会使 rest 路由整体失效（实测），
// 因此 HEAD 语义由 ALL 分支承接。
export const GET: APIRoute = async ({ request, params }) =>
	serveMedia(request, cfEnv as never, "music/", String(params.key ?? ""));

export const ALL: APIRoute = async ({ request, params }) => {
	if (request.method === "HEAD") {
		return serveMedia(request, cfEnv as never, "music/", String(params.key ?? ""));
	}
	return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
};
