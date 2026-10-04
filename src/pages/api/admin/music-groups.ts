import type { APIRoute } from "astro";
import { cfEnv, fromServiceError, json, methodNotAllowed, withAdmin } from "../../../lib/api";
import { createGroup, deleteGroup, listGroupsAdmin, renameGroup } from "@server/music/library";

export const prerender = false;

export const GET: APIRoute = withAdmin(async () => {
	const groups = await listGroupsAdmin(cfEnv);
	return json({ groups });
});

export const POST: APIRoute = withAdmin(async ({ request }) => {
	const body = (await request.json().catch(() => null)) as
		| { action?: string; id?: number; name?: string }
		| null;
	if (!body?.action) return json({ message: "缺少 action" }, 400);
	try {
		if (body.action === "create" && body.name) {
			const g = await createGroup(cfEnv, body.name);
			return json({ group: g });
		}
		if (body.action === "rename" && body.id && body.name) {
			await renameGroup(cfEnv, body.id, body.name);
			return json({ ok: true });
		}
		if (body.action === "delete" && body.id) {
			await deleteGroup(cfEnv, body.id);
			return json({ ok: true });
		}
		return json({ message: "未知 action 或参数缺失" }, 400);
	} catch (error) {
		return fromServiceError(error);
	}
});

export const ALL: APIRoute = async () => methodNotAllowed(["GET", "POST"]);
