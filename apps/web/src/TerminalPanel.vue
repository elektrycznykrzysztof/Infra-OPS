<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref, watch } from "vue";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { PlugZap, Unplug } from "lucide-vue-next";
import type { ThemeId } from "./theme";

const props = defineProps<{ theme: ThemeId }>();

const host = ref(""); const username = ref(""); const password = ref("");
const state = ref<"idle" | "connecting" | "connected" | "error">("idle");
const message = ref("Terminal nie jest połączony"); const container = ref<HTMLElement>();
let socket: WebSocket | undefined; let terminal: Terminal | undefined; let fit: FitAddon | undefined; let resizeObserver: ResizeObserver | undefined;
const terminalThemes: Record<ThemeId, { background: string; foreground: string; cursor: string; selectionBackground: string }> = {
  "dark-blue": { background: "#070b13", foreground: "#d8e1ef", cursor: "#44d7b6", selectionBackground: "#245b63" },
  "solarized-white": { background: "#f7f0dd", foreground: "#586e75", cursor: "#268bd2", selectionBackground: "#b8dce0" },
  "solarized-dark": { background: "#00252e", foreground: "#839496", cursor: "#2aa198", selectionBackground: "#15535d" },
  "retro-future": { background: "#090715", foreground: "#f4eaff", cursor: "#ff4fd8", selectionBackground: "#623174" }
};

function ensureTerminal() {
  if (terminal || !container.value) return;
  terminal = new Terminal({ cursorBlink: true, convertEol: true, fontFamily: "'Cascadia Code', Consolas, monospace", fontSize: 14, theme: terminalThemes[props.theme], scrollback: 5000 });
  fit = new FitAddon(); terminal.loadAddon(fit); terminal.open(container.value); fit.fit();
  terminal.onData((data) => socket?.readyState === WebSocket.OPEN && socket.send(JSON.stringify({ type: "input", data })));
  resizeObserver = new ResizeObserver(() => { fit?.fit(); if (terminal && socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: "resize", cols: terminal.cols, rows: terminal.rows })); });
  resizeObserver.observe(container.value);
}

async function connect() {
  await nextTick(); ensureTerminal(); terminal?.clear(); state.value = "connecting"; message.value = "Nawiązywanie połączenia…";
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  socket = new WebSocket(`${protocol}//${location.host}/api/ssh`);
  socket.onopen = () => socket?.send(JSON.stringify({ type: "connect", host: host.value, username: username.value, password: password.value, cols: terminal?.cols || 120, rows: terminal?.rows || 32 }));
  socket.onmessage = (event) => {
    const data = JSON.parse(event.data);
    if (data.type === "data") terminal?.write(data.data);
    if (data.type === "connected") { state.value = "connected"; message.value = `Połączono z ${data.host}`; password.value = ""; terminal?.focus(); }
    if (data.type === "fingerprint") message.value = `Zaufano fingerprintowi SHA-256: ${data.fingerprint}`;
    if (data.type === "error") { state.value = "error"; message.value = data.message; terminal?.writeln(`\r\n\x1b[31m${data.message}\x1b[0m`); }
    if (data.type === "closed" && state.value === "connected") { state.value = "idle"; message.value = "Sesja SSH została zakończona"; }
  };
  socket.onerror = () => { state.value = "error"; message.value = "Nie udało się otworzyć kanału WebSocket"; };
}
function disconnect() { socket?.close(); terminal?.clear(); state.value = "idle"; message.value = "Terminal nie jest połączony"; }
watch(() => props.theme, (theme) => { if (terminal) terminal.options.theme = terminalThemes[theme]; });
onBeforeUnmount(() => { resizeObserver?.disconnect(); socket?.close(); terminal?.dispose(); });
</script>

<template>
  <section class="terminal-layout">
    <aside class="connect-card">
      <div><p class="eyebrow">SSH / PORT 22</p><h2>Nowa sesja</h2><p class="muted">Dane logowania pozostają wyłącznie w pamięci aktywnego połączenia.</p></div>
      <label>Adres IP<input v-model="host" inputmode="decimal" placeholder="192.168.10.24" autocomplete="off" /></label>
      <label>Login<input v-model="username" placeholder="administrator" autocomplete="username" /></label>
      <label>Hasło<input v-model="password" type="password" placeholder="••••••••••••" autocomplete="current-password" @keyup.enter="connect" /></label>
      <button v-if="state !== 'connected'" class="primary" :disabled="state === 'connecting' || !host || !username || !password" @click="connect"><PlugZap :size="17" />{{ state === 'connecting' ? 'Łączenie…' : 'Połącz' }}</button>
      <button v-else class="danger" @click="disconnect"><Unplug :size="17" />Rozłącz</button>
      <div class="security-note"><span class="status-dot" :class="state"></span><span>{{ message }}</span></div>
      <p class="micro">Pierwsze połączenie zapisuje fingerprint hosta (TOFU). Każda kolejna sesja wymaga identycznego klucza.</p>
    </aside>
    <div class="terminal-shell"><div class="terminal-bar"><span>infrastructure@ssh</span><span>{{ state === 'connected' ? host : 'offline' }}</span></div><div ref="container" class="terminal-canvas"></div></div>
  </section>
</template>
