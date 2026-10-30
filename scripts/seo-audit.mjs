#!/usr/bin/env node
/**
 * SEO 巡检 / 报告生成（不写死任何期望值）
 *
 * 设计原则（与 scripts/verify-csp-hashes.mjs 对齐）：
 *   - 站点域名、页面清单、文章清单全部从线上实时读取，脚本里不硬编码 URL 列表；
 *   - canonical 域名作为「事实源」：sitemap、og:url、robots 的 Sitemap 行都必须与它一致；
 *   - 只做判定与汇总，不做修改。输出人类可读报告或 JSON。
 *
 * 用法：
 *   node scripts/seo-audit.mjs                        # 审计线上站点（默认读 package.json 的站点域）
 *   node scripts/seo-audit.mjs --base https://x.com   # 指定站点
 *   node scripts/seo-audit.mjs --base http://localhost:4321 --sample 3
 *   node scripts/seo-audit.mjs --json > seo-report.json
 *
 * 退出码：0 全通过；1 存在 error 级问题；2 仅 warning。
 */

const args = process.argv.slice(2);
const argOf = (name, fallback = null) => {
	const i = args.indexOf(`--${name}`);
	if (i === -1) return fallback;
	const v = args[i + 1];
	return v && !v.startsWith("--") ? v : true;
};

const BASE = String(argOf("base", process.env.SEO_BASE || "https://yangshu.cc.cd"))
	.replace(/\/+$/, "");
const SAMPLE = Number(argOf("sample", 5));
const JSON_OUT = Boolean(argOf("json", false));
const TIMEOUT_MS = Number(argOf("timeout", 15000));

/** @type {{level:'error'|'warn'|'info',scope:string,message:string}[]} */
const findings = [];
const add = (level, scope, message) => findings.push({ level, scope, message });

const fetchText = async (url, init = {}) => {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
	try {
		const r = await fetch(url, {
			redirect: "follow",
			signal: ctrl.signal,
			headers: { "user-agent": "firedre-seo-audit/1.0", ...(init.headers || {}) },
			...init,
		});
		return { status: r.status, headers: r.headers, text: await r.text() };
	} finally {
		clearTimeout(timer);
	}
};

const decodeEntities = (s) =>
	s
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">");

/** 从 HTML 里抽 head 关键标签（不引入解析器依赖） */
function parseHead(html) {
	const meta = {};
	const metaRe = /<meta\s+([^>]+?)\/?>/gi;
	for (const m of html.matchAll(metaRe)) {
		const attrs = m[1];
		const key =
			/(?:property|name)\s*=\s*"([^"]+)"/i.exec(attrs)?.[1] ??
			/(?:property|name)\s*=\s*'([^']+)'/i.exec(attrs)?.[1];
		const content =
			/content\s*=\s*"([^"]*)"/i.exec(attrs)?.[1] ??
			/content\s*=\s*'([^']*)'/i.exec(attrs)?.[1];
		if (key) meta[key.toLowerCase()] = decodeEntities(content ?? "");
	}
	const title =
		/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "";
	const canonical =
		/<link[^>]+rel\s*=\s*"canonical"[^>]*href\s*=\s*"([^"]+)"/i.exec(html)?.[1] ??
		null;
	const alternates = [
		...html.matchAll(/<link[^>]+rel\s*=\s*"alternate"[^>]*>/gi),
	].map((m) => m[0]);

	const jsonLds = [];
	for (const m of html.matchAll(
		/<script[^>]+type\s*=\s*"application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi,
	)) {
		jsonLds.push(m[1]);
	}
	return { meta, title, canonical, alternates, jsonLds };
}

const hostOf = (u) => {
	try {
		return new URL(u).host;
	} catch {
		return null;
	}
};

