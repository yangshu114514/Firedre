import { defineMiddleware } from "astro:middleware";
import { setPlantumlRuntimeConfig } from "@shared/config/plantumlRuntime";
import { isSameOriginRequest, originForbiddenResponse } from "@server/utils/csrf";
import { getPlantumlConfig } from "./config/runtime";

export interface SettingsLocals {
	settings: import("@server/settings/service").SettingsView;
	settingsVersion?: string;
}

// HTML 边缘缓存：s-maxage=600 让 Cloudflare CDN 缓存（重复访客不跑 worker，TTFB 大幅下降）；
// 后台设置改动经 settingsVersion 在 worker 缓存路径即时生效；CDN 层滞后上限 = 600s（用户已确认接受）
// stale-while-revalidate=86400：过期后 24h 内仍即时返回旧页并后台回源，避免 TTL 到期瞬间的慢请求
const HTML_CACHE_CONTROL =
	"public, max-age=0, s-maxage=600, stale-while-revalidate=86400";
// CF 专用：指示 Cloudflare 边缘按此 TTL 缓存本响应（Pages 默认不缓存 HTML，需此头 + 站点缓存规则配合）
const HTML_CDN_CACHE_CONTROL = "public, max-age=600";

// 安全响应头对缓存命中与渲染路径统一生效
function applySecurityHeaders(headers: Headers) {
	headers.set("X-Content-Type-Options", "nosniff");
	headers.set("X-Frame-Options", "SAMEORIGIN");
	headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
	headers.set(
		"Strict-Transport-Security",
		"max-age=31536000; includeSubDomains",
	);
	headers.set(
		"Permissions-Policy",
		"camera=(), microphone=(), geolocation=(), payment=()",
	);
	// ── CSP（已转强制）──
	// 转强制前已实测：首页 / 文章页 / 登录页 / 归档页 对下列指令**零违规**
	// （控制台唯一的 eval 违规来自 Cloudflare Turnstile 自己的 iframe，由其自身 CSP 管辖，
	//  详情里 isReportOnly:false 且 url 为 challenges.cloudflare.com，与本头无关）。
	//
	// 仍保留 'unsafe-inline' 'unsafe-eval'：本站有 36 个内联脚本（主题初始化、swup、音乐播放器等），
	// 且 Astro 的 CSP 能力只支持哈希、不支持 nonce，去掉这两项需把全部内联脚本迁到构建期哈希。
	// 因此本 CSP 目前防的是：base 标签劫持、表单劫持、点劫持（frame-ancestors）、
	// 插件/对象注入（object-src）、以及资源外联范围；**尚不能拦内联脚本注入**——
	// 该风险已由 server/posts/sanitize.ts 的消毒器覆盖。
	headers.set(
		"Content-Security-Policy",
		"default-src 'self'; script-src 'self' 'unsafe-inline' 'unsafe-eval' https://static.cloudflareinsights.com https://challenges.cloudflare.com; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self' https:; frame-src 'self' blob: https://challenges.cloudflare.com; child-src 'self' blob: https://challenges.cloudflare.com; object-src 'none'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'",
	);
}

// 页面开关派生：basic.pageXxx → pages 映射（正常路径与 D1 故障路径共用）
function derivePages(merged: Record<string, unknown>): void {
	const pageMap: Record<string, string> = {
		pageFriends: "friends",
		pageGuestbook: "guestbook",
		pageDynamic: "dynamic",
		pageGallery: "gallery",
		pageBooknav: "booknav",
		pageBilibili: "bilibili",
		pageBangumi: "bangumi",
		pageVndb: "vndb",
		pageMal: "mal",
		pageSponsor: "sponsor",
	};
	const basicGroup = (merged.basic ?? {}) as Record<string, unknown>;
	const pagesOut: Record<string, unknown> = {};
	for (const [k, v] of Object.entries(pageMap)) {
		if (typeof basicGroup[k] === "boolean") pagesOut[v] = basicGroup[k];
	}
	merged.pages = {
		...((merged.pages as Record<string, unknown>) ?? {}),
		...pagesOut,
	};
}

