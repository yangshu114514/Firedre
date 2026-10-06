// Brevo HTTP API 邮件封装（设计 DESIGN-USER-SYSTEM.md E 节）
// Workers 无 TCP → SMTP 不可行，统一走 https://api.brevo.com/v3/smtp/email
// 约定：发信失败不阻塞主流程（注册成败以落库为准，失败走重发按钮）

export interface MailEnv {
	BREVO_API_KEY?: string;
	MAIL_FROM?: string; // "admin@yangshu.cc" 或 "杨树 <admin@yangshu.cc>"
	ENVIRONMENT?: string; // 仅当显式设为非 'prod' 才跳过真发；缺省按生产处理，防止线上静默不发信
	DB?: D1Database; // 可选：写入 mail_log 便于排查，失败不影响发信
}

export interface SendMailInput {
	to: string;
	subject: string;
	html: string;
}

export interface SendMailResult {
	ok: boolean;
	skipped?: boolean; // dev 环境未真发
	error?: string;
}

const BREVO_ENDPOINT = "https://api.brevo.com/v3/smtp/email";
const DEFAULT_SENDER_NAME = "杨树的博客";

/** 解析 MAIL_FROM："杨树 <a@b.c>" → {name,email}；纯邮箱 → {name:默认,email} */
export function parseMailFrom(mailFrom: string | undefined): {
	name: string;
	email: string;
} {
	const raw = (mailFrom || "").trim();
	const m = raw.match(/^(.*?)<\s*([^<>]+?)\s*>$/);
	if (m) {
		const name = (m[1] || "").trim().replace(/^"|"$/g, "");
		return { name: name || DEFAULT_SENDER_NAME, email: m[2] };
	}
	return { name: DEFAULT_SENDER_NAME, email: raw };
}

async function postOnce(
	apiKey: string,
	body: string,
): Promise<{ ok: boolean; status: number; text: string }> {
	try {
		const r = await fetch(BREVO_ENDPOINT, {
			method: "POST",
			headers: {
				// Brevo 认证头必须是 "api-key"（写成 apikey 会被判为缺少认证头 → 401）
				"api-key": apiKey,
				"Content-Type": "application/json",
			},
			body,
		});
		const text = await r.text().catch(() => "");
		return { ok: r.ok, status: r.status, text };
	} catch (e) {
		return { ok: false, status: 0, text: (e as Error)?.message || "fetch failed" };
	}
}

/** 发信结果落库（尽力而为，绝不抛出） */
async function logMail(
	db: D1Database | undefined,
	to: string,
	subject: string,
	status: string,
	detail = "",
): Promise<void> {
	if (!db) return;
	try {
		await db
			.prepare(
				"INSERT INTO mail_log (id, to_email, subject, status, detail) VALUES (?, ?, ?, ?, ?)",
			)
			.bind(
				crypto.randomUUID(),
				to,
				subject.slice(0, 200),
				status,
				detail.slice(0, 500),
			)
			.run();
	} catch (e) {
		console.error("[mail] mail_log 写入失败:", e);
	}
}

/**
 * 发送邮件。仅当 ENVIRONMENT 显式设为非 'prod' 时跳过真发（缺省按生产处理）。
 * 失败重试 1 次；仍失败记日志并返回 {ok:false}（绝不抛出），结果写入 mail_log。
 */
