import type { APIRoute } from "astro";
import { cfEnv, json, methodNotAllowed, serverError } from "../../../lib/api";
import { buildPlaylist } from "@server/music/library";

export const prerender = false;

/**
 * 公开分组播放清单（嗅探 ∩ D1 归属 → 分组曲目 + 媒体域直链）。
 * short 缓存：嗅探结果对实时性要求高（用户删/加文件要尽快体现），
 * 60s 边缘/浏览器缓存平衡 R2 List 次数与时效。
 */
export const GET: APIRoute = async ({ url }) => {
	try {
		const groups = await buildPlaylist(cfEnv, { origin: url.origin });
		return json(
			{ groups },
			200,
		);
	} catch (error) {
		return serverError(error);
	}
};

export const ALL: APIRoute = async () => methodNotAllowed(["GET"]);
