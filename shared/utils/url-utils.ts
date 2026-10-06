import I18nKey from "@i18n/i18nKey";
import { i18n } from "@i18n/translation";

export function removeFileExtension(id: string): string {
	return id.replace(/\.(md|mdx|markdown)$/i, "");
}

export function normalizeSiteUrl(raw: string): string {
	if (!raw) return raw;
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(raw)) return raw; // 已有协议
	if (raw.startsWith("//")) return `https:${raw}`;
	return `https://${raw}`;
}

export function pathsEqual(path1: string, path2: string): boolean {
	const normalizedPath1 = path1.replace(/^\/|\/$/g, "").toLowerCase();
	const normalizedPath2 = path2.replace(/^\/|\/$/g, "").toLowerCase();
	return normalizedPath1 === normalizedPath2;
}

// 判断是否为绝对 URL（协议相对 // 也算），allowData 控制 data: 是否计入
export function isAbsoluteUrl(src: string, allowData = false): boolean {
	if (
		src.startsWith("http://") ||
		src.startsWith("https://") ||
		src.startsWith("//")
	) {
		return true;
	}
	return allowData && src.startsWith("data:");
}

function joinUrl(...parts: string[]): string {
	// 如果第一个部分是网络URL，直接返回拼接后的结果（不处理协议头的//）
	if (
		parts[0]?.startsWith("http://") ||
		parts[0]?.startsWith("https://") ||
		parts[0]?.startsWith("//")
	) {
		return parts.join("").replace(/(?<!:)\/+/g, "/");
	}

	// 本地路径正常拼接
	const joined = parts.join("/");
	return joined.replace(/\/+/g, "/");
}

/** 内容详情页路径模式（文章/项目），供侧栏显隐、悬浮目录等复用 */
const CONTENT_DETAIL_PATH_PATTERNS = [
	/\/posts\/.+/,
	/\/post\/.+/,
	/\/projects\/.+/,
];

/** 判断路径是否为内容详情页 */
export function isArticleDetailPage(pathname: string): boolean {
	return CONTENT_DETAIL_PATH_PATTERNS.some((re) => re.test(pathname));
}

export function getPostUrlBySlug(slug: string): string {
	// 移除文件扩展名（如 .md, .mdx 等）
	const slugWithoutExt = removeFileExtension(slug);
	return url(`/post/${slugWithoutExt}/`);
}

export function getTagUrl(tag: string): string {
	if (!tag) return url("/archive/");
	return url(`/archive/?tag=${encodeURIComponent(tag.trim())}`);
}

export function getCategoryUrl(category: string | null): string {
	if (
		!category ||
		category.trim() === "" ||
		category.trim().toLowerCase() === "uncategorized" ||
		category.trim().toLowerCase() === i18n(I18nKey.uncategorized).toLowerCase()
	)
		return url("/archive/?uncategorized=true");
	return url(`/archive/?category=${encodeURIComponent(category.trim())}`);
}

// 分类显示名：存储值 "Uncategorized" 本地化为站点语言
export function getCategoryDisplayName(name: string): string {
	const t = name.trim();
	if (
		!t ||
		t.toLowerCase() === "uncategorized" ||
		t.toLowerCase() === i18n(I18nKey.uncategorized).toLowerCase()
	)
		return i18n(I18nKey.uncategorized);
	return t;
}

export function getSearchUrl(query: string): string {
	return url(`/search/?q=${encodeURIComponent(query.trim())}`);
}

export function url(path: string): string {
	if (
		path.startsWith("http://") ||
		path.startsWith("https://") ||
		path.startsWith("//")
	) {
		return path;
	}

	// 只有本地相对路径才添加BASE_URL
	return joinUrl("", import.meta.env.BASE_URL, path);
}

/**
 * 媒体域 Cookie 族：media_tkt 门票的 Domain 作用域（见 server/media/ticket.ts
 * 的 ticketSetCookie —— 宿主在 *.yangshu.cc.cd 族内时种 Domain=.yangshu.cc.cd，
 * 否则退化为 host-only）。
 * 这里从媒体域反推同族根域（媒体域约定为 <sub>.<apex>，故去掉首段标签），
 * 保证「能否跨子域共用门票」的判定与种票侧一致。
 */
function mediaCookieFamily(mediaHost: string): string {
	const parts = mediaHost.trim().toLowerCase().split(".").filter(Boolean);
	return parts.length > 2 ? parts.slice(1).join(".") : parts.join(".");
}

/** 当前站点宿主是否能与媒体域共用 media_tkt 门票（同族子域才行） */
export function sharesMediaCookieDomain(
	hostname: string | undefined | null,
	mediaHost: string,
): boolean {
	if (!hostname || !mediaHost) return false;
	const h = hostname.trim().toLowerCase();
	const family = mediaCookieFamily(mediaHost);
	if (!family) return false;
	return h === family || h.endsWith(`.${family}`);
}

/**
 * 媒体直链重写（媒体域架构）：
 * D1 中存储的站内媒体引用为 /api/covers/<key> 形态（R2 covers/ 前缀）。
 * 仅当站点自身运行在媒体域同族域（*.yangshu.cc.cd）时，才改写为 image 自定义域直链：
 * 此时 media_tkt 是 Domain=.yangshu.cc.cd 的跨子域 Cookie，浏览器会自动携带，
 * 从而绕过 Pages 中转、直接命中 R2 immutable 长缓存。
 *
 * 反之（如 *.pages.dev 预览域）门票退化为 host-only，跨域请求不会携带，
 * 直连必然 403 —— 此时必须保持站内 /api/covers/ 相对路径
 * （同源路由 src/pages/api/covers/[...path].ts 直接读 R2，无需门票）。
 */
export function toMediaUrl(path: string, hostname?: string): string {
	if (!path) return path;
	const m = /^\/api\/covers\/(.+?)\/?$/.exec(path);
	if (!m) return path;
	// 逐段编码 + 末尾保留斜杠：项目 trailingSlash:"always"，
	// /api/covers/<k> 无尾斜杠会被 Astro 判为未匹配 → 404（实测 404 vs 200）。
	const encoded = m[1]
		.replace(/\/+$/, "")
		.split("/")
		.map(encodeURIComponent)
		.join("/");
	const sameOrigin = `/api/covers/${encoded}/`;

	const host = (import.meta.env.MEDIA_IMAGE_HOST as string | undefined) ?? "";
	// 仅生产重写：dev 无票据 cookie，改写会导致图片 403
	if (!host || !import.meta.env.PROD) return sameOrigin;
	// 门票无法跨子域携带时（如 *.pages.dev 预览域），必须走站内同源路由
	if (!sharesMediaCookieDomain(hostname, host)) return sameOrigin;
	return `https://${host}/covers/${encoded}/`;
}
