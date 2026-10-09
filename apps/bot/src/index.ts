import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder } from "discord.js";

const required = ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_GUILD_ID", "APP_USERNAME", "APP_PASSWORD"] as const;
for (const key of required) if (!process.env[key]) { console.error(`Brak zmiennej ${key}`); process.exit(1); }
const allowedUserIdsValue = process.env.DISCORD_ALLOWED_USER_IDS?.trim() || process.env.DISCORD_ALLOWED_USER_ID || "";
const allowedUserIds = new Set(allowedUserIdsValue.split(",").map((id) => id.trim()).filter(Boolean));
if (!allowedUserIds.size) { console.error("Brak zmiennej DISCORD_ALLOWED_USER_IDS (lista ID oddzielonych przecinkami)"); process.exit(1); }
const baseUrl = process.env.DISCORD_API_BASE_URL || "http://api:3011";
const authorization = `Basic ${btoa(`${process.env.APP_USERNAME}:${process.env.APP_PASSWORD}`)}`;
async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, signal: AbortSignal.timeout(60_000), headers: { authorization, origin: "http://127.0.0.1:3011", "content-type": "application/json", ...(init?.headers || {}) } });
  const data = await response.json(); if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`); return data;
}

const commands = [
  new SlashCommandBuilder().setName("server").setDescription("Maszyny VMware")
    .addSubcommand((s) => s.setName("list").setDescription("Lista maszyn").addStringOption((o) => o.setName("search").setDescription("Filtr nazwy")))
    .addSubcommand((s) => s.setName("power").setDescription("Operacja zasilania").addStringOption((o) => o.setName("vm").setDescription("Dokładna nazwa VM").setRequired(true)).addStringOption((o) => o.setName("action").setDescription("Akcja").setRequired(true).addChoices({ name: "Start", value: "start" }, { name: "Stop", value: "stop" }, { name: "Restart", value: "restart" }))),
  new SlashCommandBuilder().setName("backup").setDescription("Veeam Backup").addSubcommand((s) => s.setName("list").setDescription("Sesje z ostatnich 14 dni")),
  new SlashCommandBuilder().setName("firewall").setDescription("Tunele Sophos")
    .addSubcommandGroup((g) => g.setName("tunel").setDescription("Operacje IPsec")
      .addSubcommand((s) => s.setName("list").setDescription("Lista tuneli"))
      .addSubcommand((s) => s.setName("on").setDescription("Włącz tunel").addStringOption((o) => o.setName("name").setDescription("Dokładna nazwa").setRequired(true)))
      .addSubcommand((s) => s.setName("off").setDescription("Wyłącz tunel").addStringOption((o) => o.setName("name").setDescription("Dokładna nazwa").setRequired(true))))
].map((command) => command.toJSON());

await new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN!).put(Routes.applicationGuildCommands(process.env.DISCORD_CLIENT_ID!, process.env.DISCORD_GUILD_ID!), { body: commands });
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
const pending = new Map<string, { kind: "vm" | "vpn"; id: string; action: string; owner: string }>();
type VmListState = { owner: string; search: string; vms: any[]; page: number; createdAt: number };
const vmLists = new Map<string, VmListState>();
const vmListTtlMs = 15 * 60 * 1000;
const flattenVms = (hosts: any[]) => hosts.flatMap((host) => (host.vms || []).map((vm: any) => ({ ...vm, _hostName: host.name || host.host || "Host nieznany" })));
const confirmRow = (id: string) => new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId(`confirm:${id}`).setLabel("Potwierdź").setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId(`cancel:${id}`).setLabel("Anuluj").setStyle(ButtonStyle.Secondary)
);
function renderVmList(state: VmListState, id: string) {
  const pages: string[][] = [[]]; let chars = 100;
  for (const vm of state.vms) {
    const name = String(vm.name || "VM bez nazwy").replace(/[\r\n]/g, " ").slice(0, 120);
    const host = String(vm._hostName || "Host nieznany").replace(/[\r\n]/g, " ").slice(0, 80);
    const line = `• **${name}** — ${vm.power_state || "unknown"} · ${host}`;
    let current = pages[pages.length - 1];
    if (current.length >= 20 || (current.length && chars + line.length + 1 > 1700)) {
      pages.push([]); chars = 100; current = pages[pages.length - 1];
    }
    current.push(line); chars += line.length + 1;
  }
  state.page = Math.max(0, Math.min(state.page, pages.length - 1));
  const controls = new ActionRowBuilder<ButtonBuilder>();
  if (state.page > 0) controls.addComponents(new ButtonBuilder().setCustomId(`server-prev:${id}`).setLabel("Poprzednia").setStyle(ButtonStyle.Secondary));
  if (state.page < pages.length - 1) controls.addComponents(new ButtonBuilder().setCustomId(`server-next:${id}`).setLabel("Następna").setStyle(ButtonStyle.Primary));
  return {
    content: `**Maszyny VMware (${state.vms.length})**${state.search ? ` · filtr: ${state.search}` : ""} · strona ${state.page + 1}/${pages.length}\n${pages[state.page].join("\n")}`,
    components: controls.components.length ? [controls] : []
  };
}

client.on("interactionCreate", async (interaction) => {
  if (!allowedUserIds.has(interaction.user.id)) {
    if (interaction.isRepliable()) await interaction.reply({ content: "Brak uprawnień.", flags: MessageFlags.Ephemeral }); return;
  }
  try {
    if (interaction.isButton()) {
      const [verb, id] = interaction.customId.split(":"); const operation = pending.get(id);
      if (verb === "server-prev" || verb === "server-next") {
        const state = vmLists.get(id);
        if (!state || state.owner !== interaction.user.id || Date.now() - state.createdAt > vmListTtlMs) {
          vmLists.delete(id); return interaction.update({ content: "Ta lista wygasła. Uruchom ponownie /server list.", components: [] });
        }
        state.page += verb === "server-next" ? 1 : -1;
        return interaction.update(renderVmList(state, id));
      }
      if (!operation || operation.owner !== interaction.user.id) return interaction.update({ content: "Ta operacja wygasła.", components: [] });
      if (verb === "cancel") { pending.delete(id); return interaction.update({ content: "Operacja anulowana.", components: [] }); }
      await interaction.deferUpdate();
      pending.delete(id);
      if (operation.kind === "vm") await api(`/api/vcenter/vms/${encodeURIComponent(operation.id)}/power`, { method: "POST", body: JSON.stringify({ action: operation.action }) });
      else await api(`/api/sophos/vpn/${encodeURIComponent(operation.id)}/activation`, { method: "POST", body: JSON.stringify({ active: operation.action === "on" }) });
      return interaction.editReply({ content: `Operacja **${operation.action}** dla **${operation.id}** została wykonana.`, components: [] });
    }
    if (!interaction.isChatInputCommand()) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.commandName === "backup") {
      const sessions = await api("/api/veeam/sessions"); const lines = sessions.slice(0, 25).map((s: any) => `• **${s.name}** — ${s.status}`);
      return interaction.editReply(lines.join("\n") || "Brak sesji z ostatnich 14 dni.");
    }
    if (interaction.commandName === "server") {
      const vms = flattenVms(await api("/api/vcenter/tree")); const sub = interaction.options.getSubcommand();
      if (sub === "list") {
        const search = interaction.options.getString("search")?.trim().toLowerCase() || "";
        const list = vms.filter((v: any) => !search || String(v.name || "").toLowerCase().includes(search) || String(v._hostName || "").toLowerCase().includes(search));
        if (!list.length) return interaction.editReply("Brak maszyn pasujących do filtra.");
        const now = Date.now(); for (const [key, value] of vmLists) if (now - value.createdAt > vmListTtlMs) vmLists.delete(key);
        const id = crypto.randomUUID(); const state: VmListState = { owner: interaction.user.id, search, vms: list, page: 0, createdAt: now };
        vmLists.set(id, state); return interaction.editReply(renderVmList(state, id));
      }
      const name = interaction.options.getString("vm", true); const matches = vms.filter((v: any) => v.name.toLowerCase() === name.toLowerCase());
      if (matches.length !== 1) return interaction.editReply(`Nazwa jest ${matches.length ? "niejednoznaczna" : "nieznana"}. Podaj dokładną nazwę VM.`);
      const id = crypto.randomUUID(); const action = interaction.options.getString("action", true); pending.set(id, { kind: "vm", id: matches[0].vm, action, owner: interaction.user.id });
      return interaction.editReply({ content: `Potwierdź **${action}** dla VM **${matches[0].name}**.`, components: [confirmRow(id)] });
    }
    const vpns = await api("/api/sophos/vpn"); const sub = interaction.options.getSubcommand();
    if (sub === "list") return interaction.editReply(vpns.slice(0, 40).map((v: any) => `• **${v.name}** — ${v.active ? "aktywny" : "nieaktywny"}`).join("\n") || "Brak tuneli.");
    const name = interaction.options.getString("name", true); const matches = vpns.filter((v: any) => v.name.toLowerCase() === name.toLowerCase());
    if (matches.length !== 1) return interaction.editReply(`Nazwa tunelu jest ${matches.length ? "niejednoznaczna" : "nieznana"}.`);
    const id = crypto.randomUUID(); pending.set(id, { kind: "vpn", id: matches[0].name, action: sub, owner: interaction.user.id });
    return interaction.editReply({ content: `Potwierdź **${sub}** dla tunelu **${matches[0].name}**.`, components: [confirmRow(id)] });
  } catch (error) {
    const content = `Błąd: ${(error as Error).message}`;
    console.error(`Discord interaction failed (${(error as any)?.code ?? "unknown"}): ${(error as Error).message}`);
    if (interaction.isRepliable()) {
      try { interaction.deferred || interaction.replied ? await interaction.editReply({ content, components: [] }) : await interaction.reply({ content, flags: MessageFlags.Ephemeral }); }
      catch (replyError) { console.error(`Discord response failed (${(replyError as any)?.code ?? "unknown"}): ${(replyError as Error).message}`); }
    }
  }
});
client.once("ready", () => console.log(`Discord bot: ${client.user?.tag}`));
await client.login(process.env.DISCORD_TOKEN);
