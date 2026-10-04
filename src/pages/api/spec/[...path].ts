import {
	getSpecPage,
	isEditableSpecName,
	isValidSpecName,
	upsertSpecPage,
} from "@server/spec/service";
import type { APIRoute } from "astro";
import {
	badRequest,
	cfEnv,
	json,
	methodNotAllowed,
	notFound,
	serverError,
	withAdmin,
} from "../../../lib/api";
import { pathSegments } from "../../../lib/routePath";

export const prerender = false;

// 与页面编辑器配套：GET 供后台读源码，避免 60s 公共缓存读到刚保存的旧内容
export const GET: APIRoute = async ({ params }) => {
	const segments = pathSegments(params);
	if (segments.length !== 1) return badRequest("路径无效");

	const name = decodeURIComponent(segments[0]);
	if (!isValidSpecName(name)) return badRequest("路径无效");

	try {
		const page = await getSpecPage(cfEnv, name);
		if (!page) return notFound("页面不存在");
		return json(page, 200, "private");
	} catch (error) {
		return serverError(error);
	}
};

// 仅白名单页面（privacy/terms）可写，且必须通过管理员守卫
export const PUT: APIRoute = withAdmin(async ({ params, request }) => {
	const segments = pathSegments(params);
	if (segments.length !== 1) return badRequest("路径无效");

	const name = decodeURIComponent(segments[0]);
	if (!isValidSpecName(name)) return badRequest("路径无效");
	if (!isEditableSpecName(name)) return badRequest("该页面不支持在线编辑");

	const body = await request.text();
	if (!body.trim()) return badRequest("内容不能为空");

	const page = await upsertSpecPage(cfEnv, name, body);
	if (!page) return notFound("页面不存在");
	return json({ ok: true, ...page });
});

export const ALL: APIRoute = async () => methodNotAllowed(["GET", "PUT"]);
