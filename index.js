require("dotenv").config();

const fs = require("fs");
const path = require("path");
const express = require("express");

const {
  Client,
  GatewayIntentBits,
  Partials,
  REST,
  Routes,
  PermissionFlagsBits,
  ChannelType,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  Events,
} = require("discord.js");

/* =======================
   ENV
======================= */
const {
  DISCORD_TOKEN,
  CLIENT_ID,
  GUILD_ID,
  STAFF_ROLE_ID,
  TICKETS_CATEGORY_ID,
  LOG_CHANNEL_ID,
  PAY_QR_IMAGE_URL,
  BANK_TEXT,
  TRUEWALLET_TEXT,
  BRAND_NAME,
  LOGO_URL,
  NOTE_REQUIRED,
  DATA_DIR,
} = process.env;

const BRAND = BRAND_NAME || "Dinobux";
const NOTE = NOTE_REQUIRED || "ซื้อจากร้าน dinobux ทุกครั้ง";

// สีสบายตา
const COLOR_PRIMARY = 0x1fb6ff; // ฟ้าใส
const COLOR_SOFT = 0x2b2d31;    // เทาเข้ม
const COLOR_OK = 0x22c55e;      // เขียว
const COLOR_WARN = 0xfbbf24;    // เหลือง
const COLOR_BAD = 0xef4444;     // แดง

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("❌ Missing DISCORD_TOKEN / CLIENT_ID / GUILD_ID");
  process.exit(1);
}

/* =======================
   Health server (Render)
======================= */
const app = express();
app.get("/health", (_, res) => res.status(200).send("ok"));
app.listen(process.env.PORT || 3000, () => console.log("✅ Health server ready"));

/* =======================
   Client
======================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel, Partials.Message],
});

/* =======================
   Backend state store (file)
   - ไม่โผล่ในห้อง
======================= */
const BASE_DIR = DATA_DIR || process.cwd();
const STATE_PATH = path.join(BASE_DIR, "dbx_state.json");

let DB = { tickets: {} }; // key = channelId

function ensureDirForState() {
  try {
    fs.mkdirSync(BASE_DIR, { recursive: true });
  } catch {}
}

function loadDB() {
  try {
    if (fs.existsSync(STATE_PATH)) {
      DB = JSON.parse(fs.readFileSync(STATE_PATH, "utf8"));
      if (!DB || typeof DB !== "object") DB = { tickets: {} };
      if (!DB.tickets) DB.tickets = {};
    }
  } catch {
    DB = { tickets: {} };
  }
}

let saveTimer = null;
function saveDBSoon() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      ensureDirForState();
      fs.writeFileSync(STATE_PATH, JSON.stringify(DB, null, 2), "utf8");
    } catch (e) {
      console.error("❌ save db failed:", e?.message || e);
    }
  }, 300);
}

function getTicket(channelId) {
  return DB.tickets?.[channelId] || null;
}
function setTicket(channelId, data) {
  DB.tickets[channelId] = data;
  saveDBSoon();
}
function findOpenTicketByUser(userId) {
  for (const [chId, t] of Object.entries(DB.tickets || {})) {
    if (t && t.customerId === userId && !t.closed) return { channelId: chId, ticket: t };
  }
  return null;
}

/* =======================
   Utils
======================= */
function isStaff(member) {
  return member?.roles?.cache?.has(STAFF_ROLE_ID);
}

function genTicketCode() {
  return `T-${Math.floor(10000 + Math.random() * 90000)}`;
}

function fmt2(n) {
  return Number(n).toFixed(2);
}

function calcSubtotal(items) {
  return (items || []).reduce((acc, it) => acc + Number(it.qty) * Number(it.unitPrice), 0);
}

function ceilBaht(subtotal) {
  const total = Math.ceil(subtotal);
  const rounding = +(total - subtotal).toFixed(2);
  return { total, rounding };
}

function paymentLabel(method) {
  if (method === "PROMPTPAY") return "📱 PromptPay QR";
  if (method === "BANK") return "🏦 โอนธนาคาร";
  if (method === "TRUEWALLET") return "👛 TrueWallet";
  return "ยังไม่เลือก";
}