export async function sendMail(
	env: MailEnv,
	input: SendMailInput,
): Promise<SendMailResult> {
	const db = env.DB;
	const envTag = env.ENVIRONMENT?.trim();

	// 非生产环境：打印内容便于本地联调（含验证链接，dev 注册后可直接取用）
	if (envTag && envTag !== "prod") {
		console.log(
			"[mail:dev skip]",
			input.to,
			"|",
			input.subject,
			"|",
			stripHtmlForLog(input.html),
		);
		await logMail(db, input.to, input.subject, "skipped_dev", `ENVIRONMENT=${envTag}`);
		return { ok: true, skipped: true };
	}

	const apiKey = env.BREVO_API_KEY?.trim();
	if (!apiKey) {
		console.error("[mail] BREVO_API_KEY 未配置，邮件未发送:", input.to);
		await logMail(db, input.to, input.subject, "no_api_key");
		return { ok: false, error: "BREVO_API_KEY missing" };
	}

	const sender = parseMailFrom(env.MAIL_FROM);
	if (!sender.email) {
		console.error("[mail] MAIL_FROM 未配置，邮件未发送:", input.to);
		await logMail(db, input.to, input.subject, "no_sender");
		return { ok: false, error: "MAIL_FROM missing" };
	}

	const payload = JSON.stringify({
		sender: { name: sender.name, email: sender.email },
		to: [{ email: input.to }],
		subject: input.subject,
		htmlContent: input.html,
	});

	let lastError = "";
	for (let attempt = 0; attempt < 2; attempt++) {
		const res = await postOnce(apiKey, payload);
		if (res.ok) {
			await logMail(db, input.to, input.subject, "sent", `sender=${sender.email}`);
			return { ok: true };
		}

		lastError = `HTTP ${res.status}: ${res.text.slice(0, 300)}`;
		console.error(`[mail] 发送失败（第 ${attempt + 1} 次）:`, lastError);
		if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
	}

	// 失败不抛出：调用方以落库为准，邮件可走重发
	await logMail(db, input.to, input.subject, "failed", lastError);
	return { ok: false, error: lastError };
}

/** dev 日志里只留可见文本 + 链接，避免整段 HTML 刷屏 */
function stripHtmlForLog(html: string): string {
	const links = [...html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((m) => m[0]);
	const text = html
		.replace(/<style[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim()
		.slice(0, 400);
	return links.length ? `${text} | links: ${links.join(" ")}` : text;
}

// ---------- 邮件模板 ----------

/** 注册验证邮件（按钮 + 裸链接 + 24h 说明） */
export function renderVerifyEmail(opts: {
	siteName: string;
	verifyUrl: string;
	expireHours?: number;
}): string {
	const hours = opts.expireHours ?? 24;
	return `<!doctype html>
<html lang="zh-CN">
<body style="margin:0;padding:0;background:#f5f5f4;font-family:-apple-system,'Segoe UI','Microsoft YaHei',sans-serif;">
  <div style="max-width:560px;margin:0 auto;padding:32px 16px;">
    <div style="background:#ffffff;border-radius:16px;padding:32px 28px;border:1px solid #e7e5e4;">
      <p style="font-size:13px;color:#78716c;margin:0 0 8px;">${escapeHtml(opts.siteName)}</p>
      <h1 style="font-size:20px;color:#1c1917;margin:0 0 12px;">验证你的邮箱</h1>
      <p style="font-size:14px;color:#44403c;line-height:1.7;margin:0 0 24px;">
        感谢注册！请点击下面的按钮完成邮箱验证，验证后即可登录并参与评论。
      </p>
      <div style="text-align:center;margin:0 0 24px;">
        <a href="${opts.verifyUrl}" style="display:inline-block;background:#f97316;color:#ffffff;text-decoration:none;font-size:15px;font-weight:600;padding:12px 32px;border-radius:999px;">
          验证邮箱
        </a>
      </div>
      <p style="font-size:13px;color:#78716c;line-height:1.7;margin:0 0 6px;">
        验证链接 ${hours} 小时内有效，仅可使用一次。
      </p>
      <p style="font-size:12px;color:#a8a29e;line-height:1.6;margin:16px 0 0;word-break:break-all;">
        如果按钮无法点击，请复制以下链接到浏览器打开：<br/>
        <a href="${opts.verifyUrl}" style="color:#f97316;">${opts.verifyUrl}</a>
      </p>
    </div>
    <p style="text-align:center;font-size:12px;color:#a8a29e;margin:16px 0 0;">
      这是一封系统邮件，请勿直接回复。
    </p>
  </div>
</body>
</html>`;
}

export function escapeHtml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}
