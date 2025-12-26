require("dotenv").config();
const fs = require("fs");
const path = require("path");
const {
  Client,
  GatewayIntentBits,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  PermissionsBitField,
} = require("discord.js");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

/* =========================
   Simple JSON DB (for history)
   - ตอนนี้ปุ่ม “ประวัติ” จะอ่านจากไฟล์นี้
   - ภายหลังค่อยเพิ่มโค้ดบันทึก order ลง DB.orders
========================= */
const DATA_DIR = path.join(process.cwd(), "data");
const DB_PATH = path.join(DATA_DIR, "dinobux_db.json");

function ensureDB() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DB_PATH)) {
    fs.writeFileSync(DB_PATH, JSON.stringify({ orders: [] }, null, 2), "utf8");
  }
}
function loadDB() {
  ensureDB();
  return JSON.parse(fs.readFileSync(DB_PATH, "utf8"));
}
function saveDB(db) {
  ensureDB();
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), "utf8");
}
function fmtDate(ts) {
  if (!ts) return "-";
  return new Date(ts).toLocaleString("th-TH", { dateStyle: "short", timeStyle: "short" });
}

function buildDinobuxCover() {
  const banner = process.env.BANNER_URL;
  const logo = process.env.LOGO_URL;

  return new EmbedBuilder()
    .setColor(0x57F287)
    .setAuthor({ name: "Dinobux Store" })
    .setTitle("🦖 เติมเกมไว • ระบบ Ticket • เช็คประวัติได้")
    .setDescription(
      [
        "⏰ **เปิดบริการ:** 09:00 – 02:00 น.",
        "🧾 **ส่งสลิปใน Ticket เท่านั้น** (รูปชัด ไม่ครอป)",
        "🔎 **เช็คยอดสะสม/ประวัติการสั่งซื้อ** ได้",
        "",
        "กดปุ่มด้านล่างเพื่อเริ่มใช้งาน",
      ].join("\n")
    )
    .addFields(
      { name: "⚡ ขั้นตอนสั่งซื้อ", value: "เปิด Ticket → แจ้งรายการ → สรุปยอด → ชำระเงิน → ส่งสลิป", inline: false },
      { name: "✅ บริการ", value: "เติมเกม / เติมพาส / ดูแลหลังการขาย", inline: false }
    )
    .setThumbnail(logo || null)
    .setImage(banner || null)
    .setFooter({ text: "Dinobux • Fast & Safe" });
}

function buildPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("dinobux_open_ticket")
      .setLabel("เปิด Ticket")
      .setEmoji("🛒")
      .setStyle(ButtonStyle.Success),

    new ButtonBuilder()
      .setCustomId("dinobux_view_history")
      .setLabel("ประวัติการสั่งซื้อ")
      .setEmoji("📜")
      .setStyle(ButtonStyle.Secondary)
  );
}

async function findExistingTicket(guild, userId) {
  // ใช้ topic เพื่อกันเปิดซ้ำ (ไม่ต้องพึ่ง DB)
  const chans = await guild.channels.fetch();
  return chans.find(
    (ch) =>
      ch &&
      ch.type === ChannelType.GuildText &&
      typeof ch.topic === "string" &&
      ch.topic.includes(`DINO_TICKET:${userId}`)
  );
}

async function createTicketChannel(guild, user) {
  const categoryId = process.env.TICKET_CATEGORY_ID;
  const staffRoleId = process.env.STAFF_ROLE_ID;

  if (!categoryId || !staffRoleId) {
    throw new Error("Missing TICKET_CATEGORY_ID / STAFF_ROLE_ID in .env");
  }

  const safe = user.username.toLowerCase().replace(/[^a-z0-9ก-๙\-]/g, "-");
  const name = `ticket-${safe}-${user.id.slice(-4)}`;

  const channel = await guild.channels.create({
    name,
    type: ChannelType.GuildText,
    parent: categoryId,
    topic: `DINO_TICKET:${user.id}`, // กันเปิดซ้ำ
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionsBitField.Flags.ViewChannel] },
      {
        id: user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
        ],
      },
      {
        id: staffRoleId,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageMessages,
        ],
      },
      {
        id: client.user.id,
        allow: [
          PermissionsBitField.Flags.ViewChannel,
          PermissionsBitField.Flags.SendMessages,
          PermissionsBitField.Flags.ManageChannels,
          PermissionsBitField.Flags.ReadMessageHistory,
          PermissionsBitField.Flags.ManageMessages,
        ],
      },
    ],
  });

  const welcome = new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle("🎫 เปิด Ticket แล้ว")
    .setDescription(
      [
        `สวัสดี <@${user.id}> 👋`,
        "พิมพ์รายการที่ต้องการเติม/ปัญหาที่พบในห้องนี้ได้เลย",
        "Staff จะเข้ามาสรุปยอดและแจ้งขั้นตอนชำระเงินให้ครับ ✅",
      ].join("\n")
    );

  await channel.send({ embeds: [welcome] });
  return channel;
}

function buildHistoryEmbed(userId) {
  const db = loadDB();
  const paid = (db.orders || []).filter((o) => o.userId === userId && o.status === "PAID");
  paid.sort((a, b) => (b.paidAt || b.createdAt || 0) - (a.paidAt || a.createdAt || 0));

  const totalSpent = paid.reduce((s, o) => s + Number(o.amountBaht || 0), 0);
  const lines = paid.slice(0, 5).map((o) => `• #${o.orderNo} | ${o.amountBaht} บาท | ${fmtDate(o.paidAt || o.createdAt)}`);

  return new EmbedBuilder()
    .setColor(0x57F287)
    .setTitle("📜 ประวัติการสั่งซื้อ (Dinobux)")
    .setDescription(`💰 ยอดสะสม (จ่ายแล้ว): **${totalSpent} บาท**\n✅ จำนวนออเดอร์ที่จ่ายแล้ว: **${paid.length}**`)
    .addFields({ name: "ล่าสุด", value: lines.length ? lines.join("\n") : "ยังไม่มีประวัติ (จะมีเมื่อเราทำระบบบันทึกออเดอร์/ยืนยันจ่ายในขั้นถัดไป)" })
    .setFooter({ text: "Dinobux • History" });
}

/* =========================
   Send panel on ready
========================= */
client.once("ready", async () => {
  const channel = await client.channels.fetch(process.env.PANEL_CHANNEL_ID);
  await channel.send({ embeds: [buildDinobuxCover()], components: [buildPanelRow()] });
  console.log("Dinobux panel sent ✅");
});

/* =========================
   Button interactions
========================= */
client.on("interactionCreate", async (interaction) => {
  try {
    if (!interaction.isButton()) return;

    // 1) เปิด Ticket
    if (interaction.customId === "dinobux_open_ticket") {
      await interaction.deferReply({ ephemeral: true });

      const exist = await findExistingTicket(interaction.guild, interaction.user.id);
      if (exist) {
        return interaction.editReply(`คุณมี Ticket เปิดอยู่แล้ว: <#${exist.id}>`);
      }

      const ch = await createTicketChannel(interaction.guild, interaction.user);
      return interaction.editReply(`เปิด Ticket สำเร็จ: <#${ch.id}>`);
    }

    // 2) ประวัติการสั่งซื้อ
    if (interaction.customId === "dinobux_view_history") {
      return interaction.reply({ embeds: [buildHistoryEmbed(interaction.user.id)], ephemeral: true });
    }
  } catch (e) {
    console.error(e);
    if (interaction.isRepliable()) {
      interaction.reply({ content: `เกิดข้อผิดพลาด: ${e.message || e}`, ephemeral: true }).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);


