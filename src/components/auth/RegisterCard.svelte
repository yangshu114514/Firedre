<script lang="ts">
import { onMount } from "svelte";
import Iconify, { addCollection } from "@iconify/svelte/offline";
import Turnstile from "./Turnstile.svelte";

// 注册卡片（邮箱 + 昵称 + 密码 + Turnstile + 验证提示 + GitHub/Google 一键登录）
// 防枚举：后端对邮箱是否已存在返回一致响应，前端只呈现统一的「查收邮件」成功态（设计 D.1）

// 注册按钮用到的两个品牌图标（icons-data.json 未收录 fa7-brands，
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

interface Props {
	turnstileSiteKey?: string;
}

let { turnstileSiteKey = "" }: Props = $props();

let email = $state("");
let name = $state("");
let password = $state("");
let confirm = $state("");
let error = $state("");
let loading = $state(false);
let turnstileToken = $state("");
let turnstileRef = $state<Turnstile | null>(null);

// 成功态：提示查收邮件 + 重发
let done = $state(false);
let resendLoading = $state(false);
let resendMsg = $state("");

onMount(async () => {
	try {
		const resp = await fetch("/api/auth/me/", { credentials: "include" });
		const data = await resp.json();
		if (data?.authenticated) window.location.href = "/profile/";
	} catch {
		// 自查失败不阻断表单
	}
});

async function submit(event: SubmitEvent) {
	event.preventDefault();
	error = "";

	if (password !== confirm) {
		error = "两次输入的密码不一致";
		return;
	}

	loading = true;
	try {
		const resp = await fetch("/api/auth/register/", {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				email: email.trim(),
				name: name.trim(),
				password,
				turnstileToken,
			}),
		});
		const data = await resp.json().catch(() => ({}));
		if (!resp.ok || !data.ok) {
			error = data.message || "注册失败，请稍后再试";
			turnstileRef?.reset();
			turnstileToken = "";
			return;
		}
		done = true;
	} catch {
		error = "网络错误，请重试";
	} finally {
		loading = false;
	}
}

async function resend() {
	if (resendLoading) return;
	resendMsg = "";
	resendLoading = true;
	try {
		const resp = await fetch("/api/auth/resend/", {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: email.trim() }),
		});
		const data = await resp.json().catch(() => ({}));
		resendMsg =
			data.message ||
			(resp.ok ? "验证邮件已发送，请查收。" : "发送失败，请稍后再试");
	} catch {
		resendMsg = "网络错误，请重试";
	} finally {
		resendLoading = false;
	}
}
</script>

