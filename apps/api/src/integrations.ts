import { XMLParser } from "fast-xml-parser";
import { basicHeader, requestJson, UpstreamError } from "./http";
import { config, configured, fetchOptions } from "./config";
import { deduplicateLinuxMountPoints } from "./storage-disks";

type Token = { accessToken: string; refreshToken?: string; expiresAt: number };
type TokenResponse = { access_token: string; refresh_token?: string; expires_in?: number };

class OAuthClient {
  private token?: Token;
  constructor(private system: string, private baseUrl: string, private tokenPath: string, private username: string, private password: string, private insecure: boolean, private versionHeader?: string) {}

  private async login(refresh = false) {
    const body = new URLSearchParams(refresh && this.token?.refreshToken ? {
      grant_type: "refresh_token", refresh_token: this.token.refreshToken
    } : { grant_type: "password", username: this.username, password: this.password, ...(this.system === "Veeam" ? { use_short_term_refresh: "true" } : {}) });
    const data = await requestJson<TokenResponse>(this.system, `${this.baseUrl}${this.tokenPath}`, {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body
    }, this.insecure);
    this.token = { accessToken: data.access_token, refreshToken: data.refresh_token, expiresAt: Date.now() + Math.max(30, (data.expires_in || 300) - 30) * 1000 };
  }

  async get<T>(path: string) {
    if (!this.token || Date.now() >= this.token.expiresAt) {
      try { await this.login(Boolean(this.token?.refreshToken)); } catch { await this.login(false); }
    }
    const headers: Record<string, string> = { authorization: `Bearer ${this.token!.accessToken}` };
    if (this.versionHeader) headers["x-api-version"] = this.versionHeader;
    try { return await requestJson<T>(this.system, `${this.baseUrl}${path}`, { headers }, this.insecure); }
    catch (error) {
      if (!(error instanceof UpstreamError) || error.status !== 401) throw error;
      await this.login(false);
      headers.authorization = `Bearer ${this.token!.accessToken}`;
      return requestJson<T>(this.system, `${this.baseUrl}${path}`, { headers }, this.insecure);
    }
  }
}

const veeam = new OAuthClient("Veeam", config.veeam.baseUrl, "/api/oauth2/token", config.veeam.username, config.veeam.password, config.veeam.insecure, config.veeam.version);
const veeamOne = new OAuthClient("Veeam ONE", config.veeamOne.baseUrl, "/api/token", config.veeamOne.username, config.veeamOne.password, config.veeamOne.insecure);

const values = (data: any) => Array.isArray(data) ? data : data?.data || data?.value || data?.items || data?.results || [];
const asNumber = (value: unknown) => Number(value || 0);
const firstNumber = (...candidates: unknown[]) => {
  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined || candidate === "") continue;
    const number = Number(candidate);
    if (Number.isFinite(number)) return number;
  }
  return 0;
};

const normalizeVeeamStatus = (item: any) => {
  const result = typeof item.result === "object" ? item.result?.result : item.result;
  const raw = String(result || item.status || item.state || "Unknown");
  if (/success|succeed/i.test(raw)) return "Success";
  if (/warning/i.test(raw)) return "Warning";
  if (/fail|error/i.test(raw)) return "Failed";
  return raw;
};

export async function getVeeamSessions() {
  if (!configured("veeam")) return [];
  const params = new URLSearchParams({ limit: "100", orderColumn: "EndTime", orderAsc: "false" });
  const data = await veeam.get<any>(`/api/v1/sessions?${params}`);
  const cutoff = Date.now() - 14 * 86400000;
  return values(data).filter((item: any) => !item.endTime || new Date(item.endTime).getTime() >= cutoff).map((item: any) => ({
    id: item.id, name: item.name || item.jobName || item.resourceName || "Zadanie Veeam",
    type: item.sessionType || item.type || "BackupJob", status: normalizeVeeamStatus(item),
    startedAt: item.creationTime || item.startTime, endedAt: item.endTime, progress: item.progressPercent ?? item.progress
  }));
}

