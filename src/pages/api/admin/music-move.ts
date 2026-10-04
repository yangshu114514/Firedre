import type { APIRoute } from "astro";
import { cfEnv, fromServiceError, json, methodNotAllowed, withAdmin } from "../../../lib/api";
import { moveTracks } from "@server/music/library";

export const prerender = false;

/** 批量移动曲目分组（管理员）：{ filenames: string[], toGroupId: number | null } */
export const POST: APIRoute = withAdmin(async ({ request }) => {
	const body = (await request.json().catch(() => null)) as
		| { filenames?: string[]; toGroupId?: number | null }
		| null;
	if (!Array.isArray(body?.filenames) || body.filenames.length === 0) {
		return json({ message: "filenames 不能为空" }, 400);
	}
	try {
		const to =
			body.toGroupId === null || body.toGroupId === undefined ? null : Number(body.toGroupId);
		await moveTracks(cfEnv, body.filenames.slice(0, 100), to);
		return json({ ok: true });
	} catch (error) {
		return fromServiceError(error);
	}
});

export const ALL: APIRoute = async () => methodNotAllowed(["POST"]);