function statusBadge(status) {
  switch (status) {
    case "NEW": return "🟦 NEW";
    case "CART": return "🛒 CART";
    case "AWAITING_PAYMENT": return "⏳ AWAITING PAYMENT";
    case "VERIFYING": return "🔍 VERIFYING";
    case "PAID": return "✅ PAID";
    case "REJECTED": return "❌ REJECTED";
    case "CLOSED": return "🔒 CLOSED";
    default: return status || "-";
  }
}

function embedFooter(embed) {
  // โลโก้ “ข้างล่าง” (footer icon)
  if (LOGO_URL) embed.setFooter({ text: `${BRAND} • Ticket Counter`, iconURL: LOGO_URL });
  else embed.setFooter({ text: `${BRAND} • Ticket Counter` });
  return embed;
}

function renderItems(items) {
  if (!items?.length) return "— ยังไม่มีรายการ (รอ staff เพิ่มรายการ) —";
  return items
    .map((it, i) => {
      const line = Number(it.qty) * Number(it.unitPrice);
      return `• **${i + 1}. ${it.name}**  \n  Qty **${it.qty}** × **${fmt2(it.unitPrice)}** = **${fmt2(line)}**`;
    })
    .join("\n");
}

/* =======================
   Embeds (Modern / Comfort)
======================= */
function buildOpenPanelEmbed() {
  const e = new EmbedBuilder()
    .setColor(COLOR_PRIMARY)
    .setTitle(`🛒 ${BRAND} • เปิด Ticket`)
    .setDescription(
      `กดปุ่มด้านล่างเพื่อเปิด Ticket สั่งซื้อ/สอบถาม\n\n` +
      `✅ ห้องส่วนตัว (คุณ + staff)\n` +
      `🧾 ใบเสร็จแบบ POS อัปเดตยอดอัตโนมัติ\n` +
      `💳 เลือกจ่าย: PromptPay / โอนธนาคาร / TrueWallet\n\n` +
      `📝 **โน้ตตอนโอน (บังคับ):** "${NOTE}"`
    )
    .setTimestamp();

  if (LOGO_URL) e.setThumbnail(LOGO_URL);
  return embedFooter(e);
}

function buildWelcomeEmbed(userId, ticketCode) {
  const e = new EmbedBuilder()
    .setColor(COLOR_SOFT)
    .setTitle(`✅ Ticket Created`)
    .setDescription(
      `สวัสดี <@${userId}> 👋\n` +
      `Ticket ของคุณพร้อมแล้ว\n\n` +
      `**ขั้นตอน**\n` +
      `1) รอ staff เพิ่มรายการในใบเสร็จ\n` +
      `2) staff กด “ล็อกยอด” แล้วคุณกด “เลือกชำระเงิน”\n` +
      `3) ชำระตามยอด และ **ใส่โน้ต** "${NOTE}"\n` +
      `4) แนบสลิป แล้วรอ staff ตรวจสอบ\n\n` +
      `Ticket: \`${ticketCode}\``
    )
    .setTimestamp();

  if (LOGO_URL) e.setThumbnail(LOGO_URL);
  return embedFooter(e);
}

function buildReceiptEmbed(t) {
  const subtotal = calcSubtotal(t.items);
  const { total, rounding } = ceilBaht(subtotal);

  const color =
    t.status === "PAID" ? COLOR_OK :
    t.status === "VERIFYING" ? COLOR_WARN :
    t.status === "REJECTED" ? COLOR_BAD :
    COLOR_PRIMARY;

  const e = new EmbedBuilder()
    .setColor(color)
    .setTitle(`🧾 ${BRAND} • POS Receipt`)
    .setDescription(`Ticket: \`${t.ticketCode}\``)
    .addFields(
      { name: "👤 ลูกค้า", value: `<@${t.customerId}>`, inline: true },
      { name: "👨‍💼 ดูแลโดย", value: t.staffId ? `<@${t.staffId}>` : "รอ staff", inline: true },
      { name: "📌 สถานะ", value: statusBadge(t.status), inline: true },
      { name: "🛍️ รายการ", value: renderItems(t.items) },
      {
        name: "💰 สรุปยอด",
        value:
          `Subtotal: **${fmt2(subtotal)}**\n` +
          `ปัดเศษ (ทศนิยมปัดขึ้น +1): **+${fmt2(rounding)}**\n` +
          `✅ ยอดที่ต้องชำระ: **${total} บาท**`,
      },
      { name: "💳 ช่องทางชำระ", value: `**${paymentLabel(t.paymentMethod)}**`, inline: true },
      { name: "📝 โน้ตตอนโอน (บังคับ)", value: `**"${NOTE}"**`, inline: true }
    )
    .setTimestamp();

  if (t.slipUrl) e.addFields({ name: "🧾 สลิปล่าสุด", value: t.slipUrl });
  if (LOGO_URL) e.setThumbnail(LOGO_URL);
  return embedFooter(e);
}

