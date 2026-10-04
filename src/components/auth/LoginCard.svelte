<script lang="ts">
import { onMount } from "svelte";
import Iconify, { addCollection } from "@iconify/svelte/offline";
import Turnstile from "./Turnstile.svelte";

// 登录卡片（邮箱 + 密码 + 记住我 + Turnstile + GitHub/Google 一键登录）
// 未验证账号允许登录（设计 D.1）；封禁账号后端 403 拒绝

// 注册登录按钮用到的两个品牌图标（icons-data.json 未收录 fa7-brands，
// 组件内走仓库离线 iconify 体系注册，无运行时网络请求）
addCollection({
	prefix: "fa7-brands",
	width: 640,
	height: 640,
	icons: {
		github: {
			body:
				'<path fill="currentColor" d="M280.5 426.5c-66-8-112.5-55.5-112.5-117c0-25 9-52 24-70c-6.5-16.5-5.5-51.5 2-66c20-2.5 47 8 63 22.5c19-6 39-9 63.5-9s44.5 3 62.5 8.5c15.5-14 43-24.5 63-22c7 13.5 8 48.5 1.5 65.5c16 19 24.5 44.5 24.5 70.5c0 61.5-46.5 108-113.5 116.5c17 11 28.5 35 28.5 62.5v52c0 15 12.5 23.5 27.5 17.5C505 523.5 576 433 576 321c0-141.5-115-257-256.5-257S64 179.5 64 321c0 111 70.5 203 165.5 237.5c13.5 5 26.5-4 26.5-17.5v-40c-7 3-16 5-24 5c-33 0-52.5-18-66.5-51.5c-5.5-13.5-11.5-21.5-23-23c-6-.5-8-3-8-6c0-6 10-10.5 20-10.5c14.5 0 27 9 40 27.5c10 14.5 20.5 21 33 21s20.5-4.5 32-16c8.5-8.5 15-16 21-21"/>',
		},
		google: {
			body:
				'<path fill="currentColor" d="M564 325.8C564 467.3 467.1 568 324 568C186.8 568 76 457.2 76 320S186.8 72 324 72c66.8 0 123 24.5 166.3 64.9l-67.5 64.9c-88.3-85.2-252.5-21.2-252.5 118.2c0 86.5 69.1 156.6 153.7 156.6c98.2 0 135-70.4 140.8-106.9H324v-85.3h236.1c2.3 12.7 3.9 24.9 3.9 41.4"/>',
		},
	},
});

// OAuth 回调失败时后端 302 回 /login/?oauth_error=<code>，文案与 server/auth/oauth.ts 对齐
const OAUTH_ERROR_MESSAGES: Record<string, string> = {
	state: "登录状态已失效或校验未通过，请重新发起登录",
	not_configured: "该第三方登录尚未配置",
	exchange: "第三方登录验证失败，请稍后再试",
	no_email: "第三方账号没有可用的已验证邮箱，无法登录",
	email_unverified: "第三方账号邮箱未通过验证，无法登录",
	banned: "该账号已被封禁",
	server: "服务器错误，请稍后再试",
};

interface Props {
	next?: string;
	turnstileSiteKey?: string;
}

let { next = "", turnstileSiteKey = "" }: Props = $props();

let email = $state("");
let password = $state("");
let remember = $state(true);
let error = $state("");
let loading = $state(false);
let turnstileToken = $state("");
let turnstileRef = $state<Turnstile | null>(null);

/** 第三方登录入口（trailingSlash:"always"，start 后端带 next 站内白名单回跳） */
function providerHref(provider: "github" | "google"): string {
	const n = safeNext(next);
	return `/api/auth/oauth/${provider}/start/${n ? `?next=${encodeURIComponent(n)}` : ""}`;
}

onMount(async () => {
	// OAuth 回跳错误码 → 文案展示，随后清理地址栏参数（防刷新重复提示）
	try {
		const params = new URLSearchParams(window.location.search);
		const oauthError = params.get("oauth_error");
		if (oauthError) {
			error = OAUTH_ERROR_MESSAGES[oauthError] || "第三方登录失败，请重试";
			params.delete("oauth_error");
			const qs = params.toString();
			history.replaceState(
				null,
				"",
				window.location.pathname + (qs ? `?${qs}` : ""),
			);
		}
	} catch {
		// 读取失败不阻断登录表单
	}

	// 已登录则直接落地（避免重复登录页）
	try {
		const resp = await fetch("/api/auth/me/", { credentials: "include" });
		const data = await resp.json();
		if (data?.authenticated) {
			window.location.href = safeNext(next) || "/profile/";
			return;
		}
	} catch {
		// 自查失败不阻断登录表单
	}
	document.querySelector<HTMLInputElement>("#auth-email")?.focus();
});

