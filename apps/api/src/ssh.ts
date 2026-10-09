import { Client } from "ssh2";
import { isIP } from "node:net";

type Session = { client?: Client; stream?: any };
type KnownHosts = Record<string, string>;
const knownHostsPath = "/data/ssh-known-hosts.json";
let knownHosts: KnownHosts = {};

try { knownHosts = await Bun.file(knownHostsPath).json(); } catch { knownHosts = {}; }

export function createSshSession(send: (payload: unknown) => void) {
  const session: Session = {};
  const emit = (type: string, extra: Record<string, unknown> = {}) => send({ type, ...extra });

  return {
    async message(raw: unknown) {
      let message: any;
      try { message = typeof raw === "string" ? JSON.parse(raw) : raw; } catch { return emit("error", { message: "Nieprawidłowy komunikat JSON" }); }
      if (message?.type === "input") return session.stream?.write(String(message.data || ""));
      if (message?.type === "resize") return session.stream?.setWindow(Math.max(1, Number(message.rows) || 32), Math.max(1, Number(message.cols) || 120), 0, 0);
      if (message?.type !== "connect") return;

      const host = String(message.host || "").trim();
      if (!isIP(host)) return emit("error", { message: "Dozwolony jest wyłącznie adres IPv4 lub IPv6" });
      if (!message.username || !message.password) return emit("error", { message: "Podaj login i hasło" });
      session.client?.end();
      const client = new Client(); session.client = client;
      let learnedFingerprint = "";
      client.on("ready", () => {
        if (learnedFingerprint && !knownHosts[host]) {
          knownHosts[host] = learnedFingerprint;
          Bun.write(knownHostsPath, JSON.stringify(knownHosts, null, 2)).catch(() => undefined);
          emit("fingerprint", { fingerprint: learnedFingerprint, firstUse: true });
        }
        client.shell({ term: "xterm-256color", cols: Number(message.cols) || 120, rows: Number(message.rows) || 32 }, (error, stream) => {
          if (error) return emit("error", { message: error.message });
          session.stream = stream;
          emit("connected", { host });
          stream.on("data", (data: Buffer) => emit("data", { data: data.toString("utf8") }));
          stream.stderr.on("data", (data: Buffer) => emit("data", { data: data.toString("utf8") }));
          stream.on("close", () => { emit("closed"); client.end(); });
        });
      }).on("error", (error) => emit("error", { message: error.message })).on("close", () => emit("closed"));
      client.connect({
        host, port: 22, username: String(message.username), password: String(message.password), readyTimeout: 15000,
        hostHash: "sha256", hostVerifier: (fingerprint: string) => {
          if (!knownHosts[host]) { learnedFingerprint = fingerprint; return true; }
          const matches = knownHosts[host] === fingerprint;
          if (!matches) emit("error", { message: "Fingerprint hosta nie jest zgodny z zapamiętanym kluczem. Połączenie przerwane." });
          return matches;
        },
        algorithms: { kex: ["curve25519-sha256", "curve25519-sha256@libssh.org", "ecdh-sha2-nistp256", "diffie-hellman-group14-sha256", "diffie-hellman-group14-sha1"] }
      });
    },
    close() { session.stream?.end(); session.client?.end(); }
  };
}