function buildCheckInfoEmbed(t) {
  const subtotal = calcSubtotal(t.items);
  const { total, rounding } = ceilBaht(subtotal);

  const e = new EmbedBuilder()
    .setColor(COLOR_PRIMARY)
    .setTitle("ℹ️ เช็คข้อมูลออเดอร์")
    .setDescription(`Ticket: \`${t.ticketCode}\``)
    .addFields(
      { name: "📌 สถานะ", value: statusBadge(t.status), inline: true },
      { name: "💳 ช่องทางจ่าย", value: paymentLabel(t.paymentMethod), inline: true },
      { name: "🧾 สลิป", value: t.slipUrl ? "มีสลิปแล้ว ✅" : "ยังไม่มีสลิป", inline: true },
      {
        name: "💰 ยอดชำระ",
        value:
          `Subtotal: ${fmt2(subtotal)}\n` +
          `ปัดเศษ: +${fmt2(rounding)}\n` +
          `✅ รวม: **${total} บาท**`,
      },
      { name: "📝 โน้ตที่ต้องใส่", value: `**"${NOTE}"**` }
    )
    .setTimestamp();

  if (LOGO_URL) e.setThumbnail(LOGO_URL);
  return embedFooter(e);
}

/* =======================
   Components
   - ลูกค้าเห็นแค่ของลูกค้า
   - staff ใช้ /dbx_staff เป็น panel หลังบ้าน
======================= */
function customerRow(t) {
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dbx_cust_call_staff").setLabel("เรียก staff").setEmoji("🔔").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("dbx_cust_check").setLabel("เช็คข้อมูล").setEmoji("ℹ️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("dbx_cust_pay").setLabel("เลือกชำระเงิน").setEmoji("💳").setStyle(ButtonStyle.Primary).setDisabled(!t.locked),
    new ButtonBuilder().setCustomId("dbx_cust_slip").setLabel("ส่งสลิป").setEmoji("📩").setStyle(ButtonStyle.Success).setDisabled(!t.locked || !t.paymentMethod)
  );
  return row;
}

function payMethodRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dbx_pay_PROMPTPAY").setLabel("PromptPay QR").setEmoji("📱").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("dbx_pay_BANK").setLabel("โอนธนาคาร").setEmoji("🏦").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("dbx_pay_TRUEWALLET").setLabel("TrueWallet").setEmoji("👛").setStyle(ButtonStyle.Primary)
  );
}

// staff panel (ephemeral)
function staffPanelRows() {
  const row1 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dbx_st_add").setLabel("เพิ่มรายการ").setEmoji("➕").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("dbx_st_edit").setLabel("แก้ไข").setEmoji("✏️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("dbx_st_del").setLabel("ลบ").setEmoji("🗑️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("dbx_st_lock").setLabel("ล็อกยอด").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("dbx_st_unlock").setLabel("ปลดล็อก").setEmoji("🔓").setStyle(ButtonStyle.Danger)
  );

  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId("dbx_st_verify").setLabel("ตรวจสลิป").setEmoji("🔍").setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId("dbx_st_paid").setLabel("ชำระแล้ว").setEmoji("✅").setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId("dbx_st_close").setLabel("ปิด Ticket").setEmoji("🔒").setStyle(ButtonStyle.Danger)
  );

  return [row1, row2];
}