/** 站内跳转校验（防 open redirect） */
function safeNext(v: string): string {
	if (!v) return "";
	if (!v.startsWith("/") || v.startsWith("//")) return "";
	return v;
}

async function submit(event: SubmitEvent) {
	event.preventDefault();
	if (loading) return;
	error = "";
	loading = true;
	try {
		const resp = await fetch("/api/auth/login/", {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: email.trim(),
				password,
				remember,
				turnstileToken,
			}),
		});
		const data = await resp.json().catch(() => ({}));
		if (!resp.ok || !data.ok) {
			error = data.message || "登录失败，请稍后再试";
			turnstileRef?.reset();
			turnstileToken = "";
			return;
		}
		window.location.href = safeNext(next) || "/profile/";
	} catch {
		error = "网络错误，请重试";
	} finally {
		loading = false;
	}
}
</script>

<div class="card-base w-full max-w-md mx-auto px-7 py-8 rounded-(--radius-large) relative overflow-hidden">
	<div class="text-center mb-6">
		<div class="inline-flex items-center justify-center w-14 h-14 rounded-full bg-(--primary)/10 mb-4">
			<svg class="w-7 h-7 text-(--primary)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
					d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
			</svg>
		</div>
		<h2 class="text-xl font-bold text-90">欢迎回来 👋</h2>
		<p class="text-sm text-50 mt-1">登录以参与评论与互动</p>
	</div>

	{#if error}
		<p class="mb-4 rounded-lg bg-red-500/10 border border-red-500/30 px-4 py-2.5 text-sm text-red-600 dark:text-red-400">
			{error}
		</p>
	{/if}

	<form onsubmit={submit} class="space-y-4">
		<label class="block">
			<span class="block text-sm text-75 mb-1.5">邮箱</span>
			<input
				id="auth-email"
				type="email"
				autocomplete="email"
				required
				bind:value={email}
				class="w-full px-4 py-3 text-[15px] bg-transparent border border-black/10 dark:border-white/10 rounded-lg outline-none transition-colors focus:ring-2 focus:ring-(--primary) focus:border-(--primary) placeholder:opacity-50"
				placeholder="you@example.com"
			/>
		</label>
		<label class="block">
			<span class="block text-sm text-75 mb-1.5">密码</span>
			<input
				type="password"
				autocomplete="current-password"
				required
				bind:value={password}
				class="w-full px-4 py-3 text-[15px] bg-transparent border border-black/10 dark:border-white/10 rounded-lg outline-none transition-colors focus:ring-2 focus:ring-(--primary) focus:border-(--primary) placeholder:opacity-50"
				placeholder="请输入密码"
			/>
		</label>

		<div class="flex items-center justify-between text-sm">
			<label class="flex items-center gap-2 cursor-pointer text-75">
				<input type="checkbox" bind:checked={remember} class="accent-(--primary) w-4 h-4" />
				<span>记住我（30 天）</span>
			</label>
		</div>

		<Turnstile
			bind:this={turnstileRef}
			bind:token={turnstileToken}
			siteKey={turnstileSiteKey}
			action="login"
		/>

		<button
			type="submit"
			disabled={loading}
			class="w-full rounded-xl bg-(--primary) px-6 py-3 text-sm font-semibold text-white transition-all hover:bg-(--primary)/90 hover:shadow-lg active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
		>
			{loading ? "登录中…" : "登 录"}
		</button>
	</form>

	<div class="mt-6">
		<div class="flex items-center gap-3 mb-4">
			<span class="flex-1 h-px bg-black/10 dark:bg-white/10"></span>
			<span class="text-xs text-50">或使用以下方式登录</span>
			<span class="flex-1 h-px bg-black/10 dark:bg-white/10"></span>
		</div>
		<div class="space-y-3">
			<a
				href={providerHref("github")}
				class="flex w-full items-center justify-center gap-2.5 rounded-xl border border-(--line-divider) bg-(--card-bg) px-6 py-2.5 text-sm font-medium text-75 transition-colors hover:border-(--primary)/40 hover:text-(--primary)"
			>
				<Iconify icon="fa7-brands:github" class="text-lg" />
				<span>使用 GitHub 登录</span>
			</a>
			<a
				href={providerHref("google")}
				class="flex w-full items-center justify-center gap-2.5 rounded-xl border border-(--line-divider) bg-(--card-bg) px-6 py-2.5 text-sm font-medium text-75 transition-colors hover:border-(--primary)/40 hover:text-(--primary)"
			>
				<Iconify icon="fa7-brands:google" class="text-lg" />
				<span>使用 Google 登录</span>
			</a>
		</div>
	</div>

	<p class="text-center text-sm text-50 mt-6">
		还没有账号？
		<a href="/register/" class="text-(--primary) font-medium hover:underline">立即注册</a>
	</p>
	<p class="text-center text-xs text-50 mt-2 opacity-80">
		忘记密码？请联系站长重置
	</p>
</div>
