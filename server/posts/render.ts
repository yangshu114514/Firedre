// biome-ignore lint/suspicious/noShadowRestrictedNames: 沿用 mdast-util-toString 原名
import { toString } from "mdast-util-to-string";
import rehypeRaw from "rehype-raw";
import rehypeStringify from "rehype-stringify";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkRehype from "remark-rehype";
import remarkSmartypants from "remark-smartypants";
import { unified } from "unified";
import { visit } from "unist-util-visit";
import "katex/dist/contrib/mhchem.mjs"; // mhchem 扩展
import { defaultsLocals, getSiteConfig } from "@shared/config/runtime";

const siteConfig = getSiteConfig(defaultsLocals);

import {
	sharedRehypePlugins,
	sharedRemarkPlugins,
} from "@shared/plugins/markdown-preset.mjs";
import {
	remarkWikiLinkRuntime,
	type WikiLinkResolver,
} from "@shared/plugins/remark-wiki-link-runtime";
import type { MarkdownHeading } from "../../types/posts";
import { rehypeSanitizeDangerous } from "./sanitize";

export { stripMarkdown } from "./markdown";

export interface RenderedMarkdown {
	html: string;
	headings: MarkdownHeading[];
	words: number;
	minutes: number;
	excerpt: string;
	frontmatter: Record<string, unknown>;
}

export interface RenderMarkdownOptions {
	frontmatter?: Record<string, unknown>;

	resolveWikiLink?: WikiLinkResolver;

	/**
	 * 按内容特征裁剪重型插件（默认全部启用，保持既有语义）。
	 * Cloudflare Pages Functions（Free）单次调用 CPU 上限 10ms，
	 * 全量插件链实测中位数 7~15ms，超限即 Error 1102（随机 503）。
	 */
	features?: MarkdownFeatureFlags;
}

export interface MarkdownFeatureFlags {
	math?: boolean;
	callouts?: boolean;
	codeGroup?: boolean;
	diagrams?: boolean;
	github?: boolean;
}

/**
 * 从源码探测所需的 Markdown 特性。
 * 只做廉价的字符串匹配（无 AST），用于跳过内容中根本不存在的重型插件。
 * 判断保守：命中任一可疑模式就启用，宁多算不漏渲染。
 */
export function detectMarkdownFeatures(
	source: string,
): Required<MarkdownFeatureFlags> {
	// 数学：$...$ / $$...$$（remark-math 语法）
	const math = /\$\$[\s\S]*?\$\$|\$[^$\n]+\$/.test(source);
	// 标注块：:::note / > [!NOTE]（rehype-callouts / admonition）
	const callouts = /^:::+|\n:::+|\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]/i.test(
		source,
	);
	// 代码分组：` ```group ` 或 tab 语法
	const codeGroup = /```+\s*(?:group|tabs?)\b/i.test(source);
	// 图表：mermaid / plantuml fenced block
	const diagrams = /```+\s*(?:mermaid|plantuml|puml)\b/i.test(source);
	// GitHub 卡片：::github{repo="owner/repo"}
	const github = /::github\{/.test(source);

	return { math, callouts, codeGroup, diagrams, github };
}

function remarkReadingTimeLocal() {
	return (tree: unknown, file: { data?: Record<string, unknown> }) => {
		const textOnPage = toString(tree as never);
		// 与 Firefly remark-reading-time 相同的估算
		const words = countTextWords(textOnPage);
		const minutes = Math.max(1, Math.round(words / 200));
		const fm = (file.data?.frontmatter ?? {}) as Record<string, unknown>;
		fm.words = words;
		fm.minutes = minutes;
		file.data = { ...(file.data || {}), frontmatter: fm };
	};
}

function remarkExcerptLocal() {
	return (tree: unknown, file: { data?: Record<string, unknown> }) => {
		let excerpt = "";
		for (const node of (tree as { children?: unknown[] }).children ?? []) {
			if ((node as { type?: string }).type !== "paragraph") continue;
			excerpt = toString(node as never);
			break;
		}
		const fm = (file.data?.frontmatter ?? {}) as Record<string, unknown>;
		fm.excerpt = excerpt;
		file.data = { ...(file.data || {}), frontmatter: fm };
	};
}

function countTextWords(text: string): number {
	const trimmed = text.trim();
	if (!trimmed) return 0;
	const cjk =
		trimmed.match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g)?.length ?? 0;
	const words = trimmed.split(/\s+/).filter(Boolean).length;
	return cjk + words;
}

function rehypeCollectHeadings() {
	return (tree: unknown, file: { data?: Record<string, unknown> }) => {
		const headings: MarkdownHeading[] = [];
		visit(
			tree as never,
			(node: {
				type?: string;
				tagName?: string;
				properties?: Record<string, unknown>;
			}) => {
				if (node.type !== "element" || typeof node.tagName !== "string") return;
				const m = /^h([1-6])$/.exec(node.tagName);
				if (!m) return;
				const depth = Number.parseInt(m[1], 10);
				const text = toString(node as never);
				const slug = String(node.properties?.id || "");
				headings.push({ depth, slug, text });
			},
		);
		file.data = { ...(file.data || {}), headings };
	};
}

