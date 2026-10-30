import type { MarkdownHeading } from "../../types/posts";
import { detectMarkdownFeatures, renderMarkdown } from "./render";

/**
 * Markdown 渲染结果缓存。
 *
 * 为什么需要：Cloudflare Pages Functions（Free 套餐）单次调用 CPU 上限 10ms，
 * 而 unified 渲染链实测中位数 7~15ms（含 remark-gfm + rehype-raw + 各类 rehype 插件），
 * 超限即 Error 1102「Worker exceeded resource limits」。表现为随机 503：
 * 实测 /privacy/、/terms/、/about/、文章页失败率 30%~80%，不渲染的接口 0%。
 *
 * 策略：以「内容 etag（R2 对象身份）」为键缓存渲染结果。
 * - L1：isolate 内 Map（上限 64 条，LRU 淘汰），同 isolate 重复请求零渲染
 * - L2：caches.default（跨 isolate / 跨 colo），键含 etag 故内容变更自动失效
 * 内容变更 → R2 对象被覆写 → etag 变化 → 键变化，不会读到旧 HTML。
 * 只缓存解析产物（html/headings/words/minutes/excerpt），不缓存请求级数据。
 */

const L1_MAX_ENTRIES = 64;
const L2_TTL_SECONDS = 3600;

// 项目全局类型中 caches.default 仅声明 match/put（与 src/pages/api/cover-proxy.ts 一致）
type RenderCache = {
	match(req: Request | string): Promise<Response | undefined>;
	put(req: Request | string, resp: Response): Promise<void>;
};

function edgeCache(): RenderCache | null {
	try {
		return (
			globalThis as unknown as { caches?: { default?: RenderCache } }
		).caches?.default ?? null;
	} catch {
		return null;
	}
}

export interface CachedRender {
	html: string;
	headings: MarkdownHeading[];
	words: number;
	minutes: number;
	excerpt: string;
}

const l1 = new Map<string, CachedRender>();

function l1Get(key: string): CachedRender | undefined {
	const hit = l1.get(key);
	if (hit) {
		// LRU：命中后移到末尾
		l1.delete(key);
		l1.set(key, hit);
	}
	return hit;
}

function l1Set(key: string, value: CachedRender): void {
	if (l1.size >= L1_MAX_ENTRIES) {
		const oldest = l1.keys().next().value;
		if (oldest !== undefined) l1.delete(oldest);
	}
	l1.set(key, value);
}

function l2Url(scope: string, key: string, origin: string): string {
	return `${origin}/__md_render_cache__/${encodeURIComponent(scope)}/${encodeURIComponent(key)}`;
}

function isValidCached(value: unknown): value is CachedRender {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return typeof v.html === "string" && Array.isArray(v.headings);
}

/**
 * 带缓存的渲染。
 * @param scope 缓存作用域（如 `spec:privacy`、`about`、`post:<slug>`），用于区分不同页面
 * @param version 内容版本（R2 etag 或 settings 版本），内容变化即失效
 * @param origin 站点 origin（L2 缓存键需要绝对 URL；缺省则只用 L1）
 */
export async function renderMarkdownCached(
	scope: string,
	version: string,
	content: string,
	origin?: string,
): Promise<CachedRender> {
	const key = `${scope}@${version}`;

	const hitL1 = l1Get(key);
	if (hitL1) return hitL1;

	// L2：caches.default（失败不影响主流程）
	if (origin) {
		const cache = edgeCache();
		try {
			const cached = await cache?.match(l2Url(scope, version, origin));
			if (cached) {
				const parsed: unknown = await cached.json();
				if (isValidCached(parsed)) {
					l1Set(key, parsed);
					return parsed;
				}
			}
		} catch {
			// 缓存不可用：继续走渲染
		}
	}

	// 按内容特征裁剪重型插件：内容里不存在的语法不装配对应插件，语义不变
	const rendered = await renderMarkdown(content, {
		features: detectMarkdownFeatures(content),
	});
	const value: CachedRender = {
		html: rendered.html,
		headings: rendered.headings,
		words: rendered.words,
		minutes: rendered.minutes,
		excerpt: rendered.excerpt,
	};

	l1Set(key, value);

	if (origin) {
		const cache = edgeCache();
		try {
			await cache?.put(
				l2Url(scope, version, origin),
				new Response(JSON.stringify(value), {
					headers: {
						"Content-Type": "application/json",
						"Cache-Control": `public, max-age=${L2_TTL_SECONDS}`,
					},
				}),
			);
		} catch {
			// 缓存写入失败不影响返回
		}
	}

	return value;
}