export const onRequest = defineMiddleware(async (context, next) => {
	const { request } = context;
	const url = new URL(request.url);

	// ── CSRF 纵深防御（集中拦截，自动覆盖所有现有与将来新增的写接口）──
	// 第一道防线是会话 Cookie 的 SameSite=Lax（跨站非安全方法不携带 Cookie）；
	// 这里对非安全方法的 /api 请求再做一次显式同源校验，避免将来 Cookie 策略放宽、
	// 或出现不依赖 Cookie 的写接口时被跨站调用。
	// 放在最前面：命中即短路，省去后续设置加载与渲染开销。
	// 媒体域路由（/covers /music /misc）不在 /api 前缀下且均为 GET，不受影响。
	if (url.pathname.startsWith("/api/") && !isSameOriginRequest(request)) {
		const blocked = originForbiddenResponse();
		applySecurityHeaders(blocked.headers);
		return blocked;
	}

	// 用户系统缓存排除（设计 G.2）：
	// ①请求带 user_session Cookie → 跳过 caches.default（缓存 key 不含 Cookie，命中会把登录态页面发给访客）
	// ②/login /register /verify /profile 一律不缓存（含个人数据 / 表单状态）
	const cookieHeader = request.headers.get("Cookie") || "";
	const hasUserSession = /(?:^|;\s*)user_session=/.test(cookieHeader);
	const isAuthPage =
		["/login", "/register", "/verify", "/profile"].some(
			(p) => url.pathname === p || url.pathname.startsWith(`${p}/`),
		);

	// HTML 页面快路径：先查缓存，命中即返回，避免 seed/settings/version 串行 D1 查询
	// 边缘 HTML 缓存曾缓存到空响应体（200 + 0 字节）并被持续命中，导致整站白屏。
	// 先关闭读与写，保证正确性；如需重建，必须同时加空响应防护与可观测的失效开关。
	const HTML_CACHE_ENABLED = false;
	const isHtmlPage =
		HTML_CACHE_ENABLED &&
		request.method === "GET" &&
		!url.pathname.startsWith("/admin") &&
		!url.pathname.startsWith("/api") &&
		!url.pathname.startsWith("/i18n.js") &&
		!hasUserSession &&
		!isAuthPage;

	let htmlCacheKey = "";
	let settingsVersion = "";
	if (isHtmlPage) {
		try {
			const { getSettingsVersionCached } = await import(
				"@server/settings/service"
			);
			const { cfEnv } = await import("./lib/api");
			settingsVersion = await getSettingsVersionCached(cfEnv);

			htmlCacheKey = `${url.origin}/__html_cache__/${url.pathname}?v=${settingsVersion}`;
			const cached = await caches.default.match(htmlCacheKey);
			if (cached) {
				const headers = new Headers({
					"Content-Type": "text/html; charset=utf-8",

					"Cache-Control": HTML_CACHE_CONTROL,
					"Cloudflare-CDN-Cache-Control": HTML_CDN_CACHE_CONTROL,
					"X-Firedre-Cache": "CACHE-HIT",
				});
				applySecurityHeaders(headers);
				return new Response(await cached.text(), { headers });
			}
		} catch {
			// 缓存不可用不影响主流程
		}
	}

	try {
		const [{ getAllSettings, SETTING_GROUPS }, { settingsDefaults }] =
			await Promise.all([
				import("@server/settings/service"),
				import("@shared/config/settings-defaults"),
			]);
		const { cfEnv } = await import("./lib/api");

		// schema 引导先于渲染：空库首次访问自动建表，避免渲染层查询 500（isolate 内缓存零开销）
		const { ensureSchema } = await import("@server/posts/seed");
		await ensureSchema(cfEnv);

		// seed 仅新 isolate 执行一次（后台运行，不阻塞当前请求）
		const seedFlag = globalThis as unknown as { __FIREDRE_SEEDED__?: boolean };
		if (!seedFlag.__FIREDRE_SEEDED__) {
			seedFlag.__FIREDRE_SEEDED__ = true;
			(async () => {
				try {
					const { ensureDefaultPosts } = await import("@server/posts/seed");
					await ensureDefaultPosts(cfEnv);
				} catch {
					// seed 失败不影响请求
				}
			})();
		}
		// getAllSettings isolate 级缓存：以设置版本为键（任何设置写入都会自增版本号），
		// 命中时省去每 cache-miss 请求的全表 D1 读；TTL 兜底覆盖直改 D1 不 bump 版本的场景
		const settingsCache = globalThis as unknown as {
			__FIREDRE_SETTINGS_CACHE__?: {
				version: string;
				groups: Record<string, Record<string, unknown>>;
				at: number;
			};
		};
		let groups: Record<string, Record<string, unknown>>;
		const cachedGroups = settingsCache.__FIREDRE_SETTINGS_CACHE__;
		if (
			cachedGroups &&
			cachedGroups.version === settingsVersion &&
			Date.now() - cachedGroups.at < 30_000
		) {
			groups = cachedGroups.groups;
		} else {
			groups = await getAllSettings(cfEnv);
			settingsCache.__FIREDRE_SETTINGS_CACHE__ = {
				version: settingsVersion,
				groups,
				at: Date.now(),
			};
		}
		const { mergeSettings } = await import("@server/settings/merge");

		const defaults = settingsDefaults as unknown as Record<
			string,
			Record<string, unknown>
		>;
		const groupNames = new Set<string>(SETTING_GROUPS as unknown as string[]);
		const merged = mergeSettings(defaults, groups, groupNames);

		derivePages(merged);
		(context.locals as unknown as SettingsLocals).settings = merged;
		if (settingsVersion) {
			(context.locals as unknown as SettingsLocals).settingsVersion =
				settingsVersion;
		}
	} catch (e) {
		// A1：D1 故障路径动态接管——以 defaults 铺底渲染（替代原空配置），页面开关同步派生
		console.warn(
			"[middleware] 站点设置加载失败，本次请求以运行时默认值渲染",
			e,
		);
		try {
			const [{ SETTING_GROUPS }, { settingsDefaults }, { mergeSettings }] =
				await Promise.all([
					import("@server/settings/service"),
					import("@shared/config/settings-defaults"),
					import("@server/settings/merge"),
				]);
			const merged = mergeSettings(
				settingsDefaults as unknown as Record<string, Record<string, unknown>>,
				{},
				new Set<string>(SETTING_GROUPS as unknown as string[]),
			);
			derivePages(merged);
			(context.locals as unknown as SettingsLocals).settings = merged;
		} catch (fallbackError) {
			console.warn(
				"[middleware] 默认值兜底渲染失败，以空配置渲染",
				fallbackError,
			);
			(context.locals as unknown as SettingsLocals).settings = {};
		}
	}

	setPlantumlRuntimeConfig(getPlantumlConfig(context.locals));

	const response = await next();

	// 安全响应头对所有 HTTP 方法生效（含 API 写操作的响应）
	applySecurityHeaders(response.headers);

	if (url.pathname.startsWith("/admin") && request.method === "GET") {
		response.headers.set("Cache-Control", "no-store");
	}
	// 登录态请求与认证页：显式 no-store（不入边缘缓存，也不让浏览器二次缓存）
	if (request.method === "GET" && (hasUserSession || isAuthPage)) {
		response.headers.set("Cache-Control", "no-store");
	}
	if (request.method === "GET") {
		const contentType = response.headers.get("content-type") || "";
		const isCacheableHtml =
			contentType.includes("text/html") &&
			!url.pathname.startsWith("/admin") &&
			!url.pathname.startsWith("/api");

		if (isCacheableHtml && HTML_CACHE_ENABLED && htmlCacheKey && response.status === 200) {
			response.headers.set("Cache-Control", HTML_CACHE_CONTROL);
			response.headers.set(
				"Cloudflare-CDN-Cache-Control",
				HTML_CDN_CACHE_CONTROL,
			);
			try {
				const html = await response.clone().text();
				if (html.length > 500 && html.length < 900_000) {
					await caches.default.put(
						htmlCacheKey,
						new Response(html, {
							headers: {
								"Content-Type": "text/html; charset=utf-8",
								"Cache-Control": HTML_CACHE_CONTROL,
							},
						}),
					);
				}
			} catch {}
		}
	}
	return response;
});
