import { ActionRowBuilder, ButtonBuilder, ButtonStyle, Client, GatewayIntentBits, MessageFlags, REST, Routes, SlashCommandBuilder } from "discord.js";

const required = ["DISCORD_TOKEN", "DISCORD_CLIENT_ID", "DISCORD_GUILD_ID", "DISCORD_ALLOWED_USER_ID", "APP_USERNAME", "APP_PASSWORD"] as const;
for (const key of required) if (!process.env[key]) { console.error(`Brak zmiennej ${key}`); process.exit(1); }
const baseUrl = process.env.DISCORD_API_BASE_URL || "http://api:3011";
const authorization = `Basic ${btoa(`${process.env.APP_USERNAME}:${process.env.APP_PASSWORD}`)}`;
async function api(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, { ...init, headers: { authorization, origin: "http://127.0.0.1:3011", "content-type": "application/json", ...(init?.headers || {}) } });
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
const flattenVms = (tree: any[]) => tree.flatMap((dc) => (dc.clusters || []).flatMap((c: any) => (c.hosts || []).flatMap((h: any) => h.vms || [])));
const confirmRow = (id: string) => new ActionRowBuilder<ButtonBuilder>().addComponents(
  new ButtonBuilder().setCustomId(`confirm:${id}`).setLabel("Potwierdź").setStyle(ButtonStyle.Danger),
  new ButtonBuilder().setCustomId(`cancel:${id}`).setLabel("Anuluj").setStyle(ButtonStyle.Secondary)
);

client.on("interactionCreate", async (interaction) => {
  if (interaction.user.id !== process.env.DISCORD_ALLOWED_USER_ID) {
    if (interaction.isRepliable()) await interaction.reply({ content: "Brak uprawnień.", flags: MessageFlags.Ephemeral }); return;
  }
  try {
    if (interaction.isButton()) {
      const [verb, id] = interaction.customId.split(":"); const operation = pending.get(id);
      if (!operation || operation.owner !== interaction.user.id) return interaction.update({ content: "Ta operacja wygasła.", components: [] });
      pending.delete(id); if (verb === "cancel") return interaction.update({ content: "Operacja anulowana.", components: [] });
      if (operation.kind === "vm") await api(`/api/vcenter/vms/${encodeURIComponent(operation.id)}/power`, { method: "POST", body: JSON.stringify({ action: operation.action }) });
      else await api(`/api/sophos/vpn/${encodeURIComponent(operation.id)}/activation`, { method: "POST", body: JSON.stringify({ active: operation.action === "on" }) });
      return interaction.update({ content: `Operacja **${operation.action}** dla **${operation.id}** została wysłana.`, components: [] });
    }
    if (!interaction.isChatInputCommand()) return;
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    if (interaction.commandName === "backup") {
      const sessions = await api("/api/veeam/sessions"); const lines = sessions.slice(0, 25).map((s: any) => `• **${s.name}** — ${s.status}`);
      return interaction.editReply(lines.join("\n") || "Brak sesji z ostatnich 14 dni.");
    }
    if (interaction.commandName === "server") {
      const vms = flattenVms(await api("/api/vcenter/tree")); const sub = interaction.options.getSubcommand();
      if (sub === "list") { const search = interaction.options.getString("search")?.toLowerCase(); const list = vms.filter((v: any) => !search || v.name.toLowerCase().includes(search)); return interaction.editReply(list.slice(0, 40).map((v: any) => `• **${v.name}** — ${v.power_state}`).join("\n") || "Brak maszyn."); }
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
    if (interaction.isRepliable()) interaction.deferred || interaction.replied ? await interaction.editReply(content) : await interaction.reply({ content, flags: MessageFlags.Ephemeral });
  }
});
client.once("ready", () => console.log(`Discord bot: ${client.user?.tag}`));
await client.login(process.env.DISCORD_TOKEN);
