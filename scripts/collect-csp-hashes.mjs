#!/usr/bin/env node
/**
 * 扫描一个运行中的站点，生成「全站内联可执行脚本 sha256 并集」白名单。
 *
 * 为什么必须是全站并集：swup 的 ScriptsPlugin 在软导航时会把新页面里的内联脚本
 * 重新执行（`el.replaceWith(clone)`），而 CSP 是**文档级**的、只认首个响应对应的
 * 策略。若白名单只放当前页的哈希，软导航过去的页面其脚本就会被拦。
 *
 * 为什么必须运行时扫描而不能读源码：Astro 会把部分模块压缩后**内联**进 HTML
 * （源码里没有对应文本），另外 define:vars 会注入额外声明。实测源码直算只有
 * 6/35 命中，不可用。
 *
 * 用法：
 *   node scripts/collect-csp-hashes.mjs http://127.0.0.1:8788 src/generated/csp-hashes.ts
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8788").replace(/\/$/, "");
const OUT = process.argv[3] || "src/generated/csp-hashes.ts";

const SCRIPT_RE = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
const TYPE_RE = /\btype\s*=\s*"([^"]*)"/i;
const EXEC_TYPES = new Set([
	"", "text/javascript", "application/javascript", "module",
	"text/ecmascript", "application/ecmascript",
]);

const sha256b64 = (t) => crypto.createHash("sha256").update(t, "utf8").digest("base64");

function inlineHashes(html) {
	const out = [];
	SCRIPT_RE.lastIndex = 0;
	let m;
	while ((m = SCRIPT_RE.exec(html))) {
		const attrs = m[1];
		if (/\bsrc\s*=/i.test(attrs)) continue;
		const tm = TYPE_RE.exec(attrs);
		if (tm && !EXEC_TYPES.has(tm[1].trim().toLowerCase())) continue;
		out.push(sha256b64(m[2]));
	}
	return out;
}

async function get(p) {
	const res = await fetch(BASE + p, { redirect: "follow" });
	return { status: res.status, body: await res.text() };
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
	} catch { /* ignore */ }
	try {
		const arch = await get("/archive/");
		for (const m of arch.body.matchAll(/href="(\/post\/[^"#?]*?)"/g)) routes.add(m[1]);
		for (const m of arch.body.matchAll(/href="(\/\d+\/)"/g)) routes.add(m[1]);
	} catch { /* ignore */ }
	return [...routes];
}

const routes = await collectRoutes();
const union = new Set();
const perRoute = {};
const failed = [];

for (const r of routes) {
	try {
		const page = await get(r);
		if (page.status >= 400) { failed.push(`${r} -> ${page.status}`); continue; }
		const hs = inlineHashes(page.body);
		perRoute[r] = hs.length;
		for (const h of hs) union.add(h);
	} catch (e) {
		failed.push(`${r} -> ${e.message}`);
	}
}

if (union.size === 0) {
	console.error("❌ 未收集到任何内联脚本哈希 —— 扫描目标可能没跑起来，或页面渲染失败。");
	process.exit(1);
}

const lines = [
	"// 本文件由 scripts/collect-csp-hashes.mjs 自动生成，请勿手改。",
	"// 来源：对运行中的全站做页面扫描，取所有内联可执行脚本的 sha256 并集。",
	"// 重新生成：pnpm build:csp（会先构建 → 扫描 → 再构建）。",
	`// 生成时扫描路由数：${Object.keys(perRoute).length}`,
	"export const CSP_SCRIPT_HASHES: readonly string[] = [",
];
for (const h of [...union].sort()) lines.push(`\t"sha256-${h}",`);
lines.push("];", "");

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, lines.join("\n"), "utf8");

console.log(`  扫描路由 ${Object.keys(perRoute).length} 个，内联脚本哈希并集 ${union.size} 个`);
if (failed.length) console.log(`  跳过（非 2xx）：${failed.join(", ")}`);
console.log(`  已写入 ${OUT}`);
