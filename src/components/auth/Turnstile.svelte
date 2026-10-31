<script lang="ts">
import { onMount } from "svelte";

// Cloudflare Turnstile widget（设计 D.4）：
// - siteKey 由构建期变量 VITE_TURNSTILE_SITE_KEY 提供；未配置则不渲染（本地 dev 后端也跳过校验）
// - token 通过 bind:token 回填给父表单；过期/出错自动清空并通知父组件

interface Props {
	siteKey?: string;
	token?: string;
	action?: string;
	theme?: "auto" | "light" | "dark";
}

let { siteKey = "", token = $bindable(""), action = "login", theme = "auto" }: Props =
	$props();

let container: HTMLDivElement | undefined = $state();
let widgetId = $state<string | number | null>(null);
let renderFailed = $state(false);
// 加载失败自动重试：国内到 challenges.cloudflare.com 的连接重置是间歇性的，
// 单次失败不代表后续也失败（实测时好时坏），故指数退避重试多次。
const TS_MAX_RETRIES = 5;
const TS_RETRY_BASE_MS = 2000;
let retryingCount = $state(0);

const API_SRC =
	"https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";

function loadTurnstileScriptOnce(): Promise<void> {
	const w = window as unknown as { turnstile?: unknown };
	if (w.turnstile) return Promise.resolve();
	return new Promise((resolve, reject) => {
		const existing = document.querySelector<HTMLScriptElement>(
			'script[src^="https://challenges.cloudflare.com/turnstile"]',
		);
		if (existing) {
			existing.addEventListener("load", () => resolve(), { once: true });
			existing.addEventListener("error", () => reject(new Error("load fail")), {
				once: true,
			});
			return;
		}
		const s = document.createElement("script");
		s.src = API_SRC;
		s.async = true;
		s.onload = () => resolve();
		s.onerror = () => {
			// 失败的 script 标签要从 DOM 移除，否则下次重试会命中 existing 直接挂死
			s.remove();
			reject(new Error("load fail"));
		};
		document.head.appendChild(s);
	});
}

async function loadTurnstileScript(): Promise<void> {
	for (let attempt = 0; attempt <= TS_MAX_RETRIES; attempt++) {
		if (attempt > 0) {
			retryingCount = attempt;
			await new Promise((r) => setTimeout(r, TS_RETRY_BASE_MS * attempt));
		}
		try {
			await loadTurnstileScriptOnce();
			retryingCount = 0;
			return;
		} catch {
			// 继续重试
		}
	}
	retryingCount = 0;
	throw new Error("load fail after retries");
}

onMount(() => {
	if (!siteKey || !container) return;

	let disposed = false;
	loadTurnstileScript()
		.then(() => {
			if (disposed || !container) return;
			const w = window as unknown as {
				turnstile?: {
					render: (
						el: HTMLElement,
						opts: Record<string, unknown>,
					) => string | number;
					reset: (id?: string | number) => void;
				};
			};
			if (!w.turnstile) {
				renderFailed = true;
				return;
			}
			widgetId = w.turnstile.render(container, {
				sitekey: siteKey,
				action,
				theme,
				// 防泄漏：失败/过期不自动重试。此前 auto_timeout 会无限循环新建
				// challenge iframe 并重复请求，挂机时内存只涨不落。
				retry: "never",
				"refresh-expired": "never",
				callback: (t: string) => {
					token = t;
				},
				"expired-callback": () => {
					token = "";
				},
				"error-callback": () => {
					token = "";
				},
			});
		})
		.catch(() => {
			// 脚本加载失败：清空 token，父组件提交会被后端拒绝
			renderFailed = true;
			token = "";
		});

	return () => {
		disposed = true;
	};
});

/** 供父组件在提交失败/换动作后重置 widget */
export function reset() {
	const w = window as unknown as {
		turnstile?: { reset: (id?: string | number) => void };
	};
	token = "";
	if (widgetId !== null && w.turnstile) {
		try {
			w.turnstile.reset(widgetId);
		} catch {
			// widget 已销毁则忽略
		}
	}
}
</script>

{#if siteKey}
	<div class="my-3">
		<div bind:this={container} class="tw-container"></div>
		{#if retryingCount > 0}
			<p class="text-xs text-neutral-500 mt-1">
				人机验证组件加载中（重试 {retryingCount}/{TS_MAX_RETRIES}）…
			</p>
		{:else if renderFailed}
			<p class="text-xs text-red-500 mt-1">
				人机验证组件加载失败，请检查网络后刷新页面
			</p>
		{/if}
	</div>
{/if}

<style>
	.tw-container {
		min-height: 65px;
		display: flex;
		justify-content: center;
	}
</style>
