/**
 * 媒体访问门票（media ticket）
 *
 * 设计（用户确认方案）：
 * - 浏览器直连 music/image/misc 二级域时，凭同父域 Cookie `media_tkt` 通过校验；
 * - 门票 = "<exp>.<sig>"，sig = HMAC-SHA256(USER_SESSION_SECRET, "media|<exp>") 截断 32 hex；
 * - 有效期 30 天，由 /api/media/ticket 端点种发（媒体函数无票时 302 引导，避免 HTML 缓存携带 Set-Cookie）；
 * - 媒体 URL 保持无 query（干净 URL），Cloudflare 边缘缓存 key 稳定，长期 immutable 缓存几乎零 R2 读。
 */
const TICKET_COOKIE = "media_tkt";
const TICKET_TTL_SECONDS = 30 * 24 * 3600; // 30 天

function hmacHex(secret: string, data: string): Promise<string> {
	const enc = new TextEncoder();
	return crypto.subtle
		.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
			"sign",
		])
		.then((key) => crypto.subtle.sign("HMAC", key, enc.encode(data)))
		.then((buf) =>
			[...new Uint8Array(buf)]
				.map((b) => b.toString(16).padStart(2, "0"))
				.join(""),
		);
}

/** 签发一张门票（exp 对齐到小时，减少无谓变化） */
export async function issueMediaTicket(secret: string): Promise<{
	value: string;
	maxAge: number;
}> {
	const exp = Math.ceil((Date.now() + TICKET_TTL_SECONDS * 1000) / 3_600_000) * 3_600;
	const sig = (await hmacHex(secret, `media|${exp}`)).slice(0, 32);
	return { value: `${exp}.${sig}`, maxAge: TICKET_TTL_SECONDS };
}

/** 校验门票（常量时间比较，防时序侧信道） */
export async function verifyMediaTicket(
	secret: string,
	ticket: string | undefined | null,
): Promise<boolean> {
	if (!ticket) return false;
	const dot = ticket.indexOf(".");
	if (dot <= 0) return false;
	const expStr = ticket.slice(0, dot);
	const sig = ticket.slice(dot + 1);
	const exp = Number.parseInt(expStr, 10);
	if (!Number.isFinite(exp) || exp * 1000 < Date.now()) return false;
	if (!/^[0-9a-f]{32}$/.test(sig)) return false;
	const expect = (await hmacHex(secret, `media|${exp}`)).slice(0, 32);
	if (expect.length !== sig.length) return false;
	let diff = 0;
	for (let i = 0; i < expect.length; i++) diff |= expect.charCodeAt(i) ^ sig.charCodeAt(i);
	return diff === 0;
}

/** 从请求头提取门票值 */
export function ticketFromCookie(cookieHeader: string | null): string | undefined {
	if (!cookieHeader) return undefined;
	const m = cookieHeader.match(/(?:^|;\s*)media_tkt=([^;]+)/);
	return m?.[1];
}

/** 种票 Set-Cookie 头（跨子域共享；pages.dev 等预览域退化为 host-only） */
export function ticketSetCookie(value: string, maxAge: number, hostname: string): string {
	const isApexFamily = hostname === "yangshu.cc.cd" || hostname.endsWith(".yangshu.cc.cd");
	const domain = isApexFamily ? "; Domain=.yangshu.cc.cd" : "";
	return `${TICKET_COOKIE}=${value}; Path=/${domain}; Max-Age=${maxAge}; Secure; HttpOnly; SameSite=Lax`;
}

export const MEDIA_TICKET_COOKIE = TICKET_COOKIE;
