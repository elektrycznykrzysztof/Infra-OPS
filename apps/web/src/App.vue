<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { Activity, Box, ChevronDown, Database, HardDrive, Palette, Power, RefreshCw, Search, Server, ShieldCheck, TerminalSquare, TriangleAlert, Wifi, WifiOff, X } from "lucide-vue-next";
import TerminalPanel from "./TerminalPanel.vue";
import StorageGrowthChart from "./StorageGrowthChart.vue";
import { readThemePreference, themeOptions, themeStorageKey, type ThemeId } from "./theme";

type Tab = "veeam" | "vmware" | "sophos" | "netapp" | "terminal";
const tabs = [
  { id: "veeam" as Tab, label: "Veeam", icon: Database }, { id: "vmware" as Tab, label: "VMware", icon: Box },
  { id: "sophos" as Tab, label: "Sophos", icon: ShieldCheck }, { id: "netapp" as Tab, label: "NetApp", icon: HardDrive },
  { id: "terminal" as Tab, label: "Terminal", icon: TerminalSquare }
];
const active = ref<Tab>("veeam"); const status = ref<any>(); const loading = ref(false); const error = ref(""); const query = ref("");
const theme = ref<ThemeId>(readThemePreference());
const sessions = ref<any[]>([]); const storage = ref<any>({ entries: [] }); const growth = ref<any>({ points: [] }); const vcenter = ref<any[]>([]); const vpns = ref<any[]>([]); const clusters = ref<any[]>([]);
const lastRefresh = ref<Date>();
const expandedStorage = ref<Set<string>>(new Set());
const storageQuery = ref("");
const expandedHosts = ref<Set<string>>(new Set());
const expandedVpns = ref<Set<string>>(new Set());
const sessionFilters = ref({ job: "", status: "", type: "", startedFrom: "", startedTo: "", endedFrom: "", endedTo: "" });
watch(theme, (value) => {
  document.documentElement.dataset.theme = value;
  try { window.localStorage.setItem(themeStorageKey, value); } catch {}
});

