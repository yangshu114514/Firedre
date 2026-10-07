import { withRateLimit } from "@server/utils/rateLimiter";
import type { APIRoute } from "astro";
import { cfEnv, methodNotAllowed } from "../../lib/api";

export const prerender = false;

/**
 * 私网 / 保留地址 / 云元数据端点黑名单。
 *
 * 本端点是匿名可用的「外链图片代理」（?u=<任意 https URL>），若不限制目标，
 * 攻击者可借它访问内网服务或云元数据端点（SSRF），也能把它当成匿名抓取中继。
 * Workers 运行时没有本地回环服务，但入口处拦掉才是正确姿势（纵深防御）。
 */
const BLOCKED_HOST_PATTERNS: RegExp[] = [
	/^localhost$/i,
	/^127\./, // 127.0.0.0/8
	/^0\./, // 0.0.0.0/8
	/^10\./, // 10.0.0.0/8
	/^192\.168\./, // 192.168.0.0/16
	/^169\.254\./, // 169.254.0.0/16（含 169.254.169.254 云元数据）
	/^172\.(1[6-9]|2\d|3[01])\./, // 172.16.0.0/12
	/^\[?::1\]?$/i, // IPv6 回环
	/^\[?(fc|fd)[0-9a-f]{2}:/i, // IPv6 唯一本地地址 fc00::/7
	/^\[?fe[89ab][0-9a-f]:/i, // IPv6 链路本地 fe80::/10
	/\.(internal|local|localhost|lan|home)$/i, // 常见内网 TLD
	/^metadata\./i, // 云厂商元数据主机名
];

function isBlockedHost(hostname: string): boolean {
	return BLOCKED_HOST_PATTERNS.some((re) => re.test(hostname));
}

// 远程封面同源代理：按宽度请求 Cloudflare 图像缩放；缩放不可用时透传原图，失败时 302 回退原图
export const GET: APIRoute = async ({ request }) => {
	const url = new URL(request.url);
	const raw = url.searchParams.get("u");
	if (!raw) return new Response("Bad Request", { status: 400 });

	let target: URL;
	try {
		target = new URL(raw);
	} catch {
		return new Response("Bad Request", { status: 400 });
	}
	// 仅代理 https 外链；不允许代理本站；不允许指向私网/保留地址/元数据端点
	if (
		target.protocol !== "https:" ||
		target.hostname === url.hostname ||
		isBlockedHost(target.hostname)
	) {
		return new Response("Bad Request", { status: 400 });
	}

	const width = Math.min(
		Math.max(Math.trunc(Number(url.searchParams.get("w"))) || 828, 64),
		1920,
	);

	// 显式格式参数（opt-in）：f=webp|avif 时让 CF 图像缩放输出该格式；不传则维持原行为
	// （壁纸用 f=webp 减重 ~50%；封面不传 → 完全不变）
	const requestedFormat = url.searchParams.get("f");
	const imageFormat =
		requestedFormat === "avif" || requestedFormat === "webp"
			? requestedFormat
			: "auto";
	// 各格式独立缓存键，避免不同格式互相覆盖
	const cacheKey = new Request(
		`${request.url}${request.url.includes("?") ? "&" : "?"}__fmt=${imageFormat}`,
		request,
	);

	// 手动构造 302（Response.redirect 的 headers 不可变，外层 middleware 无法追加安全头）
	const redirectBack = () =>
		new Response(null, {
			status: 302,
			headers: { Location: target.toString() },
		});

	// 项目全局类型中 caches.default 仅声明 match/put
	type ProxyCache = {
		match(req: Request): Promise<Response | undefined>;
		put(req: Request, resp: Response): Promise<void>;
	};
	let cache: ProxyCache | null = null;
	try {
		cache = (globalThis as unknown as { caches: { default: ProxyCache } })
			.caches.default;
		const cached = await cache.match(cacheKey);
		if (cached) {
			// cache.match 返回的 Response headers 不可变，外层 middleware 需要追加安全头，需重建
			return new Response(cached.body, {
				status: cached.status,
				headers: cached.headers,
			});
		}
	} catch {
		cache = null;
	}

	// 开放中继防护：缓存命中已直接返回，仅上游取图计入限流；failOpen 保证可用性优先
	return withRateLimit(
		cfEnv,
		request,
		{
			windowMs: 60_000,
			maxRequests: 120,
			scope: "cover-proxy",
			failOpen: true,
		},
		async () => {
			try {
				const upstream = await fetch(target, {
					headers: {
						"user-agent": "Mozilla/5.0 (compatible; FiredreCoverProxy/1.0)",
					},
					cf: {
						image: { width, quality: 80, format: imageFormat },
						cacheTtl: 86400,
					},
				} as RequestInit);
				const contentType = upstream.headers.get("content-type") || "";
				if (
					!upstream.ok ||
					!upstream.body ||
					!contentType.startsWith("image/")
				) {
					return redirectBack();
				}
				const headers = new Headers();
				headers.set("content-type", contentType);
				// 浏览器 1 小时（随机图刷新节奏）；边缘 1 天（保证速度，回源至多 1 次/天）
				headers.set("cache-control", "public, max-age=3600, s-maxage=86400");
				const resp = new Response(upstream.body, { headers });
				if (cache) {
					try {
						await cache.put(cacheKey, resp.clone());
					} catch {
						// 缓存写入失败仍返回图片
					}
				}
				return resp;
			} catch {
				return redirectBack();
			}
		},
	);
};

export const ALL: APIRoute = async () => methodNotAllowed(["GET"]);
