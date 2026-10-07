#!/usr/bin/env node
/**
 * 两遍构建：把「全站内联脚本 sha256 并集」写进中间件 CSP。
 *
 * 为什么需要两遍：
 *   哈希只能从**渲染后的页面**里算（Astro 会把部分模块压缩后内联，源码里没有
 *   对应文本；define:vars 还会注入额外声明）→ 必须先把站点构建起来、跑起来才能扫。
 *   而中间件是编译进 worker 的，扫描结果要生效就得再构建一次。
 *
 * 为什么扫描用本地预览而不是线上：
 *   本地 `.wrangler/local-state` 的 D1 数据与线上同源，页面组件组合一致。
 *   扫描会覆盖首页/归档/全部分页/文章页/各功能页，取的是并集，因此只要
 *   本地数据不比线上少，白名单就不会漏。
 *
 * 安全网：部署后用 `node scripts/verify-csp-hashes.mjs <线上地址>` 复验
 *   每个页面的内联脚本哈希都在 CSP 白名单内（漏了会被浏览器静默拦掉）。
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import process from "node:process";

const PORT = Number(process.env.CSP_SCAN_PORT || 8788);
const BASE = `http://127.0.0.1:${PORT}`;
const ASTRO = "node_modules/astro/bin/astro.mjs";
const WRANGLER = "node_modules/wrangler/bin/wrangler.js";
const HASHES_TS = "src/generated/csp-hashes.ts";

function runNode(args, label) {
	const r = spawnSync(process.execPath, args, { stdio: "inherit" });
	if (r.status !== 0) {
		console.error(`\n❌ ${label} 失败（exit ${r.status}）`);
		process.exit(r.status ?? 1);
	}
}

// 中间件 import 了这个文件，首次构建前必须存在，否则编译失败
if (!fs.existsSync(HASHES_TS)) {
	fs.mkdirSync("src/generated", { recursive: true });
	fs.writeFileSync(
		HASHES_TS,
		"// 占位：首次运行 pnpm build:csp 时会被真实扫描结果覆盖。\n" +
			"export const CSP_SCRIPT_HASHES: readonly string[] = [];\n",
		"utf8",
	);
	console.log(`  已创建占位 ${HASHES_TS}`);
}

console.log("\n[1/5] astro build（第一遍：产出可运行 dist）");
runNode([ASTRO, "build"], "第一遍构建");

console.log("\n[2/5] 启动本地预览用于扫描");
const server = spawn(
	process.execPath,
	[WRANGLER, "pages", "dev", "dist", "--port", String(PORT), "--ip", "127.0.0.1",
		"--persist-to", ".wrangler/local-state"],
	{ stdio: ["ignore", "pipe", "pipe"] },
);
let serverLog = "";
server.stdout.on("data", (d) => { serverLog += d.toString(); });
server.stderr.on("data", (d) => { serverLog += d.toString(); });

function killServer() {
	try {
		if (process.platform === "win32") {
			spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
		} else {
			server.kill("SIGTERM");
		}
	} catch { /* ignore */ }
}

async function waitReady(timeoutMs = 120_000) {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		try {
			const res = await fetch(`${BASE}/`, { redirect: "follow" });
			if (res.ok) return;
		} catch { /* 还没起来 */ }
		await new Promise((r) => setTimeout(r, 1000));
	}
	killServer();
	console.error("\n❌ 本地预览在超时内未就绪。wrangler 输出：\n" + serverLog.slice(-3000));
	process.exit(1);
}

try {
	await waitReady();
	console.log(`  就绪：${BASE}`);

	console.log("\n[3/5] 扫描全站，生成内联脚本哈希并集");
	runNode(["scripts/collect-csp-hashes.mjs", BASE, HASHES_TS], "哈希扫描");
} finally {
	console.log("\n[4/5] 关闭本地预览");
	killServer();
}

console.log("\n[5/5] astro build（第二遍：把哈希编进中间件 CSP）+ 折叠路由规则");
runNode([ASTRO, "build"], "第二遍构建");
runNode(["scripts/collapse-routes.mjs"], "折叠路由规则");

console.log("\n✅ 构建完成。部署后建议复验：");
console.log("   node scripts/verify-csp-hashes.mjs https://yangshu.cc.cd\n");