async function api<T>(url: string, init?: RequestInit): Promise<T> {
  const endpoint = new URL(url, window.location.origin);
  const response = await fetch(endpoint, { ...init, headers: { "content-type": "application/json", ...(init?.headers || {}) } });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data;
}
async function refresh() {
  if (active.value === "terminal") return; loading.value = true; error.value = "";
  try {
    if (active.value === "veeam") [sessions.value, storage.value, growth.value] = await Promise.all([api<any[]>("/api/veeam/sessions"), api<any>("/api/veeam-one/storage-usage"), api<any>("/api/veeam-one/storage-usage/growth")]);
    if (active.value === "vmware") vcenter.value = await api<any[]>("/api/vcenter/tree");
    if (active.value === "sophos") vpns.value = await api<any[]>("/api/sophos/vpn");
    if (active.value === "netapp") clusters.value = await api<any[]>("/api/netapp/inventory");
    lastRefresh.value = new Date();
  } catch (e) { error.value = (e as Error).message; } finally { loading.value = false; }
}
async function changeVm(vm: any, action: string) {
  if (!confirm(`${action === 'stop' ? 'Wyłączyć' : action === 'restart' ? 'Uruchomić ponownie' : 'Uruchomić'} maszynę ${vm.name}?`)) return;
  await api(`/api/vcenter/vms/${encodeURIComponent(vm.vm)}/power`, { method: "POST", body: JSON.stringify({ action }) }); await refresh();
}
async function changeVpn(vpn: any) {
  if (typeof vpn.active !== "boolean") return;
  if (!confirm(`${vpn.active ? 'Wyłączyć' : 'Włączyć'} tunel ${vpn.name}?`)) return;
  await api(`/api/sophos/vpn/${encodeURIComponent(vpn.name)}/activation`, { method: "POST", body: JSON.stringify({ active: !vpn.active }) }); await refresh();
}
async function capture() { loading.value = true; try { await api("/api/veeam-one/storage-usage/capture", { method: "POST", body: "{}" }); await refresh(); } catch (e) { error.value = (e as Error).message; loading.value = false; } }
function selectTab(tab: Tab) { active.value = tab; query.value = ""; refresh(); }
function toggleStorage(vmId: string) {
  const next = new Set(expandedStorage.value);
  next.has(vmId) ? next.delete(vmId) : next.add(vmId);
  expandedStorage.value = next;
}
function toggleHost(hostId: string) {
  const next = new Set(expandedHosts.value);
  next.has(hostId) ? next.delete(hostId) : next.add(hostId);
  expandedHosts.value = next;
}
function toggleVpnDetails(name: string) {
  const next = new Set(expandedVpns.value);
  next.has(name) ? next.delete(name) : next.add(name);
  expandedVpns.value = next;
}
const hostGroups = computed(() => {
  const hosts = new Map<string, any>();
  for (const rawHost of vcenter.value) {
    const hostId = String(rawHost.host || rawHost.name);
    const existing = hosts.get(hostId) || { ...rawHost, host: hostId, vms: [] };
    const uniqueVms = new Map((existing.vms || []).map((vm: any) => [vm.vm, vm]));
    for (const vm of rawHost.vms || []) uniqueVms.set(vm.vm, vm);
    existing.vms = [...uniqueVms.values()].sort((a: any, b: any) => String(a.name).localeCompare(String(b.name), "pl"));
    hosts.set(hostId, existing);
  }
  return [...hosts.values()].sort((a: any, b: any) => String(a.name).localeCompare(String(b.name), "pl"));
});
const visibleHosts = computed(() => {
  const term = query.value.trim().toLowerCase();
  if (!term) return hostGroups.value;
  return hostGroups.value.map((host: any) => {
    const hostMatches = `${host.name} ${host.clusterName || ""} ${host.connection_state || ""}`.toLowerCase().includes(term);
    const vms = hostMatches ? host.vms : host.vms.filter((vm: any) => `${vm.name} ${vm.power_state || ""}`.toLowerCase().includes(term));
    return { ...host, vms };
  }).filter((host: any) => host.vms.length || `${host.name} ${host.clusterName || ""}`.toLowerCase().includes(term));
});
const visibleVmCount = computed(() => visibleHosts.value.reduce((sum: number, host: any) => sum + host.vms.length, 0));
const visibleStorageEntries = computed(() => {
  const term = storageQuery.value.trim().normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pl-PL");
  return (storage.value.entries || []).filter((vm: any) =>
    String(vm.vmName || "").normalize("NFD").replace(/\p{Diacritic}/gu, "").toLocaleLowerCase("pl-PL").includes(term)
  );
});
const sessionTypes = computed(() => [...new Set(sessions.value.map((session) => session.type).filter(Boolean))].sort());
const matchesDateRange = (value: string | null, from: string, to: string) => {
  if (!from && !to) return true;
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  if (from && timestamp < new Date(`${from}T00:00:00`).getTime()) return false;
  if (to && timestamp > new Date(`${to}T23:59:59.999`).getTime()) return false;
  return true;
};
const filteredSessions = computed(() => {
  const filters = sessionFilters.value;
  const job = filters.job.trim().toLowerCase();
  return sessions.value.filter((session) =>
    (!job || String(session.name || "").toLowerCase().includes(job)) &&
    (!filters.status || session.status === filters.status) &&
    (!filters.type || session.type === filters.type) &&
    matchesDateRange(session.startedAt, filters.startedFrom, filters.startedTo) &&
    matchesDateRange(session.endedAt, filters.endedFrom, filters.endedTo)
  );
});
const filtersActive = computed(() => Object.values(sessionFilters.value).some(Boolean));
function clearSessionFilters() {
  sessionFilters.value = { job: "", status: "", type: "", startedFrom: "", startedTo: "", endedFrom: "", endedTo: "" };
}
const configured = computed(() => status.value?.integrations?.[active.value === "vmware" ? "vmware" : active.value]);
const fmtBytes = (value: number) => value ? new Intl.NumberFormat("pl-PL", { style: "unit", unit: value >= 1e12 ? "terabyte" : "gigabyte", maximumFractionDigits: 1 }).format(value / (value >= 1e12 ? 1e12 : 1e9)) : "0 GB";
const fmtDate = (value: string) => value ? new Intl.DateTimeFormat("pl-PL", { dateStyle: "short", timeStyle: "short" }).format(new Date(value)) : "—";
const statusClass = (value: string) => /success|powered_on|ok|connected/i.test(value) ? "good" : /fail|error|stopped|powered_off|disconnected/i.test(value) ? "bad" : "warn";
const usagePercent = (used: number | null, capacity: number) => capacity > 0 && used !== null ? Math.min(100, Math.max(0, used / capacity * 100)) : 0;
const sessionCount = (status: "Success" | "Warning" | "Failed") => sessions.value.filter((session) => session.status === status).length;
onMounted(async () => { try { status.value = await api("/api/status"); } catch {} await refresh(); });
</script>

