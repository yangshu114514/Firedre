import { getGalleryHub } from "@server/gallery/service";
import { getSettingsVersion } from "@server/settings/service";
import { getSiteConfig } from "@shared/config/runtime";
import type { APIRoute } from "astro";
import { cfEnv } from "../lib/api";

export const prerender = false;

export const GET: APIRoute = async (context) => {
	const cfg = getSiteConfig(context.locals);
	const base = cfg.site_url.replace(/\/+$/, "");
	// D1 不可用时降级为空版本，sitemap 仍输出静态页
	let settingsVersion = "0";
	try {
		settingsVersion = await getSettingsVersion(cfEnv);
	} catch {
		// 版本读取失败不影响 sitemap 输出
	}
	// 统一成对象：静态页没有可靠的修改时间（省略 lastmod），
	// 文章页带真实 lastmod，让搜索引擎知道哪些页是新改的、抓取优先级更高。
	const urls: Array<{ loc: string; lastmod?: string; priority?: string }> = [];

	// 静态页面
	const staticPages: Array<[string, boolean]> = [
		["", true],
		["/about/", true],
		["/archive/", true],
		["/categories/", true],
		["/tags/", true],
		["/series/", true],
		["/search/", true],
		["/friends/", cfg.pages.friends],
		["/guestbook/", cfg.pages.guestbook],
		["/dynamic/", cfg.pages.dynamic],
		["/gallery/", cfg.pages.gallery],
		["/booknav/", cfg.pages.booknav],
		["/sponsor/", cfg.pages.sponsor],
		["/bangumi/", cfg.pages.bangumi],
		["/bilibili/", cfg.pages.bilibili],
		["/vndb/", cfg.pages.vndb],
		["/myanimelist/", cfg.pages.mal],
	];
	for (const [path, enabled] of staticPages) {
		if (enabled) urls.push({ loc: `${base}${path}` });
	}

	// 相册详情（仅公开、非加密相册入 sitemap，加密相册不对外暴露 URL；相册页关闭时不收录）
	if (cfg.pages.gallery) {
		try {
			const hub = await getGalleryHub(cfEnv);
			for (const album of hub?.albums ?? []) {
				if (album.encrypted) continue;
				const encoded = encodeURIComponent(album.slug);
				urls.push({ loc: `${base}/gallery/${encoded}/` });
			}
		} catch {
			// 相册读取失败不影响其余 URL
		}
	}

	// 文章
	try {
		const stmt = cfEnv.DB.prepare(`
			SELECT slug, date, updated FROM posts WHERE published = 1 ORDER BY date DESC
		`);
		const { results } = (await stmt.all()) as {
			results?: Array<{ slug: string; date: string | null; updated: string | null }>;
		};
		for (const row of results || []) {
			const encoded = row.slug.split("/").map(encodeURIComponent).join("/");
			// updated 可能为空；统一取 10 位日期，兼容 "2026-09-11 00:00:00" 之类的库存格式
			const raw = (row.updated || row.date || "").trim();
			const lastmod = /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : undefined;
			urls.push({ loc: `${base}/post/${encoded}/`, lastmod });
		}
	} catch {
		// 数据库不可用时只输出静态页
	}

	const body = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls
	.map(
		(u) =>
			`  <url><loc>${u.loc}</loc>${u.lastmod ? `<lastmod>${u.lastmod}</lastmod>` : ""}</url>`,
	)
	.join("\n")}
</urlset>`;

	return new Response(body, {
		headers: {
			"Content-Type": "application/xml; charset=utf-8",
			// 缓存随设置版本失效：缩短 max-age 并附版本 ETag，改站点设置后最长 5 分钟即刷新（避免原 1h 静态缓存导致变更不可见）
			"Cache-Control": "public, max-age=300, stale-while-revalidate=86400",
			ETag: `"settings-${settingsVersion}"`,
		},
	});
};
