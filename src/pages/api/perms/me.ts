// 前台：当前用户权限快照（权限点 / 我的申请 / 可申请目录）
import type { APIRoute } from "astro";
import { userPermSnapshot } from "@server/auth/perms";
import { getAuthUser } from "@server/auth/userSession";
import { cfEnv, json } from "../../../lib/api";

export const prerender = false;

export const GET: APIRoute = async ({ request }) => {
	const me = await getAuthUser(request, cfEnv);
	if (!me) {
		return json(
			{ authenticated: false, isAdmin: false, perms: [], requests: [], catalog: [] },
			200,
			"private",
		);
	}
	const snap = await userPermSnapshot(cfEnv.DB, me);
	return json(
		{ authenticated: true, role: me.role, name: me.name, ...snap },
		200,
		"private",
	);
};