export async function getStorageUsage() {
  if (!configured("veeamOne")) return [];
  const result: any[] = [];
  for (let offset = 0; offset < 10000; offset += 200) {
    const data = await veeamOne.get<any>(`/api/v${config.veeamOne.version}/vSphere/vms?Offset=${offset}&Limit=200`);
    const page = values(data);
    for (const vm of page) {
      const guestDisks = values(vm.guestDisks || vm.disks || vm.guestDiskInfo);
      const rawDisks = guestDisks.length ? guestDisks.map((disk: any) => {
        const capacityBytes = firstNumber(disk.capacityBytes, disk.capacity, disk.totalSpaceBytes, disk.totalSpace);
        const freeBytes = Math.min(capacityBytes, Math.max(0, firstNumber(disk.freeSpaceBytes, disk.freeBytes, disk.freeSpace, disk.availableBytes)));
        return {
          name: disk.name || disk.path || disk.mountPoint || "Dysk",
          capacityBytes, freeBytes, usedBytes: Math.max(0, capacityBytes - freeBytes), usageKnown: true
        };
      }) : values(vm.virtualDisks).map((disk: any, index: number) => ({
        name: disk.name || `Dysk ${index + 1}`,
        capacityBytes: firstNumber(disk.capacityBytes, disk.capacity, disk.totalSpaceBytes, disk.totalSpace),
        freeBytes: null, usedBytes: null, usageKnown: false
      }));
      const disks = deduplicateLinuxMountPoints(rawDisks);
      const knownDisks = disks.filter((disk: any) => disk.usageKnown);
      const capacityBytes = knownDisks.length
        ? knownDisks.reduce((sum: number, disk: any) => sum + disk.capacityBytes, 0)
        : firstNumber(vm.totalDiskCapacityBytes, vm.capacityBytes, vm.capacity, disks.reduce((sum: number, disk: any) => sum + disk.capacityBytes, 0));
      const freeBytes = knownDisks.reduce((sum: number, disk: any) => sum + disk.freeBytes, 0);
      const usedBytes = knownDisks.reduce((sum: number, disk: any) => sum + disk.usedBytes, 0);
      result.push({
        id: String(vm.id || vm.vmId || vm.moRef), name: vm.name, powerState: vm.powerState,
        dnsName: vm.dnsName || vm.guestDnsName, capacityBytes, freeBytes, usedBytes,
        diskCount: firstNumber(vm.virtualDiskCount, disks.length), usageKnown: knownDisks.length > 0, disks
      });
    }
    if (page.length < 200) break;
  }
  return result;
}

let vcenterSession = "";
async function vcenterCall<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  if (!configured("vcenter")) return [] as T;
  const api = config.vcenter.apiPath.replace(/\/$/, "");
  if (!vcenterSession) {
    const result = await requestJson<any>("VMware", `${config.vcenter.baseUrl}${api}/session`, { method: "POST", headers: { authorization: basicHeader(config.vcenter.username, config.vcenter.password) } }, config.vcenter.insecure);
    vcenterSession = typeof result === "string" ? result : result?.value || result;
  }
  try {
    return await requestJson<T>("VMware", `${config.vcenter.baseUrl}${api}${path}`, { ...init, headers: { ...(init.headers || {}), "vmware-api-session-id": vcenterSession } }, config.vcenter.insecure);
  } catch (error) {
    if (retry && error instanceof UpstreamError && error.status === 401) { vcenterSession = ""; return vcenterCall<T>(path, init, false); }
    throw error;
  }
}

export async function getVcenterTree() {
  if (!configured("vcenter")) return [];
  const [hostResult, clusterResult] = await Promise.all([
    vcenterCall<any[]>("/vcenter/host"),
    vcenterCall<any[]>("/vcenter/cluster")
  ]);
  const hosts = [...new Map(values(hostResult).map((host: any) => [host.host, host])).values()];
  const clusters = values(clusterResult);
  const clusterByHost = new Map<string, any>();

  await Promise.all(clusters.map(async (cluster: any) => {
    const members = values(await vcenterCall<any[]>(`/vcenter/host?clusters=${encodeURIComponent(cluster.cluster)}`));
    for (const host of members) clusterByHost.set(host.host, cluster);
  }));

  return Promise.all(hosts.map(async (host: any) => {
    const vmResult = values(await vcenterCall<any[]>(`/vcenter/vm?hosts=${encodeURIComponent(host.host)}`));
    const vms = [...new Map(vmResult.map((vm: any) => [vm.vm, vm])).values()];
    const cluster = clusterByHost.get(host.host);
    return { ...host, cluster: cluster?.cluster || null, clusterName: cluster?.name || null, vms };
  }));
}

