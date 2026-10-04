import type { APIRoute } from "astro";
import { cfEnv } from "../../lib/api";
import { serveMedia } from "@server/media/serve";

export const prerender = false;

export const GET: APIRoute = async ({ request, params }) =>
	serveMedia(request, cfEnv as never, "covers/", String(params.key ?? ""));


export const ALL: APIRoute = async () => new Response("Method Not Allowed", { status: 405 });