/* =======================
   Receipt message update
======================= */
async function updateReceipt(channel, t) {
  const msg = await channel.messages.fetch(t.receiptMessageId);
  await msg.edit({ embeds: [buildReceiptEmbed(t)], components: [customerRow(t)] });
  t.updatedAt = Date.now();
  setTicket(channel.id, t);
}

/* =======================
   Ticket create
======================= */
async function createTicketChannel(guild, user) {
  // กันเปิดซ้ำ
  const existing = findOpenTicketByUser(user.id);
  if (existing) {
    const ch = guild.channels.cache.get(existing.channelId);
    if (ch) return ch;
  }

  const ticketCode = genTicketCode();

  const channel = await guild.channels.create({
    name: `ticket-${user.username}`.toLowerCase().replace(/[^a-z0-9\-]/g, "-"),
    type: ChannelType.GuildText,
    parent: TICKETS_CATEGORY_ID,
    topic: `DBX_TICKET:${user.id}`, // ไม่ต้องใส่ state
    permissionOverwrites: [
      { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
      {
        id: user.id,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
      {
        id: STAFF_ROLE_ID,
        allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory],
      },
      {
        id: client.user.id,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ManageChannels,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageMessages,
        ],
      },
    ],
  });

  const t = {
    ticketCode,
    customerId: user.id,
    staffId: null,
    status: "NEW",
    locked: false,
    items: [],
    paymentMethod: null,
    slipUrl: null,
    receiptMessageId: null,
    closed: false,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };

  // ✅ ไม่แท็ก staff ตอนเปิด ticket
  await channel.send({ embeds: [buildWelcomeEmbed(user.id, ticketCode)] });

  const receipt = await channel.send({ embeds: [buildReceiptEmbed(t)], components: [customerRow(t)] });
  await receipt.pin();

  t.receiptMessageId = receipt.id;
  setTicket(channel.id, t);

  // log แบบไม่ ping
  try {
    const logCh = await guild.channels.fetch(LOG_CHANNEL_ID);
    if (logCh) {
      const e = new EmbedBuilder()
        .setColor(COLOR_SOFT)
        .setTitle("🧾 New Ticket")
        .setDescription(`Ticket: \`${ticketCode}\`\nห้อง: ${channel}\nลูกค้า: <@${user.id}>`)
        .setTimestamp();
      embedFooter(e);
      await logCh.send({ embeds: [e] });
    }
  } catch {}

  return channel;
}

/* =======================
   Slash commands
======================= */
async function registerCommands() {
  const commands = [
    { name: "dbx_panel", description: `ส่งแผงเปิด Ticket ของ ${BRAND}` },
    { name: "dbx_staff", description: "เปิดแผงควบคุม staff (ใช้ในห้อง ticket เท่านั้น)" },
  ];

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("✅ Registered /dbx_panel, /dbx_staff");
}