function checkPage(html, url, { requireArticleLd = false } = {}) {
	const { meta, title, canonical, jsonLds } = parseHead(html);
	const scope = url;

	if (!title) add("error", scope, "缺少 <title>");
	else if (title.length > 60)
		add("warn", scope, `<title> 过长（${title.length} 字符，建议 ≤ 60）`);
	else if (title.length < 8)
		add("warn", scope, `<title> 过短（${title.length} 字符）`);

	const desc = meta.description;
	if (!desc) add("error", scope, "缺少 meta description");
	else if (desc.length < 50)
		add("warn", scope, `description 偏短（${desc.length} 字符，建议 50–160）`);
	else if (desc.length > 160)
		add("warn", scope, `description 偏长（${desc.length} 字符，建议 ≤ 160）`);

	if (!canonical) add("error", scope, "缺少 canonical");
	else if (hostOf(canonical) !== hostOf(BASE))
		add(
			"error",
			scope,
			`canonical 域名与站点域不一致：${canonical}（期望 host=${hostOf(BASE)}）`,
		);

	// og 基础四项
	for (const k of ["og:title", "og:description", "og:type", "og:url"]) {
		if (!meta[k]) add("error", scope, `缺少 ${k}`);
	}
	if (meta["og:url"] && hostOf(meta["og:url"]) !== hostOf(BASE))
		add("error", scope, `og:url 域名异常：${meta["og:url"]}`);

	// og:image 是最容易漏的一项：社交平台没图就没有大卡片
	const ogImage = meta["og:image"];
	if (!ogImage) {
		add("error", scope, "缺少 og:image（分享无缩略图）");
	} else {
		if (!/^https?:\/\//i.test(ogImage))
			add("error", scope, `og:image 不是绝对 URL：${ogImage}`);
		else if (hostOf(ogImage) !== hostOf(BASE))
			add(
				"warn",
				scope,
				`og:image 域名与站点域不一致：${ogImage}（社交抓取可能引用临时域）`,
			);
	}
	if (meta["twitter:card"] !== "summary_large_image")
		add(
			"warn",
			scope,
			`twitter:card = ${meta["twitter:card"] ?? "缺失"}，大图卡片需 summary_large_image`,
		);

	// JSON-LD 必须可解析，否则富媒体结果直接失效
	if (jsonLds.length === 0) {
		add(requireArticleLd ? "error" : "warn", scope, "缺少 JSON-LD 结构化数据");
	}
	for (const [i, raw] of jsonLds.entries()) {
		try {
			const parsed = JSON.parse(raw);
			const types = []
				.concat(parsed)
				.flatMap((p) => (p?.["@graph"] ? p["@graph"] : p))
				.map((p) => p?.["@type"])
				.filter(Boolean);
			if (types.length === 0)
				add("warn", scope, `JSON-LD #${i} 缺少 @type`);
			if (requireArticleLd && !types.includes("BlogPosting") && !types.includes("Article"))
				add("error", scope, `文章页 JSON-LD 缺少 BlogPosting/Article（实际：${types.join(",")}）`);
		} catch (e) {
			add("error", scope, `JSON-LD #${i} 解析失败：${e.message}`);
		}
	}
	return parseHead(html);
}

async function main() {
	// ── 1. robots.txt ──
	let robots = "";
	try {
		const r = await fetchText(`${BASE}/robots.txt`);
		if (r.status !== 200) add("error", `${BASE}/robots.txt`, `HTTP ${r.status}`);
		robots = r.text;
		if (!/Sitemap:\s*\S+/i.test(robots))
			add("error", "robots.txt", "未声明 Sitemap");
		const declared = /Sitemap:\s*(\S+)/i.exec(robots)?.[1];
		if (declared && hostOf(declared) !== hostOf(BASE))
			add("error", "robots.txt", `Sitemap 指向其他域名：${declared}`);
		if (!/Disallow:\s*\/admin/i.test(robots))
			add("warn", "robots.txt", "未屏蔽 /admin/，后台页可能被收录");
	} catch (e) {
		add("error", "robots.txt", `请求失败：${e.message}`);
	}

	// ── 2. sitemap.xml ──
	let sitemapUrls = [];
	try {
		const r = await fetchText(`${BASE}/sitemap.xml`);
		if (r.status !== 200) add("error", `${BASE}/sitemap.xml`, `HTTP ${r.status}`);
		const locs = [...r.text.matchAll(/<loc>([\s\S]*?)<\/loc>/gi)].map((m) =>
			decodeEntities(m[1].trim()),
		);
		sitemapUrls = locs;
		if (locs.length === 0) add("error", "sitemap.xml", "没有任何 <loc>");
		const foreign = locs.filter((u) => hostOf(u) !== hostOf(BASE));
		if (foreign.length)
			add(
				"error",
				"sitemap.xml",
				`${foreign.length} 条 URL 域名与站点域不一致（例：${foreign[0]}）`,
			);
		const withLastmod = (r.text.match(/<lastmod>/gi) || []).length;
		if (withLastmod === 0)
			add("warn", "sitemap.xml", "所有 URL 都缺 <lastmod>，搜索引擎无法判断新鲜度");
		else if (withLastmod < locs.length * 0.3)
			add(
				"info",
				"sitemap.xml",
				`仅 ${withLastmod}/${locs.length} 条带 <lastmod>`,
			);
		const dupes = locs.filter((u, i) => locs.indexOf(u) !== i);
		if (dupes.length)
			add("warn", "sitemap.xml", `存在重复 URL：${dupes.slice(0, 3).join(", ")}`);
	} catch (e) {
		add("error", "sitemap.xml", `请求失败：${e.message}`);
	}

	// ── 3. 首页 ──
	try {
		const r = await fetchText(`${BASE}/`);
		if (r.status !== 200) add("error", `${BASE}/`, `HTTP ${r.status}`);
		checkPage(r.text, `${BASE}/`);
		const h = parseHead(r.text);
		if (!/^zh/i.test(r.text.match(/<html[^>]+lang\s*=\s*"([^"]+)"/i)?.[1] ?? ""))
			add("warn", `${BASE}/`, "html lang 缺失或非中文，影响语言定向");
		if (h.meta.robots?.includes("noindex"))
			add("error", `${BASE}/`, "首页被标记 noindex");
	} catch (e) {
		add("error", `${BASE}/`, `请求失败：${e.message}`);
	}

	// ── 4. 抽样文章页（从 sitemap 里取，不硬编码） ──
	const postUrls = sitemapUrls.filter((u) => /\/post\//.test(u)).slice(0, SAMPLE);
	for (const u of postUrls) {
		try {
			const r = await fetchText(u);
			if (r.status !== 200) {
				add("error", u, `HTTP ${r.status}`);
				continue;
			}
			checkPage(r.text, u, { requireArticleLd: true });
		} catch (e) {
			add("error", u, `请求失败：${e.message}`);
		}
	}

	// ── 5. sitemap 可达性抽样（HEAD 检查死链） ──
	const probe = sitemapUrls.slice(0, Math.min(8, sitemapUrls.length));
	for (const u of probe) {
		try {
			const r = await fetchText(u, { method: "GET" });
			if (r.status >= 400) add("error", u, `sitemap 中的 URL 返回 HTTP ${r.status}`);
		} catch (e) {
			add("error", u, `不可达：${e.message}`);
		}
	}

	// ── 6. RSS ──
	try {
		const r = await fetchText(`${BASE}/rss.xml`);
		if (r.status !== 200) add("warn", `${BASE}/rss.xml`, `HTTP ${r.status}`);
		else {
			if (!/<rss/i.test(r.text)) add("error", "rss.xml", "响应不是 RSS");
			const items = (r.text.match(/<item>/gi) || []).length;
			if (items === 0) add("warn", "rss.xml", "feed 内没有任何 <item>");
		}
	} catch (e) {
		add("warn", "rss.xml", `请求失败：${e.message}`);
	}

	// ── 汇总 ──
	const errors = findings.filter((f) => f.level === "error");
	const warns = findings.filter((f) => f.level === "warn");
	const infos = findings.filter((f) => f.level === "info");

	if (JSON_OUT) {
		console.log(
			JSON.stringify(
				{
					base: BASE,
					generatedAt: new Date().toISOString(),
					summary: {
						errors: errors.length,
						warnings: warns.length,
						infos: infos.length,
						sitemapUrls: sitemapUrls.length,
						sampledPosts: postUrls.length,
					},
					findings,
				},
				null,
				2,
			),
		);
	} else {
		const icon = { error: "✗", warn: "!", info: "·" };
		console.log(`\nSEO 巡检 — ${BASE}`);
		console.log(`生成时间 ${new Date().toISOString()}`);
		console.log(
			`覆盖：${sitemapUrls.length} 条 sitemap URL，抽样 ${postUrls.length} 篇文章页\n`,
		);
		if (findings.length === 0) {
			console.log("✓ 全部检查通过");
		} else {
			for (const f of [...errors, ...warns, ...infos]) {
				console.log(`${icon[f.level]} [${f.scope}] ${f.message}`);
			}
		}
		console.log(
			`\n合计：${errors.length} 错误 / ${warns.length} 警告 / ${infos.length} 提示\n`,
		);
	}

	if (errors.length) process.exit(1);
	if (warns.length) process.exit(2);
	process.exit(0);
}

main().catch((e) => {
	console.error("[seo-audit] 未捕获异常:", e);
	process.exit(1);
});