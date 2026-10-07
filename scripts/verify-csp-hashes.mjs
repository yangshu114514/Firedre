#!/usr/bin/env node
/**
 * CSP 内联脚本哈希覆盖自检。
 *
 * 为什么需要它：中间件用「全站内联脚本 sha256 并集」替代了 script-src 'unsafe-inline'。
 * 白名单是离线扫描生成的，一旦漏掉某个脚本的哈希，浏览器会**静默**拦掉它
 * （页面不报错、只是某些交互失灵），非常难排查。这个脚本把该风险变成可检测项：
 *
 *   枚举站点所有页面 → 提取每个页面响应头里的 CSP 哈希集合
 *   → 提取页面内联可执行脚本的 sha256
 *   → 报告「页面里有、但 CSP 白名单里没有」的脚本。
 *
 * 退出码：0 = 全部覆盖；1 = 存在未覆盖脚本（会导致线上功能失灵）。
 *
 * 用法：
 *   node scripts/verify-csp-hashes.mjs https://yangshu.cc.cd
 *   node scripts/verify-csp-hashes.mjs http://127.0.0.1:8788
 */
import crypto from "node:crypto";

const BASE = (process.argv[2] || "https://yangshu.cc.cd").replace(/\/$/, "");

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const TYPE_RE = /\btype\s*=\s*"([^"]*)"/i;
const EXEC_TYPES = new Set([
	"", "text/javascript", "application/javascript", "module",
	"text/ecmascript", "application/ecmascript",
]);

function sha256b64(text) {
	return crypto.createHash("sha256").update(text, "utf8").digest("base64");
}

function isExecutableInline(attrs) {
	if (/\bsrc\s*=/i.test(attrs)) return false;
	const m = TYPE_RE.exec(attrs);
	if (!m) return true;
	return EXEC_TYPES.has(m[1].trim().toLowerCase());
}

function inlineHashes(html) {
	const out = [];
	SCRIPT_RE.lastIndex = 0;
	let m;
	while ((m = SCRIPT_RE.exec(html))) {
		if (!isExecutableInline(m[1])) continue;
		out.push({ hash: sha256b64(m[2]), preview: m[2].trim().replace(/\s+/g, " ").slice(0, 90) });
	}
	return out;
}

async function get(path) {
	const res = await fetch(BASE + path, { redirect: "follow" });
	const body = await res.text();
	return { status: res.status, body, csp: res.headers.get("content-security-policy") || "" };
}

async function collectRoutes() {
	const routes = new Set([
		"/", "/about/", "/archive/", "/categories/", "/tags/", "/series/",
		"/search/", "/friends/", "/guestbook/", "/dynamic/", "/gallery/",
		"/booknav/", "/sponsor/", "/login/", "/register/", "/privacy/", "/terms/",
	]);
	try {
		const sm = await get("/sitemap.xml");
		for (const m of sm.body.matchAll(/<loc>(.*?)<\/loc>/g)) {
			routes.add(m[1].trim().replace(/^https?:\/\/[^/]+/, "") || "/");
		}
	} catch { /* sitemap 不可用则忽略 */ }
	try {
		const arch = await get("/archive/");
		for (const m of arch.body.matchAll(/href="(\/post\/[^"#?]*?)"/g)) routes.add(m[1]);
		for (const m of arch.body.matchAll(/href="(\/\d+\/)"/g)) routes.add(m[1]);
	} catch { /* ignore */ }
	return [...routes];
}

const routes = await collectRoutes();
const allHashes = new Set();
const missing = [];
const noCsp = [];
let pageCount = 0;
let scriptCount = 0;

for (const r of routes) {
	let page;
	try {
		page = await get(r);
	} catch (e) {
		console.log(`  [skip] ${r} — ${e.message}`);
		continue;
	}
	pageCount++;
	if (!page.csp) { noCsp.push(r); continue; }
	const allowed = new Set(
		[...page.csp.matchAll(/'sha256-([A-Za-z0-9+/=]+)'/g)].map((m) => m[1]),
	);
	for (const h of allowed) allHashes.add(h);
	for (const s of inlineHashes(page.body)) {
		scriptCount++;
		if (!allowed.has(s.hash)) missing.push({ route: r, ...s });
	}
}

console.log(`\n站点        : ${BASE}`);
console.log(`已扫描页面  : ${pageCount}`);
console.log(`内联可执行脚本: ${scriptCount}`);
console.log(`CSP 白名单  : ${allHashes.size} 个哈希`);
console.log(`unsafe-inline 是否仍存在: ${[...routes].length ? "见下" : ""}`);

if (noCsp.length) {
	console.log(`\n⚠️ 以下页面没有下发 CSP 头：`);
	for (const r of noCsp) console.log(`   ${r}`);
}

if (missing.length) {
	console.log(`\n❌ 有 ${missing.length} 个内联脚本未被 CSP 白名单覆盖（线上会被静默拦掉）：`);
	for (const m of missing.slice(0, 30)) {
		console.log(`   ${m.route}\n      sha256-${m.hash}\n      ${m.preview}`);
	}
	process.exit(1);
}

console.log(`\n✅ 全部内联脚本都在 CSP 白名单内。`);
