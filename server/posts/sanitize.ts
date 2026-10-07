const UNSAFE_TAG_NAMES = new Set([
	"script",
	"object",
	"embed",
	"form",
	"base",
	"link",
	"meta",
	"style",
	"noscript",
	"template",
	"frame",
	"frameset",
	"applet",
	"math",
	"mtext",
	"mglyph",
	"annotation-xml",
	"input",
	"textarea",
	"select",
	"keygen",
	// ── 以下为 2026-10 安全审计新增 ──
	// SVG 整族：SVG 的 SMIL 动画可改写其它元素的 URL 属性，从而绕过 url 属性过滤：
	//   <svg><a><animate attributeName="href" values="javascript:..."/></a></svg>
	// 实测该载荷能穿过旧黑名单并在浏览器点击后执行 JS（见提交说明）。
	// 直接封掉 svg 根元素即可终结整个 SVG 攻击面；站点正文/图标均不使用内联 SVG，
	// 页面自身的图标由 Astro 组件渲染，不经过本消毒器。
	"svg",
	"animate",
	"animatetransform",
	"animatemotion",
	"set",
	"use",
	"foreignobject",
	"discard",
	"handler",
	"listener",
	"image",
	"portal",
	"marquee",
	// 可嵌入外部文档/脚本执行上下文
	"iframe",
]);

const URL_PROPERTY_NAMES = new Set([
	"href",
	"src",
	"srcset",
	"xlink:href",
	"xlinkhref",
	"action",
	"formaction",
	"poster",
	"cite",
	"background",
	"data",
]);

function sanitizeSrcset(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const parts = value.split(",").map((p) => p.trim());
	const cleaned: string[] = [];
	for (const part of parts) {
		if (!part) continue;
		const [url, ...descriptor] = part.split(/\s+/);
		const clean = sanitizeUrl(url);
		if (clean === undefined) continue; // 丢弃危险候选
		cleaned.push(
			descriptor.length ? `${clean} ${descriptor.join(" ")}` : clean,
		);
	}
	return cleaned.length ? cleaned.join(", ") : undefined;
}

const STRIP_ATTRIBUTE_NAMES = new Set(["srcdoc"]);

/**
 * SMIL 动画属性：这些属性本身不带 URL，但能改写**其它元素**的 URL 属性
 * （如 <animate attributeName="href" values="javascript:...">），是绕过 URL 过滤的经典路径。
 * 无论出现在哪个元素上都一律剥离——纵深防御：即便将来有动画元素漏过标签黑名单，
 * 载荷属性也已被清空，无法生效。
 */
const ANIMATION_ATTRIBUTE_NAMES = new Set([
	"attributename",
	"attributetype",
	"values",
	"to",
	"from",
	"by",
	"begin",
	"end",
	"dur",
	"repeatcount",
	"repeatdur",
	"calcmode",
	"keytimes",
	"keysplines",
	"keypoints",
	"additive",
	"accumulate",
	"restart",
	"path",
]);


export function sanitizeUrl(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;

	const v = value.replace(/[\t\r\n]/g, "").trim();
	const lower = v.toLowerCase();
	if (
		lower.startsWith("javascript:") ||
		lower.startsWith("vbscript:") ||
		lower.startsWith("file:")
	)
		return undefined;
	if (lower.startsWith("data:")) {
		if (!lower.startsWith("data:image/") || lower.includes("svg"))
			return undefined;
	}
	return v;
}

export function sanitizeHast(node: unknown): unknown {
	const n = node as {
		type?: string;
		tagName?: string;
		properties?: Record<string, unknown>;
		children?: unknown[];
	};
	if (n?.type === "element") {
		const tag = String(n.tagName || "").toLowerCase();
		// 黑名单命中，或带命名空间的标签（如 svg:script / math:mi 这类 XML 命名空间写法）→ 整个丢弃
		if (UNSAFE_TAG_NAMES.has(tag) || tag.includes(":")) return null;

		if (n.properties && typeof n.properties === "object") {
			for (const key of Object.keys(n.properties)) {
				const lowerKey = key.toLowerCase();
				if (
					lowerKey.startsWith("on") ||
					STRIP_ATTRIBUTE_NAMES.has(lowerKey) ||
					ANIMATION_ATTRIBUTE_NAMES.has(lowerKey)
				) {
					delete n.properties[key];
					continue;
				}
				if (URL_PROPERTY_NAMES.has(lowerKey)) {
					if (lowerKey === "srcset") {
						const clean = sanitizeSrcset(n.properties[key]);
						if (clean === undefined) delete n.properties[key];
						else n.properties[key] = clean;
					} else {
						const clean = sanitizeUrl(n.properties[key]);
						if (clean === undefined) delete n.properties[key];
						else n.properties[key] = clean;
					}
				}
			}
		}
	}
	if (Array.isArray(n?.children)) {
		n.children = n.children.map(sanitizeHast).filter((child) => child !== null);
	}
	return n;
}

export function rehypeSanitizeDangerous() {
	return (tree: unknown) => {
		sanitizeHast(tree);
	};
}

/** 响应脱敏：删除口令字段；加密文章再删除正文相关字段（不回填 encrypted 标记） */
export function redactPostSecrets<T>(post: T): T {
	const copy = { ...(post as Record<string, unknown>) };
	const isEncrypted = Boolean(
		copy.password ??
			(copy as { frontmatter?: { password?: unknown } }).frontmatter?.password,
	);
	delete copy.password;
	delete copy.passwordHint;
	if (copy.frontmatter && typeof copy.frontmatter === "object") {
		const fm = { ...(copy.frontmatter as Record<string, unknown>) };
		delete fm.password;
		delete fm.passwordHint;
		copy.frontmatter = fm;
	}
	if (isEncrypted) {
		delete copy.html;
		delete copy.headings;
		delete copy.source;
		delete copy.markdown;
	}
	return copy as T;
}