/* =======================
   Interaction handler
======================= */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Slash
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "dbx_panel") {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("dbx_open_ticket").setLabel("เปิด Ticket").setEmoji("🛒").setStyle(ButtonStyle.Primary)
        );
        return interaction.reply({ embeds: [buildOpenPanelEmbed()], components: [row] });
      }

      if (interaction.commandName === "dbx_staff") {
        if (!isStaff(interaction.member)) return interaction.reply({ content: "เฉพาะ staff เท่านั้น", ephemeral: true });

        const t = getTicket(interaction.channelId);
        if (!t) return interaction.reply({ content: "ห้องนี้ไม่ใช่ ticket หรือยังไม่มีข้อมูล", ephemeral: true });

        const e = new EmbedBuilder()
          .setColor(COLOR_PRIMARY)
          .setTitle("🧑‍💼 Staff Control Panel")
          .setDescription(`Ticket: \`${t.ticketCode}\`\nสถานะ: ${statusBadge(t.status)}`)
          .setTimestamp();
        embedFooter(e);

        return interaction.reply({ embeds: [e], components: staffPanelRows(), ephemeral: true });
      }
      return;
    }

    if (!interaction.isButton()) return;

    const id = interaction.customId;

    // เปิด ticket
    if (id === "dbx_open_ticket") {
      await interaction.deferReply({ ephemeral: true });
      const ch = await createTicketChannel(interaction.guild, interaction.user);
      return interaction.editReply({ content: `✅ สร้าง Ticket แล้ว: ${ch}` });
    }

    // ต้องมี ticket state สำหรับปุ่มอื่น
    const t = getTicket(interaction.channelId);
    if (!t) return interaction.reply({ content: "ไม่พบข้อมูล Ticket ในห้องนี้", ephemeral: true });

    /* -------- Customer buttons -------- */
    if (id === "dbx_cust_call_staff") {
      // ✅ Ping staff เฉพาะตอนลูกค้ากดเรียก
      const e = new EmbedBuilder()
        .setColor(COLOR_PRIMARY)
        .setTitle("🔔 แจ้งทีมงาน")
        .setDescription(`เรียกทีมงานแล้วครับ <@&${STAFF_ROLE_ID}> \nโปรดรอสักครู่ ✅`)
        .setTimestamp();
      embedFooter(e);

      return interaction.reply({ embeds: [e] });
    }

    if (id === "dbx_cust_check") {
      return interaction.reply({ embeds: [buildCheckInfoEmbed(t)], ephemeral: true });
    }

    if (id === "dbx_cust_pay") {
      if (!t.locked) return interaction.reply({ content: "ยังชำระไม่ได้ ต้องให้ staff ล็อกยอดก่อน", ephemeral: true });

      const subtotal = calcSubtotal(t.items);
      const { total } = ceilBaht(subtotal);

      const e = new EmbedBuilder()
        .setColor(COLOR_PRIMARY)
        .setTitle("💳 เลือกช่องทางชำระเงิน")
        .setDescription(
          `ยอดที่ต้องชำระ: **${total} บาท**\n\n` +
          `📝 **ต้องใส่โน้ตตอนโอน:** "${NOTE}"\n` +
          `❌ ถ้าไม่มี/พิมพ์ไม่ตรง = ต้องโอนใหม่`
        )
        .setTimestamp();
      embedFooter(e);

      return interaction.reply({ embeds: [e], components: [payMethodRow()], ephemeral: true });
    }

    if (id === "dbx_cust_slip") {
      const e = new EmbedBuilder()
        .setColor(COLOR_WARN)
        .setTitle("📩 ส่งสลิป")
        .setDescription(
          `แนบ “รูป/ไฟล์” สลิปในห้องนี้ได้เลย ✅\n\n` +
          `เงื่อนไขผ่านการตรวจ:\n` +
          `• ยอดต้องตรงตามใบเสร็จ\n` +
          `• สลิปต้องมีโน้ต **"${NOTE}"**\n` +
          `❌ ถ้าไม่มี/พิมพ์ไม่ตรง = staff จะให้โอนใหม่`
        )
        .setTimestamp();
      embedFooter(e);

      return interaction.reply({ embeds: [e], ephemeral: true });
    }

    // เลือกช่องทางจ่าย
    if (id.startsWith("dbx_pay_")) {
      const method = id.replace("dbx_pay_", "");
      t.paymentMethod = method;
      t.updatedAt = Date.now();
      setTicket(interaction.channelId, t);

      await updateReceipt(interaction.channel, t);

      const subtotal = calcSubtotal(t.items);
      const { total } = ceilBaht(subtotal);

      if (method === "PROMPTPAY") {
        const e = new EmbedBuilder()
          .setColor(COLOR_PRIMARY)
          .setTitle("📱 PromptPay QR")
          .setDescription(
            `ยอดที่ต้องชำระ: **${total} บาท**\n\n` +
            `📝 ใส่โน้ต: "${NOTE}"\n` +
            `เสร็จแล้วแนบสลิปในห้องนี้`
          )
          .setTimestamp();

        if (PAY_QR_IMAGE_URL) e.setImage(PAY_QR_IMAGE_URL);
        embedFooter(e);

        return interaction.reply({ embeds: [e], ephemeral: true });
      }

      if (method === "BANK") {
        const e = new EmbedBuilder()
          .setColor(COLOR_PRIMARY)
          .setTitle("🏦 โอนธนาคาร")
          .setDescription(
            `ยอดที่ต้องชำระ: **${total} บาท**\n\n` +
            `${BANK_TEXT || "ธนาคาร: ____\nชื่อบัญชี: ____\nเลขบัญชี: ____"}\n\n` +
            `📝 ใส่โน้ต: "${NOTE}"`
          )
          .setTimestamp();
        embedFooter(e);

        return interaction.reply({ embeds: [e], ephemeral: true });
      }

      if (method === "TRUEWALLET") {
        const e = new EmbedBuilder()
          .setColor(COLOR_PRIMARY)
          .setTitle("👛 TrueWallet")
          .setDescription(
            `ยอดที่ต้องชำระ: **${total} บาท**\n\n` +
            `${TRUEWALLET_TEXT || "เบอร์/ลิงก์รับเงิน: ____"}\n\n` +
            `📝 ใส่โน้ต: "${NOTE}"`
          )
          .setTimestamp();
        embedFooter(e);

        return interaction.reply({ embeds: [e], ephemeral: true });
      }
    }

    /* -------- Staff buttons (only via /dbx_staff but still protect) -------- */
    if (id.startsWith("dbx_st_") || id.startsWith("dbx_verify_")) {
      if (!isStaff(interaction.member)) return interaction.reply({ content: "เฉพาะ staff", ephemeral: true });
    }

    if (id === "dbx_st_add") {
      const modal = new ModalBuilder().setCustomId("dbx_modal_add").setTitle("➕ เพิ่มรายการ (POS)");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("name").setLabel("ชื่อสินค้า").setStyle(TextInputStyle.Short).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("qty").setLabel("จำนวน (Qty)").setStyle(TextInputStyle.Short).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("unit").setLabel("ราคาต่อหน่วย").setStyle(TextInputStyle.Short).setRequired(true)
        )
      );
      return interaction.showModal(modal);
    }

    if (id === "dbx_st_edit") {
      const modal = new ModalBuilder().setCustomId("dbx_modal_edit").setTitle("✏️ แก้ไขรายการ");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("index").setLabel("ลำดับรายการ (เช่น 1)").setStyle(TextInputStyle.Short).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("qty").setLabel("จำนวนใหม่ (Qty)").setStyle(TextInputStyle.Short).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("unit").setLabel("ราคาต่อหน่วยใหม่").setStyle(TextInputStyle.Short).setRequired(true)
        )
      );
      return interaction.showModal(modal);
    }

    if (id === "dbx_st_del") {
      const modal = new ModalBuilder().setCustomId("dbx_modal_del").setTitle("🗑️ ลบรายการ");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("index").setLabel("ลำดับรายการที่ต้องการลบ").setStyle(TextInputStyle.Short).setRequired(true)
        )
      );
      return interaction.showModal(modal);
    }

    if (id === "dbx_st_lock") {
      t.locked = true;
      t.status = "AWAITING_PAYMENT";
      t.staffId = t.staffId || interaction.user.id;
      setTicket(interaction.channelId, t);
      await updateReceipt(interaction.channel, t);

      const e = new EmbedBuilder()
        .setColor(COLOR_OK)
        .setTitle("✅ ล็อกยอดแล้ว")
        .setDescription("ลูกค้าสามารถกด “เลือกชำระเงิน” ได้แล้ว")
        .setTimestamp();
      embedFooter(e);

      return interaction.reply({ embeds: [e], ephemeral: true });
    }

    if (id === "dbx_st_unlock") {
      t.locked = false;
      t.status = "CART";
      setTicket(interaction.channelId, t);
      await updateReceipt(interaction.channel, t);

      return interaction.reply({ content: "🔓 ปลดล็อกยอดแล้ว", ephemeral: true });
    }

    if (id === "dbx_st_verify") {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("dbx_verify_ok").setLabel("สลิปถูกต้อง/เงินเข้า").setEmoji("✅").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("dbx_verify_bad_note").setLabel("โน้ตไม่ถูกต้อง (โอนใหม่)").setEmoji("📝").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("dbx_verify_bad").setLabel("สลิปไม่ถูกต้อง (ส่งใหม่)").setEmoji("❌").setStyle(ButtonStyle.Secondary)
      );

      const e = new EmbedBuilder()
        .setColor(COLOR_WARN)
        .setTitle("🔍 ตรวจสลิป (Final)")
        .setDescription(`ต้องมีโน้ต: **"${NOTE}"**`)
        .setTimestamp();
      embedFooter(e);

      return interaction.reply({ embeds: [e], components: [row], ephemeral: true });
    }

    if (id === "dbx_verify_ok" || id === "dbx_st_paid") {
      t.status = "PAID";
      setTicket(interaction.channelId, t);
      await updateReceipt(interaction.channel, t);

      // log
      try {
        const logCh = await interaction.guild.channels.fetch(LOG_CHANNEL_ID);
        if (logCh) await logCh.send({ content: `📌 LOG: ชำระแล้ว (${t.ticketCode}) ห้อง: ${interaction.channel}`, embeds: [buildReceiptEmbed(t)] });
      } catch {}

      return interaction.reply({ content: "✅ ยืนยันชำระเงินแล้ว", ephemeral: true });
    }

    if (id === "dbx_verify_bad_note") {
      t.status = "REJECTED";
      setTicket(interaction.channelId, t);
      await updateReceipt(interaction.channel, t);

      const e = new EmbedBuilder()
        .setColor(COLOR_BAD)
        .setTitle("❌ ไม่ผ่าน: โน้ตไม่ถูกต้อง/ไม่มีโน้ต")
        .setDescription(`ให้ลูกค้าโอนใหม่ และใส่โน้ต: "${NOTE}"`)
        .setTimestamp();
      embedFooter(e);

      await interaction.channel.send({ embeds: [e] });
      return interaction.reply({ content: "ตั้งสถานะ REJECTED แล้ว", ephemeral: true });
    }

    if (id === "dbx_verify_bad") {
      t.status = "REJECTED";
      setTicket(interaction.channelId, t);
      await updateReceipt(interaction.channel, t);

      const e = new EmbedBuilder()
        .setColor(COLOR_BAD)
        .setTitle("❌ สลิปไม่ถูกต้อง/ข้อมูลไม่ตรง")
        .setDescription("ให้ลูกค้าชำระใหม่ตามยอด และส่งสลิปใหม่")
        .setTimestamp();
      embedFooter(e);

      await interaction.channel.send({ embeds: [e] });
      return interaction.reply({ content: "ตั้งสถานะ REJECTED แล้ว", ephemeral: true });
    }

    if (id === "dbx_st_close") {
      t.status = "CLOSED";
      t.closed = true;
      setTicket(interaction.channelId, t);
      await updateReceipt(interaction.channel, t);

      try {
        await interaction.channel.permissionOverwrites.edit(t.customerId, { SendMessages: false });
      } catch {}

      try {
        await interaction.channel.setName(`closed-${t.ticketCode.toLowerCase()}`);
        await interaction.channel.setTopic(`DBX_CLOSED:${t.customerId}`);
      } catch {}

      // log
      try {
        const logCh = await interaction.guild.channels.fetch(LOG_CHANNEL_ID);
        if (logCh) await logCh.send({ content: `📌 LOG: ปิด Ticket (${t.ticketCode}) ห้อง: ${interaction.channel}`, embeds: [buildReceiptEmbed(t)] });
      } catch {}

      return interaction.reply({ content: "🔒 ปิด Ticket แล้ว", ephemeral: true });
    }
  } catch (err) {
    console.error(err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: "เกิดข้อผิดพลาด", ephemeral: true });
      } else {
        await interaction.reply({ content: "เกิดข้อผิดพลาด", ephemeral: true });
      }
    } catch {}
  }
});