export async function powerVm(vmId: string, action: string) {
  const allowed = new Set(["start", "stop", "restart", "reset"]);
  if (!allowed.has(action)) throw new UpstreamError("VMware", 400, "Nieprawidłowa akcja zasilania");
  if (action === "restart") {
    try { return await vcenterCall(`/vcenter/vm/${encodeURIComponent(vmId)}/guest/power?action=reboot`, { method: "POST" }); }
    catch { return vcenterCall(`/vcenter/vm/${encodeURIComponent(vmId)}/power?action=reset`, { method: "POST" }); }
  }
  return vcenterCall(`/vcenter/vm/${encodeURIComponent(vmId)}/power?action=${action}`, { method: "POST" });
}

async function netappPaged(clusterUrl: string, path: string) {
  const base = new URL(clusterUrl);
  let next: string | null = `${base.origin}${path}`;
  const records: any[] = [];
  while (next) {
    const url: URL = new URL(next);
    if (url.host !== base.host) throw new UpstreamError("NetApp", 502, "Odrzucono link paginacji do innego hosta");
    const data: any = await requestJson("NetApp", url.toString(), { headers: { authorization: basicHeader(config.netapp.username, config.netapp.password) } }, config.netapp.insecure);
    records.push(...values(data?.records || data));
    const href: string | undefined = data?._links?.next?.href;
    next = href ? new URL(href, base.origin).toString() : null;
  }
  return records;
}