<div class="card-base w-full max-w-md mx-auto px-7 py-8 rounded-(--radius-large) relative overflow-hidden">
	{#if done}
		<div class="text-center py-4">
			<div class="inline-flex items-center justify-center w-14 h-14 rounded-full bg-green-500/10 mb-4">
				<svg class="w-7 h-7 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
				</svg>
			</div>
			<h2 class="text-xl font-bold text-90">请查收验证邮件</h2>
			<p class="text-sm text-50 mt-2 leading-relaxed">
				我们已向 <span class="text-75 font-medium">{email}</span> 发送了验证链接，<br />
				点击邮件中的按钮完成验证后即可登录（24 小时内有效）。
			</p>

			{#if resendMsg}
				<p class="mt-4 rounded-lg bg-(--primary)/10 border border-(--primary)/30 px-4 py-2.5 text-sm text-75">
					{resendMsg}
				</p>
			{/if}

			<div class="mt-6 space-y-3">
				<button
					type="button"
					onclick={resend}
					disabled={resendLoading}
					class="w-full rounded-xl border border-(--line-divider) bg-(--card-bg) px-6 py-2.5 text-sm font-medium text-75 transition-colors hover:border-(--primary)/40 hover:text-(--primary) disabled:opacity-60"
				>
					{resendLoading ? "发送中…" : "没收到邮件？重新发送"}
				</button>
				<a
					href="/login/"
					class="block w-full rounded-xl bg-(--primary) px-6 py-2.5 text-sm font-semibold text-white text-center transition-all hover:bg-(--primary)/90"
				>
					去登录
				</a>
			</div>
		</div>
	{:else}
		<div class="text-center mb-6">
			<div class="inline-flex items-center justify-center w-14 h-14 rounded-full bg-(--primary)/10 mb-4">
				<svg class="w-7 h-7 text-(--primary)" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
						d="M18 9v3m0 0v3m0-3h3m-3 0h-3m-2-5a4 4 0 11-8 0 4 4 0 018 0zM3 20a6 6 0 0112 0v1H3v-1z" />
				</svg>
			</div>
			<h2 class="text-xl font-bold text-90">创建账号</h2>
			<p class="text-sm text-50 mt-1">注册后需验证邮箱，即可参与评论与互动</p>
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
					type="email"
					autocomplete="email"
					required
					bind:value={email}
					class="w-full px-4 py-3 text-[15px] bg-transparent border border-black/10 dark:border-white/10 rounded-lg outline-none transition-colors focus:ring-2 focus:ring-(--primary) focus:border-(--primary) placeholder:opacity-50"
					placeholder="you@example.com"
				/>
			</label>
			<label class="block">
				<span class="block text-sm text-75 mb-1.5">昵称</span>
				<input
					type="text"
					autocomplete="nickname"
					required
					maxlength="30"
					bind:value={name}
					class="w-full px-4 py-3 text-[15px] bg-transparent border border-black/10 dark:border-white/10 rounded-lg outline-none transition-colors focus:ring-2 focus:ring-(--primary) focus:border-(--primary) placeholder:opacity-50"
					placeholder="评论时展示的名字"
				/>
			</label>
			<label class="block">
				<span class="block text-sm text-75 mb-1.5">密码</span>
				<input
					type="password"
					autocomplete="new-password"
					required
					minlength="8"
					bind:value={password}
					class="w-full px-4 py-3 text-[15px] bg-transparent border border-black/10 dark:border-white/10 rounded-lg outline-none transition-colors focus:ring-2 focus:ring-(--primary) focus:border-(--primary) placeholder:opacity-50"
					placeholder="至少 8 位"
				/>
			</label>
			<label class="block">
				<span class="block text-sm text-75 mb-1.5">确认密码</span>
				<input
					type="password"
					autocomplete="new-password"
					required
					bind:value={confirm}
					class="w-full px-4 py-3 text-[15px] bg-transparent border border-black/10 dark:border-white/10 rounded-lg outline-none transition-colors focus:ring-2 focus:ring-(--primary) focus:border-(--primary) placeholder:opacity-50"
					placeholder="再次输入密码"
				/>
			</label>

			<Turnstile
				bind:this={turnstileRef}
				bind:token={turnstileToken}
				siteKey={turnstileSiteKey}
				action="signup"
			/>

			<button
				type="submit"
				disabled={loading}
				class="w-full rounded-xl bg-(--primary) px-6 py-3 text-sm font-semibold text-white transition-all hover:bg-(--primary)/90 hover:shadow-lg active:scale-[0.98] disabled:opacity-60 disabled:cursor-not-allowed"
			>
				{loading ? "提交中…" : "注 册"}
			</button>
		</form>

		<div class="mt-6">
			<div class="flex items-center gap-3 mb-4">
				<span class="flex-1 h-px bg-black/10 dark:bg-white/10"></span>
				<span class="text-xs text-50">或使用以下方式注册/登录</span>
				<span class="flex-1 h-px bg-black/10 dark:bg-white/10"></span>
			</div>
			<div class="space-y-3">
				<a
					href="/api/auth/oauth/github/start/"
					class="flex w-full items-center justify-center gap-2.5 rounded-xl border border-(--line-divider) bg-(--card-bg) px-6 py-2.5 text-sm font-medium text-75 transition-colors hover:border-(--primary)/40 hover:text-(--primary)"
				>
					<Iconify icon="fa7-brands:github" class="text-lg" />
					<span>使用 GitHub 登录</span>
				</a>
				<a
					href="/api/auth/oauth/google/start/"
					class="flex w-full items-center justify-center gap-2.5 rounded-xl border border-(--line-divider) bg-(--card-bg) px-6 py-2.5 text-sm font-medium text-75 transition-colors hover:border-(--primary)/40 hover:text-(--primary)"
				>
					<Iconify icon="fa7-brands:google" class="text-lg" />
					<span>使用 Google 登录</span>
				</a>
			</div>
		</div>

		<p class="text-center text-sm text-50 mt-6">
			已有账号？
			<a href="/login/" class="text-(--primary) font-medium hover:underline">直接登录</a>
		</p>
	{/if}
</div>
