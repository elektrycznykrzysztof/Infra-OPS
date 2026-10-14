import { Elysia } from "elysia";
import { staticPlugin } from "@elysiajs/static";
import { config, configured } from "./config";
import { hasValidBasicAuth, assertOrigin, UpstreamError } from "./http";
import { getNetappInventory, getSophosVpn, getVcenterTree, getVeeamSessions, powerVm, setSophosVpn } from "./integrations";
import { captureStorage, latestStorage, startStorageSchedule, storageGrowth, vmStorageHistory } from "./storage";
import { createSshSession } from "./ssh";
import { sendConfiguredTestEmail } from "./snapshot-alert";

if (!config.auth.username || !config.auth.password) {
  console.error("APP_USERNAME i APP_PASSWORD są wymagane"); process.exit(1);
}

const unauthorized = (set: any) => { set.status = 401; set.headers["www-authenticate"] = 'Basic realm="Infrastructure Dashboard", charset="UTF-8"'; return { error: "Wymagane uwierzytelnienie" }; };
const app = new Elysia()
  .onBeforeHandle(({ request, set }) => {
    const url = new URL(request.url);
    if (url.pathname === "/health") return;
    if (!hasValidBasicAuth(request.headers.get("authorization"))) return unauthorized(set);
  })
  .onError(({ error, set }) => {
    const upstream = error instanceof UpstreamError ? error : null;
    set.status = upstream?.status && upstream.status < 500 ? upstream.status : 502;
    return { error: upstream?.message || (error as Error).message || "Błąd serwera", system: upstream?.system };
  })
  .get("/health", () => ({ ok: true }))
  .get("/api/status", () => ({
    ok: true, timestamp: new Date().toISOString(), database: Boolean(process.env.DATABASE_URL?.trim()),
    integrations: {
      veeam: configured("veeam"), veeamOne: configured("veeamOne"), vmware: configured("vcenter"),
      sophos: configured("sophos"), netapp: configured("netapp"), terminal: true
    }
  }))
  .post("/api/admin/test-email", ({ request }) => { assertOrigin(request); return sendConfiguredTestEmail(); })
  .get("/api/veeam/sessions", () => getVeeamSessions())
  .get("/api/veeam-one/storage-usage", () => latestStorage())
  .post("/api/veeam-one/storage-usage/capture", ({ request }) => { assertOrigin(request); return captureStorage("manual"); })
  .get("/api/veeam-one/storage-usage/growth", () => storageGrowth())
  .get("/api/veeam-one/storage-usage/vms/:vmId/history", ({ params }) => vmStorageHistory(params.vmId))
  .get("/api/netapp/inventory", () => getNetappInventory())
  .get("/api/vcenter/tree", () => getVcenterTree())
  .post("/api/vcenter/vms/:vmId/power", ({ params, body, request }) => { assertOrigin(request); return powerVm(params.vmId, String((body as any)?.action || "")); })
  .get("/api/sophos/vpn", () => getSophosVpn())
  .post("/api/sophos/vpn/:name/activation", ({ params, body, request }) => { assertOrigin(request); return setSophosVpn(params.name, Boolean((body as any)?.active)); })
  .ws("/api/ssh", {
    beforeHandle({ request }) { assertOrigin(request); },
    open(ws) { (ws.data as any).ssh = createSshSession((payload) => ws.send(JSON.stringify(payload))); },
    message(ws, message) { (ws.data as any).ssh?.message(message); },
    close(ws) { (ws.data as any).ssh?.close(); }
  })
  .use(staticPlugin({ assets: new URL("../public", import.meta.url).pathname, prefix: "/", indexHTML: true }))
  .listen({ hostname: config.host, port: config.port });

startStorageSchedule().catch((error) => console.error("Storage schedule:", error.message));
console.log(`Infrastructure Dashboard: http://${config.host}:${config.port}`);
