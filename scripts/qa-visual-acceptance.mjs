#!/usr/bin/env node
/**
 * 全站可视化验收。
 *
 * 做三件事（对每个路由）：
 *   1. 访问页面并整页截图
 *   2. 逐个点击页面上的按钮（每个按钮都在**重新加载后的干净页面**上点一次，
 *      避免前一个按钮的状态污染后一个），记录点击是否引发新的控制台错误
 *   3. 收集 console error / pageerror / CSP 违规
 *
 * 用法：
 *   node scripts/qa-visual-acceptance.mjs http://127.0.0.1:8788 qa-shots
 *   CLICK_BUTTONS=0 node scripts/qa-visual-acceptance.mjs <base> <out>   # 只截图不点按钮
 *
 * 环境变量 CHROME_PATH 可覆盖浏览器路径。
 */
import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";

const BASE = (process.argv[2] || "http://127.0.0.1:8788").replace(/\/$/, "");
const OUT = process.argv[3] || "qa-shots";
const CHROME =
	process.env.CHROME_PATH ||
	"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const CLICK_BUTTONS = process.env.CLICK_BUTTONS !== "0";
const CLICK_TIMEOUT = Number(process.env.CLICK_TIMEOUT || 4000);

const FIXED_ROUTES = [
	"/", "/about/", "/archive/", "/categories/", "/tags/", "/series/",
	"/search/", "/friends/", "/guestbook/", "/dynamic/", "/gallery/",
	"/booknav/", "/sponsor/", "/login/", "/register/", "/privacy/", "/terms/",
];

const BUTTON_SELECTOR = 'button, [role="button"], summary, input[type="button"], input[type="submit"]';

function slugOf(route) {
	const s = route.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
	return s || "home";
}

async function collectRoutes() {
	const routes = new Set(FIXED_ROUTES);
	try {
		const r = await fetch(`${BASE}/sitemap.xml`);
		const xml = await r.text();
		for (const m of xml.matchAll(/<loc>(.*?)<\/loc>/g)) {
			routes.add(m[1].trim().replace(/^https?:\/\/[^/]+/, "") || "/");
		}
	} catch { /* ignore */ }
	try {
		const r = await fetch(`${BASE}/archive/`);
		const html = await r.text();
		for (const m of html.matchAll(/href="(\/post\/[^"#?]*?)"/g)) routes.add(m[1]);
		for (const m of html.matchAll(/href="(\/\d+\/)"/g)) routes.add(m[1]);
	} catch { /* ignore */ }
	return [...routes].sort();
}

fs.mkdirSync(OUT, { recursive: true });

const routes = await collectRoutes();
console.log(`验收目标: ${BASE}`);
console.log(`路由数量: ${routes.length}`);
console.log(`点击按钮: ${CLICK_BUTTONS ? "是" : "否"}\n`);

const browser = await chromium.launch({ executablePath: CHROME, headless: true });

const report = {
	base: BASE,
	generatedAt: new Date().toISOString(),
	pages: [],
	summary: { routes: routes.length, screenshots: 0, buttonsFound: 0, buttonsClicked: 0,
		clickErrors: 0, consoleErrors: 0, pageErrors: 0, cspViolations: 0 },
};

const CSP_RE = /Content Security Policy|Refused to (execute|load|apply)/i;

for (const route of routes) {
	const slug = slugOf(route);
	const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
	const errors = [];
	const csp = [];
	page.on("console", (m) => {
		const t = m.text();
		if (m.type() === "error") {
			errors.push(t);
			if (CSP_RE.test(t)) csp.push(t);
		}
	});
	page.on("pageerror", (e) => errors.push(`PAGEERROR: ${e.message}`));

	let status = 0;
	let buttons = [];
	try {
		const resp = await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 90000 });
		status = resp ? resp.status() : 0;
		await page.waitForLoadState("load", { timeout: 30000 }).catch(() => {});
		await page.waitForTimeout(1500);
	} catch (e) {
		errors.push(`NAV: ${e.message}`);
	}

	const shotPath = path.join(OUT, `${slug}.png`);
	try {
		await page.screenshot({ path: shotPath, fullPage: true });
		report.summary.screenshots++;
	} catch (e) {
		errors.push(`SCREENSHOT: ${e.message}`);
	}

	if (CLICK_BUTTONS) {
		try {
			buttons = await page.locator(BUTTON_SELECTOR).all();
		} catch { buttons = []; }
	}

	const pageRec = { route, status, slug, buttons: buttons.length, clicked: 0, clickFailures: [],
		errors: [...errors], cspViolations: [...csp] };
	report.summary.buttonsFound += buttons.length;

	if (CLICK_BUTTONS && buttons.length) {
		for (let i = 0; i < buttons.length; i++) {
			// 每个按钮都在重新加载后的干净页面上点，避免状态互相污染
			try {
				await page.goto(BASE + route, { waitUntil: "domcontentloaded", timeout: 60000 });
				await page.waitForTimeout(700);
			} catch { /* 继续尝试点击 */ }

			const before = errors.length;
			const target = page.locator(BUTTON_SELECTOR).nth(i);
			let label = "";
			try { label = (await target.innerText({ timeout: 1000 })).trim().slice(0, 30); } catch { /* ignore */ }
			try {
				await target.click({ timeout: CLICK_TIMEOUT });
				pageRec.clicked++;
				report.summary.buttonsClicked++;
				await page.waitForTimeout(400);
			} catch (e) {
				const msg = String(e.message || e).split("\n")[0].slice(0, 120);
				pageRec.clickFailures.push({ index: i, label, reason: msg });
				report.summary.clickErrors++;
				continue;
			}
			const added = errors.slice(before);
			if (added.length) {
				pageRec.clickFailures.push({ index: i, label, newErrors: added.slice(0, 3) });
			}
		}
	}

	report.summary.consoleErrors += errors.filter((e) => !e.startsWith("PAGEERROR")).length;
	report.summary.pageErrors += errors.filter((e) => e.startsWith("PAGEERROR")).length;
	report.summary.cspViolations += csp.length;
	report.pages.push(pageRec);

	console.log(
		`  ${route.padEnd(28)} ${String(status).padEnd(4)} 按钮 ${String(pageRec.buttons).padEnd(3)} ` +
		`已点 ${String(pageRec.clicked).padEnd(3)} 错误 ${errors.length} CSP ${csp.length}`,
	);

	await page.close();
}

await browser.close();
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1), "utf8");

console.log("\n================ 汇总 ================");
console.log(`路由        : ${report.summary.routes}`);
console.log(`截图        : ${report.summary.screenshots}  (${OUT}/)`);
console.log(`发现按钮    : ${report.summary.buttonsFound}`);
console.log(`成功点击    : ${report.summary.buttonsClicked}`);
console.log(`点击失败    : ${report.summary.clickErrors}`);
console.log(`控制台错误  : ${report.summary.consoleErrors}`);
console.log(`页面级异常  : ${report.summary.pageErrors}`);
console.log(`CSP 违规    : ${report.summary.cspViolations}`);
console.log(`报告        : ${path.join(OUT, "report.json")}`);

process.exit(report.summary.cspViolations > 0 || report.summary.pageErrors > 0 ? 1 : 0);
