#!/usr/bin/env node
/**
 * 把 node_modules/vditor/dist 同步到 public/vditor/dist（自托管编辑器运行时资源）。
 *
 * 为什么必须自托管：线上 CSP 是「script-src 'self' + 内联脚本 sha256 白名单」，
 * 不允许 https://cdn.jsdelivr.net。而 Vditor 构造函数会主动
 * addScript(cdn + "/dist/js/i18n/zh_CN.js")，被 CSP 拦掉后只渲染一个 .vditor-tip
 * 错误提示、**不会调用 init()** → 后台编辑器空白。
 * 把 cdn 指向同源 /vditor（Vditor 内部一律拼 "/dist/..."）后，所有资源请求
 * 都命中 'self'，无需放宽 CSP。
 *
 * 为什么不入库：dist 约 24MB，且每次升级 vditor 都要整体替换。
 * 幂等：目标目录先删后拷，重复执行结果一致；源缺失直接 fail，不产出半成品。
 */
import fs from "node:fs";
import path from "node:path";

const SRC = "node_modules/vditor/dist";
const DEST = "public/vditor/dist";

// Vditor 运行时按需请求的相对路径（与 node_modules/vditor/dist/index.js 内
// `${cdn}/dist/...` 的拼接一一对应），缺任何一个都会在后台静默失败。
const REQUIRED = [
	"index.css",
	"index.min.js",
	"method.min.js",
	"js/lute/lute.min.js",
	"js/i18n/zh_CN.js",
	"js/icons/ant.js",
	"js/highlight.js/highlight.min.js",
	"js/highlight.js/styles/github.min.css",
	"js/highlight.js/styles/github-dark.min.css",
	"css/content-theme/light.css",
	"css/content-theme/dark.css",
	"images/emoji",
];

if (!fs.existsSync(SRC) || !fs.statSync(SRC).isDirectory()) {
	console.error(`❌ 缺少 Vditor 资源源目录：${SRC}`);
	console.error("   vditor 是 dependencies，请先执行 pnpm install。");
	process.exit(1);
}

const missing = REQUIRED.filter((p) => !fs.existsSync(path.join(SRC, p)));
if (missing.length) {
	console.error("❌ Vditor 资源不完整，缺少：");
	for (const p of missing) console.error(`   ${path.join(SRC, p)}`);
	console.error("   请确认 vditor 安装完整（版本可能变更了目录结构）。");
	process.exit(1);
}

fs.rmSync(DEST, { recursive: true, force: true });
fs.mkdirSync(path.dirname(DEST), { recursive: true });
fs.cpSync(SRC, DEST, { recursive: true });

function walk(dir) {
	let files = 0;
	let bytes = 0;
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			const sub = walk(full);
			files += sub.files;
			bytes += sub.bytes;
		} else {
			files += 1;
			bytes += fs.statSync(full).size;
		}
	}
	return { files, bytes };
}

const { files, bytes } = walk(DEST);
console.log(
	`✅ Vditor 资源已同步：${SRC} → ${DEST}（${files} 个文件，${(bytes / 1024 / 1024).toFixed(1)} MB）`,
);