interface UnifiedProcessor extends ReturnType<typeof unified> {
	use(...args: unknown[]): UnifiedProcessor;
}

/**
 * Processor 缓存（按 wiki-link 解析器身份分桶）。
 *
 * 背景：旧实现每次渲染都新建 unified 链（20+ 插件）。单次冷建成本实测 15~26ms，
 * 而 Cloudflare Pages Functions（Free 套餐）单次调用 CPU 上限仅 10ms，
 * 超限即 Error 1102「Worker exceeded resource limits」，表现为随机 503：
 * 全量渲染路由（/privacy/、/terms/、/about/、文章页）失败率 30%~80%，
 * 不渲染的接口（/api/friends/）0%。unified 的 processor 与 file 无关、
 * 插件注册后无请求级可变状态，故按解析器身份缓存复用即可，语义不变。
 *
 * 桶上限 2：正常只有「无解析器」与「文章解析器」两种；解析器是模块级闭包
 * （buildWikiLinkResolver 每次新建），故用 WeakMap 以身份为键，避免请求泄漏。
 */
const processorCache = new WeakMap<WikiLinkResolver, UnifiedProcessor>();

/**
 * 特性组合 → processor 的缓存（无 wiki-link 解析器的情形）。
 * 键为 5 个布尔位拼成的字符串，最多 32 种组合。
 */
const featureProcessorCache = new Map<string, UnifiedProcessor>();

function featureKey(features: Required<MarkdownFeatureFlags>): string {
	return [
		features.math ? 1 : 0,
		features.callouts ? 1 : 0,
		features.codeGroup ? 1 : 0,
		features.diagrams ? 1 : 0,
		features.github ? 1 : 0,
	].join("");
}

function buildProcessor(
	resolveWikiLink: WikiLinkResolver | null,
	features: Required<MarkdownFeatureFlags>,
) {
	return (unified() as unknown as UnifiedProcessor)
		.use(remarkParse)
		.use(remarkGfm)
		.use(remarkSmartypants)
		.use(
			sharedRemarkPlugins({
				readingTime: remarkReadingTimeLocal,
				wikiLink: [
					remarkWikiLinkRuntime,
					{
						resolve: (contentPath: string) =>
							resolveWikiLink
								? resolveWikiLink(contentPath)
								: Promise.resolve(null),
					},
				],
				excerpt: remarkExcerptLocal,
				math: features.math,
			}),
		)
		.use(remarkRehype, { allowDangerousHtml: true })
		.use(rehypeRaw)
		.use(rehypeSanitizeDangerous)
		.use(
			sharedRehypePlugins(siteConfig, {
				beforeAutolink: [rehypeCollectHeadings],
				features: {
					math: features.math,
					callouts: features.callouts,
					codeGroup: features.codeGroup,
					diagrams: features.diagrams,
					github: features.github,
				},
			}),
		)
		.use(rehypeStringify, { allowDangerousHtml: true });
}

function getProcessor(
	resolveWikiLink: WikiLinkResolver | null,
	features: Required<MarkdownFeatureFlags>,
): UnifiedProcessor {
	const key = featureKey(features);
	if (!resolveWikiLink) {
		let cached = featureProcessorCache.get(key);
		if (!cached) {
			cached = buildProcessor(null, features);
			featureProcessorCache.set(key, cached);
		}
		return cached;
	}
	let cached = processorCache.get(resolveWikiLink);
	if (!cached) {
		cached = buildProcessor(resolveWikiLink, features);
		processorCache.set(resolveWikiLink, cached);
	}
	return cached;
}

export async function renderMarkdown(
	content: string,
	options: RenderMarkdownOptions = {},
): Promise<RenderedMarkdown> {
	const features = {
		math: true,
		callouts: true,
		codeGroup: true,
		diagrams: true,
		github: true,
		...options.features,
	} as Required<MarkdownFeatureFlags>;
	const processor = getProcessor(options.resolveWikiLink ?? null, features);
	const data: Record<string, unknown> = {
		frontmatter: options.frontmatter ?? {},
	};
	const file = await processor.process({ value: content, data });
	const fm = (file.data.frontmatter ?? {}) as Record<string, unknown>;
	const headings = (file.data.headings ?? []) as MarkdownHeading[];
	return {
		html: String(file.value),
		headings,
		words: typeof fm.words === "number" ? fm.words : 0,
		minutes: typeof fm.minutes === "number" ? fm.minutes : 0,
		excerpt: typeof fm.excerpt === "string" ? fm.excerpt : "",
		frontmatter: fm,
	};
}
