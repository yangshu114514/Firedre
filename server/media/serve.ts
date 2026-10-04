/**
 * 媒体对象服务核心（music / image / misc 三个自定义域共用逻辑）
 *
 * 架构（用户确认）：
 * - 三个域都绑到 Pages 项目 firedre，路径 1:1 映射函数路由：
 *     music.yangshu.cc.cd/music/<key>  → src/pages/music/[...key].ts    → R2 music/<key>
 *     image.yangshu.cc.cd/covers/<key> → src/pages/covers/[...key].ts   → R2 covers/<key>
 *     misc.yangshu.cc.cd/misc/<key>    → src/pages/misc/[...key].ts     → R2 misc/<key>
 *   （函数路由使 Astro _routes.json 自动放行这些路径进 Worker；pages.dev 预览域
 *    也可用同路径直接调试。）
 * - 鉴权：Cookie 门票（media_tkt，server/media/ticket.ts）；无票 403。
 * - 缓存：immutable 一年 + Worker 边缘 caches.default 二级缓存（干净 URL key 稳定），
 *   R2 仅在双层未命中时读一次，保护 R2 Class B 限额。
 * - Range：透传 R2（get(key, { range })），206 + Content-Range，进度条可拖。
 */
import { ticketFromCookie, verifyMediaTicket } from "./ticket";

const IMMUTABLE = "public, max-age=31536000, immutable";

export type MediaKind = "audio" | "image" | "misc";

export interface MediaEnv {
	BUCKET: R2Bucket;
	USER_SESSION_SECRET?: string;
	caches?: { default: Cache };
}

const EXT_CONTENT_TYPE: Record<string, string> = {
	mp3: "audio/mpeg",
	m4a: "audio/mp4",
	aac: "audio/aac",
	ogg: "audio/ogg",
	opus: "audio/opus",
	flac: "audio/flac",
	wav: "audio/wav",
	png: "image/png",
	jpg: "image/jpeg",
	jpeg: "image/jpeg",
	webp: "image/webp",
	gif: "image/gif",
	svg: "image/svg+xml",
	avif: "image/avif",
	ico: "image/x-icon",
};

function contentTypeFor(key: string, fallback?: string): string {
	if (
		fallback &&
		fallback !== "application/octet-stream" &&
		fallback !== "binary/octet-stream"
	) {
		return fallback;
	}
	const ext = key.split(".").pop()?.toLowerCase() ?? "";
	return EXT_CONTENT_TYPE[ext] ?? "application/octet-stream";
}

function parseRange(header: string): R2Range | null {
	const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
	if (!m) return null;
	if (m[1] === "" && m[2] !== "") return { suffix: Number(m[2]) };
	if (m[2] === "") return { offset: Number(m[1]) };
	const start = Number(m[1]);
	const end = Number(m[2]);
	if (end < start) return null;
	return { offset: start, length: end - start + 1 };
}

/**
 * 服务一个媒体对象。
 * @param relPath URL 路径中已剥离函数前缀后的相对键（未解码）
 */
export async function serveMedia(
	request: Request,
	env: MediaEnv,
	prefix: string,
	relPath: string,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response("Method Not Allowed", { status: 405 });
	}

	const secret = env.USER_SESSION_SECRET || "";
	if (!secret) return new Response("Media disabled", { status: 503 });

	const ticket = ticketFromCookie(request.headers.get("Cookie"));
	if (!(await verifyMediaTicket(secret, ticket))) {
		return new Response("Forbidden", { status: 403 });
	}

	let rel: string;
	try {
		rel = decodeURIComponent(relPath);
	} catch {
		return new Response("Bad Request", { status: 400 });
	}
	if (!rel || rel.includes("..") || rel.includes("\\") || rel.includes("\0")) {
		return new Response("Bad Request", { status: 400 });
	}
	const key = `${prefix}${rel}`;
	const url = new URL(request.url);
	const isHead = request.method === "HEAD";

	// ---- 边缘缓存优先（仅整对象 GET） ----
	const cache = env.caches?.default;
	const isPlainGet = !isHead && !request.headers.has("Range");
	if (cache && isPlainGet) {
		try {
			const hit = await cache.match(url.toString());
			if (hit) {
				const headers = new Headers(hit.headers);
				headers.set("X-Firedre-Media", "EDGE-HIT");
				return new Response(hit.body, { status: 200, headers });
			}
		} catch {
			// 缓存不可用不影响主流程
		}
	}

	// ---- R2 读取（Range 透传） ----
	const rangeHeader = request.headers.get("Range");
	const range = rangeHeader ? parseRange(rangeHeader) : null;
	let object: R2ObjectBody | null = null;
	if (range) {
		try {
			object = await env.BUCKET.get(key, { range });
		} catch {
			return new Response("Range Not Satisfiable", { status: 416 });
		}
	} else {
		object = await env.BUCKET.get(key);
	}
	if (!object) return new Response("Not Found", { status: 404 });

	const headers = new Headers();
	object.writeHttpMetadata(headers);
	headers.set(
		"Content-Type",
		contentTypeFor(key, object.httpMetadata?.contentType),
	);
	headers.set("Cache-Control", IMMUTABLE);
	headers.set("Accept-Ranges", "bytes");
	headers.set("ETag", object.httpEtag);
	headers.set("X-Firedre-Media", "R2");

	// 206 / Content-Range 组装（object.size 恒为整对象大小）
	if (range) {
		let start: number;
		let length: number;
		if (range.offset !== undefined) {
			start = range.offset;
			length = range.length ?? Math.max(0, object.size - start);
		} else {
			length = range.suffix ?? 0;
			start = Math.max(0, object.size - length);
		}
		if (start >= object.size && object.size > 0) {
			try {
				object.body?.cancel();
			} catch {
				/* noop */
			}
			return new Response(null, {
				status: 416,
				headers: { "Content-Range": `bytes */${object.size}` },
			});
		}
		headers.set("Content-Range", `bytes ${start}-${start + length - 1}/${object.size}`);
		headers.set("Content-Length", String(length));
		const partial = new Response(isHead ? null : object.body, {
			status: 206,
			headers,
		});
		return partial;
	}

	headers.set("Content-Length", String(object.size));
	const response = new Response(isHead ? null : object.body, {
		status: 200,
		headers,
	});

	// 整对象 GET：写入边缘缓存（克隆后再流式返回原响应）
	if (cache && isPlainGet && !isHead) {
		try {
			await cache.put(url.toString(), response.clone());
		} catch {
			// 缓存失败不影响响应
		}
	}
	return response;
}