<template>
  <div class="app-shell">
    <header class="topbar">
      <div class="brand"><div class="brand-mark"><Server :size="21" /></div><div><strong>INFRA<span>OPS</span></strong><small>Infrastructure Control Plane</small></div></div>
      <div class="system-state"><span class="pulse"></span><span>API online</span><span class="divider"></span><span>{{ lastRefresh ? `Aktualizacja ${lastRefresh.toLocaleTimeString('pl-PL', { hour: '2-digit', minute: '2-digit' })}` : 'Ładowanie danych' }}</span><label class="theme-picker"><Palette :size="16" /><select v-model="theme" aria-label="Kolorystyka panelu"><option v-for="option in themeOptions" :key="option.id" :value="option.id">{{ option.label }}</option></select></label></div>
    </header>
    <nav class="tabs" aria-label="Systemy infrastruktury">
      <button v-for="tab in tabs" :key="tab.id" :class="{ active: active === tab.id }" @click="selectTab(tab.id)"><component :is="tab.icon" :size="18" /><span>{{ tab.label }}</span><i v-if="status" :class="status.integrations[tab.id === 'vmware' ? 'vmware' : tab.id] ? 'on' : 'off'"></i></button>
    </nav>
    <main>
      <div v-if="active !== 'terminal'" class="page-head">
        <div><p class="eyebrow">{{ active.toUpperCase() }} / CONTROL</p><h1>{{ tabs.find(t => t.id === active)?.label }}</h1><p>{{ active === 'veeam' ? 'Sesje backupu i wykorzystanie przestrzeni maszyn wirtualnych.' : active === 'vmware' ? 'Inwentarz vCenter i operacje zasilania maszyn.' : active === 'sophos' ? 'Stan i aktywacja tuneli IPsec.' : 'Przestrzeń klastrów ONTAP, wolumeny i SVM.' }}</p></div>
        <button class="secondary" :disabled="loading" @click="refresh"><RefreshCw :size="16" :class="{ spin: loading }" />Odśwież</button>
      </div>
      <div v-if="active !== 'terminal' && status && !configured" class="notice"><TriangleAlert :size="19" /><div><strong>Integracja nie jest skonfigurowana</strong><span>Uzupełnij odpowiednie zmienne w pliku .env i uruchom ponownie kontener API.</span></div></div>
      <div v-if="error" class="notice error"><WifiOff :size="19" /><div><strong>Nie udało się pobrać danych</strong><span>{{ error }}</span></div></div>

      <template v-if="active === 'veeam'">
        <section class="metric-grid">
          <article class="metric"><span>Sesje / 14 dni</span><strong>{{ sessions.length }}</strong><small>wszystkie typy zadań</small></article>
          <article class="metric"><span>Chronione VM</span><strong>{{ storage.entries?.length || 0 }}</strong><small>ostatni snapshot</small></article>
          <article class="metric accent"><span>Wykorzystana przestrzeń</span><strong>{{ fmtBytes((storage.entries || []).reduce((s:number, v:any) => s + v.usedBytes, 0)) }}</strong><small>{{ storage.capturedAt ? fmtDate(storage.capturedAt) : 'brak snapshotu' }}</small></article>
        </section>
        <section class="panel"><div class="panel-head"><div><h2>Ostatnie sesje</h2><span>Veeam Backup & Replication</span></div><div class="session-statuses"><span class="badge good">Success {{ sessionCount('Success') }}</span><span class="badge warn">Warning {{ sessionCount('Warning') }}</span><span class="badge bad">Failed {{ sessionCount('Failed') }}</span></div></div>
          <div class="session-filters">
            <label class="filter-field filter-search"><span>Zadanie</span><div><Search :size="15" /><input v-model="sessionFilters.job" type="search" placeholder="Nazwa zadania…" /></div></label>
            <label class="filter-field"><span>Status</span><select v-model="sessionFilters.status"><option value="">Wszystkie</option><option value="Success">Success</option><option value="Warning">Warning</option><option value="Failed">Failed</option></select></label>
            <label class="filter-field"><span>Typ</span><select v-model="sessionFilters.type"><option value="">Wszystkie</option><option v-for="type in sessionTypes" :key="type" :value="type">{{ type }}</option></select></label>
            <label class="filter-field"><span>Start od</span><input v-model="sessionFilters.startedFrom" type="date" /></label>
            <label class="filter-field"><span>Start do</span><input v-model="sessionFilters.startedTo" type="date" /></label>
            <label class="filter-field"><span>Koniec od</span><input v-model="sessionFilters.endedFrom" type="date" /></label>
            <label class="filter-field"><span>Koniec do</span><input v-model="sessionFilters.endedTo" type="date" /></label>
            <div class="filter-actions"><span>{{ filteredSessions.length }} z {{ sessions.length }}</span><button class="clear-filters" :disabled="!filtersActive" @click="clearSessionFilters"><X :size="14" />Wyczyść</button></div>
          </div>
          <div class="table-wrap sessions-scroll"><table><thead><tr><th>Zadanie</th><th>Typ</th><th>Status</th><th>Start</th><th>Koniec</th></tr></thead><tbody><tr v-for="session in filteredSessions" :key="session.id"><td><strong>{{ session.name }}</strong></td><td>{{ session.type }}</td><td><span class="badge" :class="statusClass(session.status)">{{ session.status }}</span></td><td>{{ fmtDate(session.startedAt) }}</td><td>{{ fmtDate(session.endedAt) }}</td></tr><tr v-if="!filteredSessions.length"><td colspan="5" class="empty">Brak sesji spełniających wybrane kryteria</td></tr></tbody></table></div>
        </section>
        <section class="panel growth-panel"><div class="panel-head"><div><h2>Największy przyrost netto Storage Usage</h2><span>Zmiana od pierwszego znanego snapshotu w zaznaczonym zakresie · suwak lub kółko myszy</span></div><span class="count">{{ growth.points?.length || 0 }} snapshotów</span></div><StorageGrowthChart :points="growth.points || []" :theme="theme" /></section>
        <section class="panel"><div class="panel-head"><div><h2>Storage Usage</h2><span>Snapshoty z Veeam ONE</span></div><button class="secondary compact" :disabled="loading || !status?.database" @click="capture"><Activity :size="15" />Wykonaj snapshot</button></div>
          <div v-if="storage.entries?.length" class="storage-search-bar">
            <label class="search storage-search"><Search :size="16" /><input v-model="storageQuery" type="search" placeholder="Szukaj maszyny po nazwie…" aria-label="Szukaj maszyny po nazwie" /></label>
            <span>{{ visibleStorageEntries.length }} z {{ storage.entries.length }} maszyn</span>
          </div>
          <div class="storage-grid"><article v-for="vm in visibleStorageEntries" :key="vm.vmId" class="storage-card" :class="{ expanded: expandedStorage.has(vm.vmId) }">
            <button class="storage-summary" :aria-expanded="expandedStorage.has(vm.vmId)" @click="toggleStorage(vm.vmId)">
              <span class="storage-title"><strong>{{ vm.vmName }}</strong><small>{{ vm.dnsName || vm.powerState || 'VM' }}</small></span>
              <span class="disk-count"><HardDrive :size="14" />{{ vm.disks?.length || 0 }} {{ (vm.disks?.length || 0) === 1 ? 'dysk' : 'dyski' }}</span>
              <ChevronDown :size="18" class="chevron" />
            </button>
            <div v-if="vm.usageKnown !== false && vm.disks?.some((disk:any) => disk.usageKnown !== false)" class="usage"><i :style="{ width: `${usagePercent(vm.usedBytes, vm.capacityBytes)}%` }"></i></div>
            <footer v-if="vm.usageKnown !== false && vm.disks?.some((disk:any) => disk.usageKnown !== false)"><span>{{ fmtBytes(vm.usedBytes) }} zajęte</span><span>{{ fmtBytes(vm.freeBytes) }} wolne / {{ fmtBytes(vm.capacityBytes) }}</span></footer>
            <p v-else class="usage-unavailable">Brak danych o zajętości z systemu gościa</p>
            <div v-if="expandedStorage.has(vm.vmId)" class="disk-details">
              <div v-for="(disk, index) in vm.disks" :key="`${vm.vmId}-${disk.name}-${index}`" class="disk-row">
                <div class="disk-name"><span><HardDrive :size="15" /></span><div><strong>{{ disk.name }}</strong><small>{{ disk.usageKnown === false ? 'Brak danych VMware Tools' : `${usagePercent(disk.usedBytes, disk.capacityBytes).toFixed(1)}% zajęte` }}</small><small v-if="disk.mountPoints?.length > 1" :title="disk.mountPoints.slice(1).join(', ')">Ten filesystem ma też {{ disk.mountPoints.length - 1 }} inne punkty montowania</small></div></div>
                <template v-if="disk.usageKnown !== false"><div class="disk-usage"><i :style="{ width: `${usagePercent(disk.usedBytes, disk.capacityBytes)}%` }"></i></div><div class="disk-values"><b>{{ fmtBytes(disk.usedBytes) }}</b><span>z {{ fmtBytes(disk.capacityBytes) }}</span><small>{{ fmtBytes(disk.freeBytes) }} wolne</small></div></template>
                <div v-else class="disk-values unknown"><b>{{ fmtBytes(disk.capacityBytes) }}</b><span>pojemność dysku</span></div>
              </div>
              <div v-if="!vm.disks?.length" class="no-disks">Veeam ONE nie zwrócił informacji o dyskach tej maszyny.</div>
            </div>
          </article><div v-if="storage.entries?.length && !visibleStorageEntries.length" class="empty-card">Nie znaleziono maszyn o takiej nazwie.</div><div v-else-if="!storage.entries?.length" class="empty-card">Brak zapisanych snapshotów. Użyj przycisku „Wykonaj snapshot”.</div></div>
        </section>
      </template>

      <template v-if="active === 'vmware'">
        <div class="toolbar"><label class="search"><Search :size="17" /><input v-model="query" placeholder="Szukaj VM, hosta lub klastra…" /></label><span>{{ visibleHosts.length }} hostów · {{ visibleVmCount }} maszyn</span></div>
        <section class="host-list">
          <article v-for="host in visibleHosts" :key="host.host" class="panel host-card" :class="{ expanded: expandedHosts.has(host.host) || query.trim() }">
            <button class="host-summary" :aria-expanded="expandedHosts.has(host.host) || Boolean(query.trim())" @click="toggleHost(host.host)">
              <span class="host-identity"><span class="host-icon"><Server :size="19" /></span><span><strong>{{ host.name }}</strong><small>{{ host.clusterName || 'Host autonomiczny' }}</small></span></span>
              <span class="host-meta"><span class="badge" :class="statusClass(host.connection_state)">{{ host.connection_state || 'unknown' }}</span><span>{{ host.vms.length }} {{ host.vms.length === 1 ? 'maszyna' : 'maszyn' }}</span></span>
              <ChevronDown :size="19" class="chevron" />
            </button>
            <div v-if="expandedHosts.has(host.host) || query.trim()" class="host-vms table-wrap">
              <table><thead><tr><th>Maszyna wirtualna</th><th>Zasoby</th><th>Stan</th><th class="actions">Zasilanie</th></tr></thead><tbody>
                <tr v-for="vm in host.vms" :key="vm.vm"><td><div class="name-cell"><span class="server-icon"><Box :size="16" /></span><strong>{{ vm.name }}</strong></div></td><td><span>{{ vm.cpu_count ?? '—' }} vCPU</span><small class="subline">{{ (vm.memory_size_MiB ?? vm.memory_size_mib) ? `${Math.round((vm.memory_size_MiB ?? vm.memory_size_mib) / 1024)} GB RAM` : 'Brak danych o pamięci' }}</small></td><td><span class="badge" :class="statusClass(vm.power_state)">{{ vm.power_state || 'unknown' }}</span></td><td class="actions"><button class="icon-action good" title="Uruchom" @click="changeVm(vm, 'start')"><Power :size="16" /></button><button class="icon-action warn" title="Restart" @click="changeVm(vm, 'restart')"><RefreshCw :size="16" /></button><button class="icon-action bad" title="Wyłącz" @click="changeVm(vm, 'stop')"><Power :size="16" /></button></td></tr>
                <tr v-if="!host.vms.length"><td colspan="4" class="empty">Brak maszyn na tym hoście</td></tr>
              </tbody></table>
            </div>
          </article>
          <div v-if="!visibleHosts.length" class="empty-card">Brak hostów lub maszyn spełniających kryteria wyszukiwania</div>
        </section>
      </template>

      <template v-if="active === 'sophos'">
        <section class="metric-grid five"><article class="metric"><span>Tunele skonfigurowane</span><strong>{{ vpns.length }}</strong><small>Sophos Firewall</small></article><article class="metric accent"><span>Włączone administracyjnie</span><strong>{{ vpns.filter(v => v.active === true).length }}</strong><small>Status konfiguracji</small></article><article class="metric accent"><span>Połączone</span><strong>{{ vpns.filter(v => v.connectionStatus === 'connected').length }}</strong><small>Bieżący stan WebAdmin</small></article><article class="metric"><span>Niepołączone</span><strong>{{ vpns.filter(v => v.connectionStatus === 'not-connected').length }}</strong><small>Bieżący stan WebAdmin</small></article><article class="metric"><span>Nieznany runtime</span><strong>{{ vpns.filter(v => v.connectionStatus === 'unknown').length }}</strong><small>Brak rekordu/statusu WebAdmin</small></article></section>
        <section class="vpn-grid"><article v-for="vpn in vpns" :key="vpn.name" class="vpn-card">
          <div class="vpn-summary">
            <button class="vpn-expand" :aria-expanded="expandedVpns.has(vpn.name)" @click="toggleVpnDetails(vpn.name)">
              <span class="vpn-icon" :class="{ active: vpn.connectionStatus === 'connected', unknown: vpn.connectionStatus === 'unknown' }"><component :is="vpn.connectionStatus === 'not-connected' ? WifiOff : Wifi" :size="21" /></span>
              <span class="vpn-copy"><strong>{{ vpn.name }}</strong><span>{{ vpn.localGateway || 'Lokalny gateway' }} → {{ vpn.remoteGateway || 'Zdalny gateway' }}</span><small>Administracyjnie: {{ vpn.active === true ? 'włączony' : vpn.active === false ? 'wyłączony' : 'nieznany' }}</small><small>Połączenie: {{ vpn.connectionStatus === 'connected' ? 'połączone' : vpn.connectionStatus === 'not-connected' ? 'niepołączone' : 'nieznane' }}</small></span>
              <ChevronDown :size="18" class="chevron" :class="{ rotated: expandedVpns.has(vpn.name) }" />
            </button>
            <div class="vpn-badges"><span class="badge" :class="vpn.active === true ? 'good' : vpn.active === false ? 'bad' : 'warn'">{{ vpn.active === true ? 'Aktywny' : vpn.active === false ? 'Wyłączony' : 'Aktywacja ?' }}</span><span class="badge" :class="vpn.connectionStatus === 'connected' ? 'good' : vpn.connectionStatus === 'not-connected' ? 'bad' : 'warn'">{{ vpn.connectionStatus === 'connected' ? 'Połączony' : vpn.connectionStatus === 'not-connected' ? 'Brak połączenia' : 'Runtime ?' }}</span></div>
            <button v-if="vpn.active === true || vpn.active === false" class="toggle" :class="{ on: vpn.active === true }" :aria-label="`${vpn.active ? 'Wyłącz' : 'Włącz'} ${vpn.name}`" @click="changeVpn(vpn)"><i></i></button>
          </div>
          <div v-if="expandedVpns.has(vpn.name)" class="vpn-details">
            <div class="vpn-details-head"><strong>Podsieci w konfiguracji ({{ vpn.networkPairs?.length || 0 }})</strong><span>WebAdmin raportuje stan połączenia dla całego tunelu, nie osobno dla podsieci.</span></div>
            <p v-if="!vpn.runtimeAvailable" class="vpn-runtime-note">{{ vpn.runtimeStatusError || 'Nie udało się pobrać bieżącego stanu tuneli z Sophos WebAdmin.' }}</p>
            <p v-else-if="vpn.connectionStatus === 'unknown'" class="vpn-runtime-note">WebAdmin nie zwrócił rekordu ze stanem połączenia dla tego tunelu.</p>
            <div v-if="vpn.remoteHosts?.length" class="vpn-remotes"><strong>Zdalne hosty:</strong> {{ vpn.remoteHosts.join(', ') }}</div>
            <div v-if="vpn.networkPairs?.length" class="vpn-pairs-wrap"><table class="vpn-pairs"><thead><tr><th>Sieć lokalna</th><th>Sieć zdalna</th></tr></thead><tbody>
              <tr v-for="(pair, index) in vpn.networkPairs" :key="`${pair.local}-${pair.remote}-${index}`"><td>{{ pair.local }}</td><td>{{ pair.remote }}</td></tr>
            </tbody></table></div>
            <div v-else class="vpn-no-pairs">Sophos nie zwrócił podsieci w konfiguracji tego tunelu.</div>
          </div>
        </article><div v-if="!vpns.length" class="empty-card">Połączenie z Sophos działa, ale urządzenie nie zwróciło skonfigurowanych tuneli IPsec.</div></section>
      </template>

      <template v-if="active === 'netapp'">
        <section class="cluster-list"><article v-for="cluster in clusters" :key="cluster.name" class="panel cluster"><div class="cluster-head"><div class="cluster-name"><span><HardDrive :size="19" /></span><div><h2>{{ cluster.name }}</h2><small>{{ cluster.url }}</small></div></div><div class="cluster-stats"><span><b>{{ cluster.aggregates.length }}</b> agregatów</span><span><b>{{ cluster.volumes.length }}</b> wolumenów</span><span><b>{{ cluster.svms.length }}</b> SVM</span></div></div><div class="volume-list"><div v-for="volume in cluster.volumes" :key="volume.uuid" class="volume"><div><strong>{{ volume.name }}</strong><span>{{ volume.svm?.name || '—' }}</span></div><div class="volume-usage"><span>{{ volume.space?.percent_used || 0 }}%</span><div><i :style="{ width: `${volume.space?.percent_used || 0}%` }"></i></div></div><span>{{ fmtBytes(volume.space?.used) }} / {{ fmtBytes(volume.space?.size) }}</span><span class="badge" :class="statusClass(volume.state)">{{ volume.state }}</span></div></div></article><div v-if="!clusters.length" class="empty-card">Brak klastrów do wyświetlenia</div></section>
      </template>
      <TerminalPanel v-if="active === 'terminal'" :theme="theme" />
    </main>
  </div>
</template>