/* =======================
   Modals (staff)
======================= */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isModalSubmit()) return;
    if (!isStaff(interaction.member)) return interaction.reply({ content: "เฉพาะ staff", ephemeral: true });

    const t = getTicket(interaction.channelId);
    if (!t) return interaction.reply({ content: "ไม่พบข้อมูล Ticket", ephemeral: true });

    if (interaction.customId === "dbx_modal_add") {
      const name = interaction.fields.getTextInputValue("name");
      const qty = Number(interaction.fields.getTextInputValue("qty"));
      const unit = Number(interaction.fields.getTextInputValue("unit"));
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unit) || unit < 0) {
        return interaction.reply({ content: "Qty/ราคาไม่ถูกต้อง", ephemeral: true });
      }
      t.items.push({ name, qty, unitPrice: unit });
      t.staffId = t.staffId || interaction.user.id;
      t.status = "CART";
      setTicket(interaction.channelId, t);
      await updateReceipt(interaction.channel, t);
      return interaction.reply({ content: "➕ เพิ่มรายการแล้ว", ephemeral: true });
    }

    if (interaction.customId === "dbx_modal_edit") {
      const idx = Number(interaction.fields.getTextInputValue("index")) - 1;
      const qty = Number(interaction.fields.getTextInputValue("qty"));
      const unit = Number(interaction.fields.getTextInputValue("unit"));

      if (!t.items[idx]) return interaction.reply({ content: "ไม่พบรายการลำดับนี้", ephemeral: true });
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unit) || unit < 0) {
        return interaction.reply({ content: "Qty/ราคาไม่ถูกต้อง", ephemeral: true });
      }

      t.items[idx].qty = qty;
      t.items[idx].unitPrice = unit;
      t.status = "CART";
      setTicket(interaction.channelId, t);
      await updateReceipt(interaction.channel, t);
      return interaction.reply({ content: "✏️ แก้ไขแล้ว", ephemeral: true });
    }

    if (interaction.customId === "dbx_modal_del") {
      const idx = Number(interaction.fields.getTextInputValue("index")) - 1;
      if (!t.items[idx]) return interaction.reply({ content: "ไม่พบรายการลำดับนี้", ephemeral: true });

      t.items.splice(idx, 1);
      t.status = t.items.length ? "CART" : "NEW";
      setTicket(interaction.channelId, t);
      await updateReceipt(interaction.channel, t);
      return interaction.reply({ content: "🗑️ ลบแล้ว", ephemeral: true });
    }
  } catch (err) {
    console.error(err);
    try {
      if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ content: "เกิดข้อผิดพลาด", ephemeral: true });
      } else {
        await interaction.reply({ content: "เกิดข้อผิดพลาด", ephemeral: true });
      }
    } catch {}
  }
});

