<script lang="ts">
import { onMount } from "svelte";
import Switch from "./Switch.svelte";

interface Props {
	username?: string;
	error?: string;
	loading?: boolean;
	onSuccess?: (() => void) | null;
}
let { onSuccess = null }: Props = $props();

let user = $state("");
let pass = $state("");
let remember = $state(true);
let error = $state("");
let loading = $state(false);

// 管理员无初始化入口：账号只能由站长直接写库，故此处不再查询初始化状态
onMount(() => {
	const input = document.querySelector<HTMLInputElement>("#admin-username");
	input?.focus();
});

async function submit(event: SubmitEvent) {
	event.preventDefault();
	loading = true;
	error = "";
	try {
		const resp = await fetch("/api/admin/login/", {
			method: "POST",
			credentials: "include",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username: user, password: pass }),
		});
		const data = await resp.json();
		if (!resp.ok || !data.ok) {
			error = data.message || "登录失败";
			return;
		}
		for (let attempt = 0; attempt < 2; attempt++) {
			try {
				const me = await fetch("/api/admin/me/", { credentials: "include" });
				const meData = await me.json();
				if (meData.authenticated) break;
			} catch {}
			if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
		}
		if (onSuccess) {
			onSuccess();
		} else {
			window.location.href = "/admin/posts/";
		}
	} catch {
		error = "网络错误，请重试";
	} finally {
		loading = false;
	}
}
</script>

<div class="login-screen">
	<div class="login-bg">
		<span class="orb orb-a"></span><span class="orb orb-b"></span><span class="orb orb-c"></span>
		<div class="login-grid"></div>
	</div>
	<div class="login-card">
		<div class="login-brand">
			<img class="brand-logo lg" src="/favicon/firefly-32.png" alt="Firedre" />
			<div>
				<h1 class="login-name">Firedre 后台</h1>
				<p class="login-sub">
					<span class="cap">内容发布</span>
					<span class="cap">站点配置</span>
					<span class="cap">数据看板</span>
				</p>
			</div>
		</div>
		<p class="login-title">欢迎回来 👋</p>
		<p class="login-hint">登录以进入内容管理系统</p>
		{#if error}
			<p class="lg-err">{error}</p>
		{/if}
		<form onsubmit={submit}>
			<label class="lg-field">
				<span>账号</span>
				<input id="admin-username" type="text" autocomplete="username" bind:value={user} />
			</label>
			<label class="lg-field">
				<span>密码</span>
				<input type="password" autocomplete="current-password" bind:value={pass} />
			</label>
			<div class="lg-row">
				<label class="check-line" style="cursor:pointer">
					<Switch on={remember} label="记住我开关" toggle={() => (remember = !remember)} />
					<span class="check-text" style="font-size:.85rem">记住登录</span>
				</label>
				<span class="check-text" style="font-size:.85rem;opacity:.6">忘记密码需直接重置数据库中的密码</span>
			</div>
			<button type="submit" class="btn btn-primary lg-submit" disabled={loading}>
				{loading ? "登录中…" : "登 录"}
			</button>
		</form>
	</div>
</div>