export async function getNetappInventory() {
  if (!configured("netapp")) return [];
  return Promise.all(config.netapp.clusters.map(async (cluster) => {
    const [aggregates, volumes, svms] = await Promise.all([
      netappPaged(cluster.url, "/api/storage/aggregates?fields=name,uuid,state,node.name,space.block_storage"),
      netappPaged(cluster.url, "/api/storage/volumes?fields=name,uuid,state,style,svm.name,aggregates.name,space"),
      netappPaged(cluster.url, "/api/svm/svms?fields=name,uuid,state,subtype,ipspace.name")
    ]);
    return { name: cluster.name, url: cluster.url, aggregates, volumes, svms };
  }));
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "" });
const xmlEscape = (value: string) => value.replace(/[<>&'\"]/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&apos;", '"': "&quot;" })[c]!);
async function sophosXml(operation: string) {
  const login = `<Login><Username>${xmlEscape(config.sophos.username)}</Username><Password passwordform="plain">${xmlEscape(config.sophos.password)}</Password></Login>`;
  const reqxml = `<Request APIVersion="${xmlEscape(config.sophos.version)}">${login}${operation}</Request>`;
  const form = new FormData(); form.append("reqxml", reqxml);
  const response = await fetch(`${config.sophos.baseUrl}/webconsole/APIController`, { ...fetchOptions(config.sophos.insecure), method: "POST", body: form } as any);
  if (!response.ok) throw new UpstreamError("Sophos", response.status, await response.text());
  return parser.parse(await response.text());
}

function findVpnNodes(node: any, found: any[] = []): any[] {
  if (!node || typeof node !== "object") return found;
  for (const [key, value] of Object.entries(node)) {
    if (key.toLowerCase().includes("vpnipsecconnection")) {
      for (const container of (Array.isArray(value) ? value : [value])) {
        const configurations = container?.Configuration;
        if (configurations) found.push(...(Array.isArray(configurations) ? configurations : [configurations]));
        else found.push(container);
      }
    }
    else findVpnNodes(value, found);
  }
  return found;
}

function vpnValues(value: any): any[] {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function networkName(value: any): string {
  if (typeof value === "string" || typeof value === "number") return String(value).trim();
  if (!value || typeof value !== "object") return "";
  return String(value.Name || value.name || value.Network || value.NetworkName || value["#text"] || "").trim();
}

function vpnNetworkPairs(vpn: any) {
  const local = vpnValues(vpn.LocalSubnet).map(networkName).filter(Boolean);
  const remote = vpnValues(vpn.RemoteNetwork).flatMap((item) => vpnValues(item?.Network ?? item)).map(networkName).filter(Boolean);
  return local.flatMap((localNetwork) => remote.map((remoteNetwork) => ({
    local: localNetwork,
    remote: remoteNetwork
  })));
}

const normalizedVpnText = (value: unknown) => String(value ?? "").trim().toLowerCase().replace(/\s+/g, "");

function webAdminField(row: any, ...names: string[]) {
  if (!row || typeof row !== "object") return undefined;
  const fields = new Map(Object.entries(row).map(([key, value]) => [key.toLowerCase().replace(/[^a-z0-9]/g, ""), value]));
  for (const name of names) {
    const value = fields.get(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function findWebAdminRows(data: any): any[] | null {
  const explicit = [data?.records, data?.data?.records, data?.result?.records];
  for (const rows of explicit) if (Array.isArray(rows)) return rows;
  const candidates: any[][] = [];
  const visit = (node: any, key = "") => {
    if (Array.isArray(node)) {
      if (node.length === 0 && /^(data|rows|records|items|results|result)$/i.test(key)) candidates.push(node);
      else if (node.length && node.every((item) => item && typeof item === "object" && !Array.isArray(item))) candidates.push(node);
      else node.forEach((item) => visit(item, key));
    } else if (node && typeof node === "object") {
      for (const [childKey, value] of Object.entries(node)) visit(value, childKey);
    }
  };
  visit(data);
  candidates.sort((a, b) => b.length - a.length);
  return candidates[0] ?? null;
}

function enabledFromWebAdmin(value: unknown): boolean | null {
  const status = String(value ?? "").trim().toLowerCase();
  if (["active", "enabled", "enable", "true", "on", "t", "1"].includes(status)) return true;
  if (["deactive", "inactive", "disabled", "disable", "false", "off", "f", "0"].includes(status)) return false;
  return null;
}

function connectionFromWebAdmin(value: unknown): "connected" | "not-connected" | "unknown" {
  if (value === null || value === undefined || String(value).trim() === "") return "unknown";
  const status = Number(value);
  if (!Number.isFinite(status)) return "unknown";
  return status > 0 ? "connected" : "not-connected";
}

function extractCsrfToken(html: string): string | null {
  const patterns = [
    /<meta\b[^>]*\bname=["'](?:csrf-token|csrf_token|csrftoken)["'][^>]*\bcontent=["']([^"']+)["']/i,
    /<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bname=["'](?:csrf-token|csrf_token|csrftoken)["']/i,
    /<input\b[^>]*\bname=["'](?:csrf-token|csrf_token|csrftoken|_csrf)["'][^>]*\bvalue=["']([^"']+)["']/i,
    /\b(?:csrfToken|csrf_token|csrf-token|_csrf)\s*[:=]\s*["']([^"']+)["']/i
  ];
  for (const pattern of patterns) {
    const token = html.match(pattern)?.[1];
    if (token) return token.replace(/&amp;/g, "&");
  }
  const directSetter = html.match(/setCSRFToken\s*\(\s*["']([^"']+)["']\s*\)/i)?.[1];
  if (directSetter) return directSetter.replace(/&amp;/g, "&");

  // Sophos obfuscates the CSRF variable name in index.jsp (for example, c$rFt0k3n)
  // but passes that variable to setCSRFToken. Resolve its assignment without evaluating page scripts.
  const setter = html.match(/setCSRFToken\s*\(\s*(?:Cyberoam\.)?([\w$]+)\s*\)/i);
  if (setter) {
    const variable = setter[1].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const assigned = html.match(new RegExp(`(?:Cyberoam\\.)?${variable}\\s*=\\s*["']([^"']+)["']`, "i"))?.[1];
    if (assigned) return assigned.replace(/&amp;/g, "&");
  }
  return null;
}

function webAdminError(error: unknown, target: string, hasSeparateCredentials: boolean): string {
  const code = error instanceof Error ? error.message : "";
  if (code === "session-expired") {
    return hasSeparateCredentials
      ? `Sophos WebAdmin zwrócił „Session Expired” przy odczycie ${target}. Sprawdź uprawnienia konta WebAdmin do listy IPsec i dostęp adresu serwera panelu.`
      : `Sophos WebAdmin zwrócił „Session Expired” przy odczycie ${target}. Ustaw osobne SOPHOS_WEBADMIN_USERNAME i SOPHOS_WEBADMIN_PASSWORD w .env.`;
  }
  if (code === "csrf-token-missing") {
    return "Sophos WebAdmin otworzył stronę główną, ale nie udało się odczytać tokenu CSRF wymaganego do pobrania bieżącego statusu tuneli.";
  }
  if (code === "unexpected-grid-response") {
    return `Sophos WebAdmin odpowiedział, ale nie zwrócił oczekiwanej tabeli ${target}.`;
  }
  return `Nie udało się pobrać ${target} z Sophos WebAdmin. Sprawdź konto, adres WebAdmin i uprawnienia tylko do odczytu.`;
}

async function getSophosWebAdminData(): Promise<{
  enabledByName: Map<string, boolean>;
  connectionByName: Map<string, "connected" | "not-connected">;
  runtimeAvailable: boolean;
  runtimeError?: string;
}> {
  const admin = config.sophos;
  if (!admin.webAdminBaseUrl || !admin.webAdminUsername || !admin.webAdminPassword) {
    return {
      enabledByName: new Map(), connectionByName: new Map(), runtimeAvailable: false,
      runtimeError: "Uzupełnij SOPHOS_WEBADMIN_USERNAME i SOPHOS_WEBADMIN_PASSWORD w .env."
    };
  }

  const baseUrl = admin.webAdminBaseUrl.replace(/\/+$/, "");
  const webAdminTimeout = AbortSignal.timeout(15_000);
  const fetchWeb = (path: string, init: RequestInit = {}) => fetch(`${baseUrl}${path}`, {
    ...fetchOptions(admin.webAdminInsecure), ...init, signal: webAdminTimeout
  } as any);
  const cookieMap = new Map<string, string>();
  const collectCookies = (headers: Headers) => {
    const cookies = typeof (headers as any).getSetCookie === "function" ? (headers as any).getSetCookie() : [headers.get("set-cookie")].filter(Boolean);
    for (const item of cookies) {
      const pair = String(item).split(";", 1)[0];
      const key = pair.split("=", 1)[0];
      if (key && pair.includes("=")) cookieMap.set(key, pair);
    }
  };

  try {
    const loginPage = await fetchWeb("/webconsole/webpages/login.jsp");
    if (!loginPage.ok) throw new Error(`login-page-${loginPage.status}`);
    collectCookies(loginPage.headers);

    const loginBody = new URLSearchParams({
      mode: "151",
      json: JSON.stringify({ username: admin.webAdminUsername, password: admin.webAdminPassword, languageid: "1" }),
      __RequestType: "ajax",
      t: String(Date.now())
    });
    const origin = new URL(baseUrl).origin;
    const login = await fetchWeb("/webconsole/Controller", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-requested-with": "XMLHttpRequest",
        origin,
        referer: `${baseUrl}/webconsole/webpages/login.jsp`,
        cookie: [...cookieMap.values()].join("; ")
      },
      body: loginBody
    });
    collectCookies(login.headers);
    if (!login.ok) throw new Error(`login-${login.status}`);
    const loginResult: any = await login.json();
    if (Number(loginResult?.status) !== 200) throw new Error("login-rejected");

    const index = await fetchWeb("/webconsole/webpages/index.jsp", { headers: { cookie: [...cookieMap.values()].join("; ") } });
    const indexHtml = await index.text();
    collectCookies(index.headers);
    if (!index.ok || /function\s+callLogin\s*\(/.test(indexHtml)) throw new Error("session-expired");
    const csrfToken = extractCsrfToken(indexHtml);
    if (!csrfToken) throw new Error("csrf-token-missing");

    const requestGrid = async () => {
      const query = new URLSearchParams({
        mode: "301", datagridid: "502", sort: "connectionname", dir: "asc",
        startIndex: "0", results: "100", filter: "", __RequestType: "ajax", t: String(Date.now())
      });
      const response = await fetchWeb(`/webconsole/Controller?${query}`, {
        headers: {
          cookie: [...cookieMap.values()].join("; "),
          "x-csrf-token": csrfToken,
          "x-requested-with": "XMLHttpRequest",
          origin,
          referer: `${baseUrl}/webconsole/webpages/index.jsp`
        }
      });
      if (!response.ok) throw new Error(`grid-${response.status}`);
      const data: any = await response.json();
      if (/session expired|access denied/i.test(String(data?.status || data?.message || ""))) throw new Error("session-expired");
      const rows = findWebAdminRows(data);
      if (!rows) throw new Error("unexpected-grid-response");
      return rows;
    };

    const rows = await requestGrid();
    const enabledByName = new Map<string, boolean>();
    const connectionByName = new Map<string, "connected" | "not-connected">();
    for (const row of rows) {
      const name = webAdminField(row, "connectionname", "name", "connname");
      if (!name) continue;
      const key = normalizedVpnText(name);
      const enabled = enabledFromWebAdmin(webAdminField(row, "activestatus"));
      const connection = connectionFromWebAdmin(webAdminField(row, "connstatus"));
      if (enabled !== null) enabledByName.set(key, enabled);
      if (connection !== "unknown") connectionByName.set(key, connection);
    }
    return { enabledByName, connectionByName, runtimeAvailable: true };
  } catch (error) {
    return {
      enabledByName: new Map(), connectionByName: new Map(), runtimeAvailable: false,
      runtimeError: webAdminError(error, "statusu tuneli", admin.webAdminCredentialsExplicit)
    };
  }
}

function vpnEnabled(vpn: any): boolean | null {
  const status = String(vpn.Status ?? vpn.Active ?? "").trim().toLowerCase();
  if (["active", "enabled", "enable", "true", "1"].includes(status)) return true;
  if (["deactive", "inactive", "disabled", "disable", "false", "0"].includes(status)) return false;
  const numericStatus = Number(status);
  if (status && Number.isFinite(numericStatus)) return numericStatus !== 0;
  return null;
}

function isSiteToSiteVpn(vpn: any): boolean {
  const type = normalizedVpnText(vpn.ConnectionType || vpn.connectiontype || vpn.Type);
  if (type) return type === "sitetosite";
  return vpnValues(vpn.LocalSubnet).some((subnet) => Boolean(networkName(subnet)));
}

function vpnRemoteHosts(vpn: any): string[] {
  const rawHosts = vpnValues(vpn.RemoteHost ?? vpn.RemoteNetwork);
  return [...new Set(rawHosts.map(networkName).filter(Boolean))];
}

export async function getSophosVpn() {
  if (!configured("sophos")) return [];
  const data = await sophosXml("<Get><VPNIPSecConnection/></Get>");
  const loginStatus = String(data?.Response?.Login?.status || "");
  if (loginStatus && !/successful/i.test(loginStatus)) throw new UpstreamError("Sophos", 401, `Logowanie do Sophos nie powiodło się: ${loginStatus}`);
  const webAdmin = await getSophosWebAdminData();
  return findVpnNodes(data).filter(isSiteToSiteVpn).map((vpn: any) => {
    const name = vpn.Name || vpn.name || vpn.ConnectionName;
    const remoteHosts = vpnRemoteHosts(vpn);
    return {
      name,
      active: webAdmin.enabledByName.get(normalizedVpnText(name)) ?? vpnEnabled(vpn),
      connectionStatus: webAdmin.connectionByName.get(normalizedVpnText(name)) ?? "unknown",
      runtimeAvailable: webAdmin.runtimeAvailable,
      runtimeStatusError: webAdmin.runtimeError,
      remoteHosts,
      networkPairs: vpnNetworkPairs(vpn),
      localGateway: networkName(vpn.LocalGateway || vpn.LocalWANPort || vpn.AliasLocalWANPort),
      remoteGateway: networkName(vpn.RemoteGateway) || remoteHosts[0] || ""
    };
  }).filter((vpn: any) => vpn.name);
}

export async function setSophosVpn(name: string, active: boolean) {
  if (!configured("sophos")) throw new UpstreamError("Sophos", 503, "Integracja nie jest skonfigurowana");
  const action = active ? "Active" : "DeActive";
  const data: any = await sophosXml(`<Set><VPNIPSecConnection><${action}><Name>${xmlEscape(name)}</Name></${action}></VPNIPSecConnection></Set>`);
  const status = data?.Response?.Set?.Status;
  const code = String(status?.code ?? status?.Code ?? status?.["@_code"] ?? "");
  const message = String(status?.["#text"] ?? status?.message ?? (typeof status === "string" ? status : "")).trim();
  if (code && code !== "200") {
    throw new UpstreamError("Sophos", 502, `Sophos nie potwierdził ${active ? "włączenia" : "wyłączenia"} tunelu ${name}${code ? ` (kod ${code})` : ""}${message ? `: ${message}` : "."}`);
  }
  if (!code) {
    const current = await getSophosVpn();
    const observed = current.find((vpn: any) => normalizedVpnText(vpn.name) === normalizedVpnText(name));
    if (observed?.active !== active) {
      throw new UpstreamError("Sophos", 502, `Nie udało się potwierdzić ${active ? "włączenia" : "wyłączenia"} tunelu ${name}${message ? `: ${message}` : " — stan odczytany z firewalla nie odpowiada żądaniu."}`);
    }
  }
  return { ok: true, active, message: message || `Tunel ${active ? "włączony" : "wyłączony"}` };
}