/* =======================
   Slip upload listener
   - ping staff เฉพาะตอนมีสลิป
======================= */
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    const t = getTicket(message.channel.id);
    if (!t || t.closed) return;

    // รับสลิปเฉพาะเจ้าของ ticket
    if (message.author.id !== t.customerId) return;

    const att = message.attachments.first();
    if (!att) return;

    if (!t.locked || !t.paymentMethod) {
      const e = new EmbedBuilder()
        .setColor(COLOR_WARN)
        .setTitle("⚠️ ยังรับสลิปไม่ได้")
        .setDescription("กรุณารอให้ staff ล็อกยอด และเลือกช่องทางชำระเงินก่อน แล้วค่อยส่งสลิปครับ")
        .setTimestamp();
      embedFooter(e);
      await message.channel.send({ embeds: [e] });
      return;
    }

    t.slipUrl = att.url;
    t.status = "VERIFYING";
    setTicket(message.channel.id, t);
    await updateReceipt(message.channel, t);

    const e = new EmbedBuilder()
      .setColor(COLOR_WARN)
      .setTitle("🧾 รับสลิปแล้ว")
      .setDescription(
        `ส่งให้ทีมงานตรวจสอบแล้ว ✅\n\n` +
        `🔍 <@&${STAFF_ROLE_ID}> มีสลิปใหม่ให้ตรวจในห้องนี้\n` +
        `📝 โน้ตต้องมี: "${NOTE}"`
      )
      .setTimestamp();
    embedFooter(e);

    await message.channel.send({ embeds: [e] });
  } catch (e) {
    console.error(e);
  }
});

/* =======================
   Boot
======================= */
client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

(async () => {
  loadDB();
  try {
    await registerCommands();
  } catch (e) {
    console.error("⚠️ registerCommands failed:", e?.message || e);
  }
  await client.login(DISCORD_TOKEN);
})();
