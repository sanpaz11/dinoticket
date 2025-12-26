require("dotenv").config();

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

const express = require("express");

/** =======================
 *  BRAND CONFIG
 *  ======================= */
const BRAND_NAME = process.env.BRAND_NAME || "Dinobux";
const NOTE_REQUIRED = process.env.NOTE_REQUIRED || "ซื้อจากร้าน dinobux ทุกครั้ง";

// สีของ Embed (ปรับได้)
const COLOR_PRIMARY = 0x00c2ff;   // ฟ้า
const COLOR_SUCCESS = 0x2ecc71;   // เขียว
const COLOR_WARNING = 0xf1c40f;   // เหลือง
const COLOR_DANGER  = 0xe74c3c;   // แดง
const COLOR_DARK    = 0x2b2d31;   // เทาเข้ม

const LOGO_URL = process.env.LOGO_URL || null;

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
} = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error("❌ Missing DISCORD_TOKEN / CLIENT_ID / GUILD_ID");
  process.exit(1);
}

/** =======================
 *  Render health endpoint
 *  ======================= */
const app = express();
app.get("/health", (_, res) => res.status(200).send("ok"));
app.listen(process.env.PORT || 3000, () => console.log("✅ Health server ready"));

/** =======================
 *  Discord client
 *  ======================= */
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages],
  partials: [Partials.Channel, Partials.Message],
});

/** =======================
 *  Slash command register
 *  ======================= */
async function registerCommands() {
  const commands = [
    {
      name: "dbx_panel",
      description: `ส่งแผงเปิด Ticket ของ ${BRAND_NAME}`,
    },
  ];

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("✅ Registered /dbx_panel");
}

/** =======================
 *  Ticket state (hidden-ish)
 *  ======================= */
const STATE_PREFIX = "DBX_STATE_V1:"; // keep same
async function getStateMessage(channel) {
  const pins = await channel.messages.fetchPinned();
  return pins.find((m) => m.content.includes(STATE_PREFIX)) || null;
}
async function loadState(channel) {
  const msg = await getStateMessage(channel);
  if (!msg) return null;
  try {
    // content is in spoiler ||...||
    const raw = msg.content.replaceAll("||", "");
    const jsonStr = raw.slice(raw.indexOf(STATE_PREFIX) + STATE_PREFIX.length);
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}
async function saveState(channel, state) {
  const msg = await getStateMessage(channel);
  const content = `||${STATE_PREFIX}${JSON.stringify(state)}||`; // spoiler กันรก
  if (msg) return msg.edit({ content });
  const created = await channel.send({ content });
  await created.pin();
  return created;
}

/** =======================
 *  Helpers
 *  ======================= */
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
  let s = 0;
  for (const it of items) s += Number(it.qty) * Number(it.unitPrice);
  return s;
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
    case "AWAITING_PAYMENT": return "⏳ AWAITING_PAYMENT";
    case "VERIFYING": return "🔍 VERIFYING";
    case "PAID": return "✅ PAID";
    case "REJECTED": return "❌ REJECTED";
    case "CLOSED": return "🔒 CLOSED";
    default: return status || "-";
  }
}

function renderItemsCompact(items) {
  if (!items.length) return "ยังไม่มีรายการ";
  return items
    .map((it, idx) => {
      const lineTotal = Number(it.qty) * Number(it.unitPrice);
      return `• **${idx + 1}. ${it.name}** — Qty **${it.qty}** × **${fmt2(it.unitPrice)}** = **${fmt2(lineTotal)}**`;
    })
    .join("\n");
}

/** =======================
 *  Embeds (สวย ๆ)
 *  ======================= */
function buildReceiptEmbed(state) {
  const subtotal = calcSubtotal(state.items);
  const { total, rounding } = ceilBaht(subtotal);

  const embed = new EmbedBuilder()
    .setColor(
      state.status === "PAID" ? COLOR_SUCCESS :
      state.status === "VERIFYING" ? COLOR_WARNING :
      state.status === "REJECTED" ? COLOR_DANGER :
      COLOR_PRIMARY
    )
    .setTitle(`🧾 ${BRAND_NAME} POS Receipt`)
    .setDescription(`**Ticket:** \`${state.ticketCode}\``)
    .addFields(
      { name: "👤 ลูกค้า", value: `<@${state.customerId}>`, inline: true },
      { name: "👨‍💼 ดูแลโดย", value: state.staffId ? `<@${state.staffId}>` : "รอ staff", inline: true },
      { name: "📌 สถานะ", value: statusBadge(state.status), inline: true },
      {
        name: "🛍️ รายการสินค้า",
        value: renderItemsCompact(state.items) || "ยังไม่มีรายการ",
      },
      {
        name: "💰 สรุปยอด",
        value:
          `Subtotal: **${fmt2(subtotal)}**\n` +
          `ปัดเศษ (ทศนิยมปัดขึ้น +1): **+${fmt2(rounding)}**\n` +
          `✅ ยอดที่ต้องชำระ: **${total} บาท**`,
        inline: false,
      },
      { name: "💳 ช่องทางชำระ", value: `**${paymentLabel(state.paymentMethod)}**`, inline: true },
      { name: "📝 โน้ตตอนโอน (บังคับ)", value: `**"${NOTE_REQUIRED}"**`, inline: true },
    )
    .setFooter({ text: `${BRAND_NAME} • ระบบใบเสร็จอัปเดตอัตโนมัติ` });

  if (LOGO_URL) embed.setThumbnail(LOGO_URL);

  if (state.slipUrl) {
    embed.addFields({ name: "🧾 สลิปล่าสุด", value: state.slipUrl });
  }

  return embed;
}

function buildWelcomeEmbed(userId) {
  const embed = new EmbedBuilder()
    .setColor(COLOR_DARK)
    .setTitle(`🎫 ยินดีต้อนรับสู่ ${BRAND_NAME} Ticket`)
    .setDescription(
      `สวัสดี <@${userId}> 👋\n` +
      `นี่คือห้อง Ticket ของคุณ ✅\n\n` +
      `**กติกาสำคัญ**\n` +
      `• ยอดชำระยึดตาม **ยอดสุทธิในใบเสร็จ** เท่านั้น\n` +
      `• ถ้ามีทศนิยม ระบบ **ปัดขึ้นเป็น +1 บาท**\n` +
      `• ตอนโอน/ชำระ ต้องใส่โน้ตว่า **"${NOTE_REQUIRED}"**\n` +
      `• ถ้าไม่มี/พิมพ์ไม่ตรง = **ต้องโอนใหม่เพื่อพิมพ์ใหม่**`
    )
    .setFooter({ text: "รอ staff เข้ามาดูแล และเพิ่มรายการให้" });

  if (LOGO_URL) embed.setThumbnail(LOGO_URL);
  return embed;
}

function buildPanelEmbed() {
  const embed = new EmbedBuilder()
    .setColor(COLOR_PRIMARY)
    .setTitle(`🛒 ${BRAND_NAME} POS • เปิด Ticket`)
    .setDescription(
      `กดปุ่มด้านล่างเพื่อเปิด Ticket สั่งซื้อ/สอบถาม\n` +
      `✅ สร้างห้องส่วนตัวให้คุณกับทีมงาน staff\n` +
      `🧾 มีใบเสร็จแบบ POS อัปเดตยอดอัตโนมัติ\n\n` +
      `📝 **ต้องใส่โน้ตตอนโอน:** "${NOTE_REQUIRED}"`
    );
  if (LOGO_URL) embed.setThumbnail(LOGO_URL);
  return embed;
}

function buildCheckInfoEmbed(state) {
  const subtotal = calcSubtotal(state.items);
  const { total, rounding } = ceilBaht(subtotal);

  const embed = new EmbedBuilder()
    .setColor(COLOR_PRIMARY)
    .setTitle(`ℹ️ เช็คข้อมูลออเดอร์`)
    .setDescription(`Ticket: \`${state.ticketCode}\``)
    .addFields(
      { name: "📌 สถานะ", value: statusBadge(state.status), inline: true },
      { name: "💳 ช่องทางจ่าย", value: paymentLabel(state.paymentMethod), inline: true },
      { name: "🧾 สลิป", value: state.slipUrl ? "มีสลิปแล้ว ✅" : "ยังไม่มีสลิป", inline: true },
      {
        name: "💰 ยอดชำระ",
        value:
          `Subtotal: ${fmt2(subtotal)}\n` +
          `ปัดเศษ: +${fmt2(rounding)}\n` +
          `✅ รวม: **${total} บาท**`,
        inline: false,
      },
      { name: "📝 โน้ตที่ต้องใส่", value: `**"${NOTE_REQUIRED}"**`, inline: false }
    );

  if (LOGO_URL) embed.setThumbnail(LOGO_URL);
  return embed;
}

/** =======================
 *  Buttons (เพิ่ม “เช็คข้อมูล”)
 *  ======================= */
function customerButtons(state) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("dbx_cust_call_staff")
      .setLabel("เรียก staff")
      .setEmoji("🔔")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("dbx_cust_check")
      .setLabel("เช็คข้อมูล")
      .setEmoji("ℹ️")
      .setStyle(ButtonStyle.Secondary),

    new ButtonBuilder()
      .setCustomId("dbx_cust_pay")
      .setLabel("ชำระเงิน")
      .setEmoji("💳")
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!state.locked),

    new ButtonBuilder()
      .setCustomId("dbx_cust_send_slip")
      .setLabel("ส่งสลิป")
      .setEmoji("📩")
      .setStyle(ButtonStyle.Success)
      .setDisabled(!state.locked || !state.paymentMethod)
  );
}

function staffButtons() {
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

/** =======================
 *  Ticket channel create/update
 *  ======================= */
async function findExistingTicket(guild, userId) {
  return (
    guild.channels.cache.find(
      (c) =>
        c.type === ChannelType.GuildText &&
        c.parentId === TICKETS_CATEGORY_ID &&
        c.topic === `DBX_TICKET:${userId}`
    ) || null
  );
}

async function updateReceipt(channel, state) {
  const receiptMsg = await channel.messages.fetch(state.receiptMessageId);
  await receiptMsg.edit({
    embeds: [buildReceiptEmbed(state)],
    components: [customerButtons(state), ...staffButtons()],
  });
  await saveState(channel, state);
}

async function createTicketChannel(guild, user) {
  const existing = await findExistingTicket(guild, user.id);
  if (existing) return existing;

  const channel = await guild.channels.create({
    name: `ticket-${user.username}`.toLowerCase().replace(/[^a-z0-9\-]/g, "-"),
    type: ChannelType.GuildText,
    parent: TICKETS_CATEGORY_ID,
    topic: `DBX_TICKET:${user.id}`,
    permissionOverwrites: [
      { id: guild.roles.everyone, deny: [PermissionFlagsBits.ViewChannel] },
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

  const state = {
    ticketCode: genTicketCode(),
    customerId: user.id,
    staffId: null,
    status: "NEW",
    locked: false,
    items: [],
    paymentMethod: null,
    slipUrl: null,
    receiptMessageId: null,
    closed: false,
  };

  // Welcome embed
  await channel.send({ embeds: [buildWelcomeEmbed(user.id)] });

  // Receipt embed (pin)
  const receipt = await channel.send({
    embeds: [buildReceiptEmbed(state)],
    components: [customerButtons(state), ...staffButtons()],
  });
  await receipt.pin();
  state.receiptMessageId = receipt.id;

  // State (pin but spoiler)
  await saveState(channel, state);

  return channel;
}

/** =======================
 *  Interactions
 *  ======================= */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // Slash: /dbx_panel
    if (interaction.isChatInputCommand()) {
      if (interaction.commandName === "dbx_panel") {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("dbx_open_ticket")
            .setLabel("เปิด Ticket สั่งซื้อ")
            .setEmoji("🛒")
            .setStyle(ButtonStyle.Primary)
        );

        await interaction.reply({ embeds: [buildPanelEmbed()], components: [row] });
      }
      return;
    }

    if (!interaction.isButton()) return;

    const { customId } = interaction;

    // Open ticket
    if (customId === "dbx_open_ticket") {
      await interaction.reply({ content: "กำลังสร้าง Ticket ให้ครับ ✅", ephemeral: true });
      const ch = await createTicketChannel(interaction.guild, interaction.user);
      await interaction.followUp({ content: `สร้าง Ticket แล้ว: ${ch}`, ephemeral: true });
      return;
    }

    // Load state for ticket actions
    const channel = interaction.channel;
    const state = await loadState(channel);
    if (!state) return interaction.reply({ content: "ไม่พบข้อมูล Ticket ในห้องนี้", ephemeral: true });

    // Customer: call staff
    if (customId === "dbx_cust_call_staff") {
      await interaction.reply({
        content: `🔔 เรียกทีมงาน <@&${STAFF_ROLE_ID}> แล้วครับ\nโปรดรอสักครู่ ทีมงานกำลังเข้ามาดูแล ✅`,
      });
      return;
    }

    // Customer: check info (ใหม่)
    if (customId === "dbx_cust_check") {
      await interaction.reply({ embeds: [buildCheckInfoEmbed(state)], ephemeral: true });
      return;
    }

    // Customer: pay
    if (customId === "dbx_cust_pay") {
      if (!state.locked) {
        return interaction.reply({ content: "ยังชำระเงินไม่ได้ ต้องให้ staff ✅ ล็อกยอด (QUOTE LOCK) ก่อน", ephemeral: true });
      }
      const subtotal = calcSubtotal(state.items);
      const { total } = ceilBaht(subtotal);

      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("dbx_pay_promptpay").setLabel("PromptPay QR").setEmoji("📱").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("dbx_pay_bank").setLabel("โอนธนาคาร").setEmoji("🏦").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("dbx_pay_truewallet").setLabel("TrueWallet").setEmoji("👛").setStyle(ButtonStyle.Primary)
      );

      const info = new EmbedBuilder()
        .setColor(COLOR_PRIMARY)
        .setTitle("💳 เลือกช่องทางชำระเงิน")
        .setDescription(
          `ยอดที่ต้องชำระ: **${total} บาท**\n\n` +
          `📝 ตอนโอน/ชำระ ต้องใส่โน้ต: **"${NOTE_REQUIRED}"**\n` +
          `❌ ถ้าไม่มี/พิมพ์ไม่ตรง = ต้องโอนใหม่`
        );

      await interaction.reply({ embeds: [info], components: [row], ephemeral: true });
      return;
    }

    // Customer: send slip
    if (customId === "dbx_cust_send_slip") {
      const info = new EmbedBuilder()
        .setColor(COLOR_WARNING)
        .setTitle("📩 ส่งสลิป")
        .setDescription(
          `แนบ “รูป/ไฟล์” สลิปในห้องนี้ได้เลย ✅\n\n` +
          `เงื่อนไขผ่านการตรวจ:\n` +
          `• ยอดต้องตรงตามใบเสร็จ\n` +
          `• สลิปต้องมีโน้ต **"${NOTE_REQUIRED}"**\n` +
          `❌ ถ้าไม่มี/พิมพ์ไม่ตรง = ต้องโอนใหม่`
        );
      await interaction.reply({ embeds: [info], ephemeral: true });
      return;
    }

    // Payment selection buttons
    if (customId === "dbx_pay_promptpay" || customId === "dbx_pay_bank" || customId === "dbx_pay_truewallet") {
      const subtotal = calcSubtotal(state.items);
      const { total } = ceilBaht(subtotal);

      if (customId === "dbx_pay_promptpay") {
        state.paymentMethod = "PROMPTPAY";
        const e = new EmbedBuilder()
          .setColor(COLOR_PRIMARY)
          .setTitle("📱 PromptPay QR")
          .setDescription(
            `ยอดที่ต้องชำระ: **${total} บาท**\n\n` +
            `📝 ใส่โน้ตตอนโอน: **"${NOTE_REQUIRED}"**\n` +
            `เสร็จแล้วกด “ส่งสลิป” และแนบรูปสลิปในห้องนี้`
          );
        await interaction.reply({ embeds: [e], ephemeral: true });
        if (PAY_QR_IMAGE_URL) await interaction.followUp({ content: PAY_QR_IMAGE_URL, ephemeral: true });
      }

      if (customId === "dbx_pay_bank") {
        state.paymentMethod = "BANK";
        const e = new EmbedBuilder()
          .setColor(COLOR_PRIMARY)
          .setTitle("🏦 โอนธนาคาร")
          .setDescription(
            `ยอดที่ต้องชำระ: **${total} บาท**\n\n` +
            `บัญชีรับเงิน:\n${BANK_TEXT || "ธนาคาร: ____\nชื่อบัญชี: ____\nเลขบัญชี: ____"}\n\n` +
            `📝 ใส่โน้ตตอนโอน: **"${NOTE_REQUIRED}"**`
          );
        await interaction.reply({ embeds: [e], ephemeral: true });
      }

      if (customId === "dbx_pay_truewallet") {
        state.paymentMethod = "TRUEWALLET";
        const e = new EmbedBuilder()
          .setColor(COLOR_PRIMARY)
          .setTitle("👛 TrueWallet")
          .setDescription(
            `ยอดที่ต้องชำระ: **${total} บาท**\n\n` +
            `${TRUEWALLET_TEXT || "เบอร์/ลิงก์รับเงิน: ____"}\n\n` +
            `📝 ใส่โน้ตตอนโอน: **"${NOTE_REQUIRED}"**`
          );
        await interaction.reply({ embeds: [e], ephemeral: true });
      }

      await saveState(channel, state);
      await updateReceipt(channel, state);
      return;
    }

    // Staff-only actions
    if (customId.startsWith("dbx_st_") || customId.startsWith("dbx_verify_")) {
      if (!isStaff(interaction.member)) {
        return interaction.reply({ content: "ปุ่มนี้ใช้ได้เฉพาะ staff", ephemeral: true });
      }
    }

    if (customId === "dbx_st_add") {
      const modal = new ModalBuilder().setCustomId("dbx_modal_add").setTitle("➕ เพิ่มรายการสินค้า (POS)");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("name").setLabel("ชื่อสินค้า").setStyle(TextInputStyle.Short).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("qty").setLabel("จำนวน (Qty)").setStyle(TextInputStyle.Short).setRequired(true)
        ),
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("unit").setLabel("ราคาต่อหน่วย (Unit Price)").setStyle(TextInputStyle.Short).setRequired(true)
        )
      );
      return interaction.showModal(modal);
    }

    if (customId === "dbx_st_edit") {
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

    if (customId === "dbx_st_del") {
      const modal = new ModalBuilder().setCustomId("dbx_modal_del").setTitle("🗑️ ลบรายการ");
      modal.addComponents(
        new ActionRowBuilder().addComponents(
          new TextInputBuilder().setCustomId("index").setLabel("ลำดับรายการที่ต้องการลบ (เช่น 1)").setStyle(TextInputStyle.Short).setRequired(true)
        )
      );
      return interaction.showModal(modal);
    }

    if (customId === "dbx_st_lock") {
      state.locked = true;
      state.status = "AWAITING_PAYMENT";
      state.staffId = state.staffId || interaction.user.id;

      const e = new EmbedBuilder()
        .setColor(COLOR_SUCCESS)
        .setTitle("✅ ล็อกยอดเรียบร้อย (QUOTE LOCK)")
        .setDescription(
          `ลูกค้าสามารถกด 💳 ชำระเงิน ได้แล้ว\n\n` +
          `📝 ย้ำอีกครั้ง: ตอนโอนต้องใส่โน้ต **"${NOTE_REQUIRED}"**`
        );

      await interaction.reply({ embeds: [e] });
      await updateReceipt(channel, state);
      return;
    }

    if (customId === "dbx_st_unlock") {
      state.locked = false;
      state.status = "CART";
      await interaction.reply({ embeds: [new EmbedBuilder().setColor(COLOR_WARNING).setTitle("🔓 ปลดล็อกยอดแล้ว").setDescription("สามารถแก้ไขรายการได้")] });
      await updateReceipt(channel, state);
      return;
    }

    if (customId === "dbx_st_verify") {
      const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("dbx_verify_ok").setLabel("สลิปถูกต้อง / เงินเข้าแล้ว").setEmoji("✅").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("dbx_verify_bad_note").setLabel("โน้ตไม่ถูกต้อง (ให้โอนใหม่)").setEmoji("📝").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("dbx_verify_bad").setLabel("สลิปไม่ถูกต้อง (ให้ส่งใหม่)").setEmoji("❌").setStyle(ButtonStyle.Secondary)
      );

      const e = new EmbedBuilder()
        .setColor(COLOR_WARNING)
        .setTitle("🔍 ตรวจสลิป (Final)")
        .setDescription(`กติกาโน้ต: ต้องมี **"${NOTE_REQUIRED}"**`);

      return interaction.reply({ embeds: [e], components: [row], ephemeral: true });
    }

    if (customId === "dbx_verify_ok" || customId === "dbx_st_paid") {
      state.status = "PAID";

      const e = new EmbedBuilder()
        .setColor(COLOR_SUCCESS)
        .setTitle("✅ ยืนยันชำระเงินเรียบร้อย")
        .setDescription("ขอบคุณที่ใช้บริการ 🎉");

      await interaction.reply({ embeds: [e] });
      await updateReceipt(channel, state);

      const logCh = await interaction.guild.channels.fetch(LOG_CHANNEL_ID);
      await logCh.send({
        content: `📌 LOG: ชำระแล้ว (${state.ticketCode}) ห้อง: ${channel}`,
        embeds: [buildReceiptEmbed(state)],
      });
      return;
    }

    if (customId === "dbx_verify_bad_note") {
      state.status = "REJECTED";

      const e = new EmbedBuilder()
        .setColor(COLOR_DANGER)
        .setTitle("❌ ไม่ผ่าน: โน้ตไม่ถูกต้อง/ไม่มีโน้ต")
        .setDescription(
          `กรุณาโอนใหม่ และใส่โน้ตว่า **"${NOTE_REQUIRED}"**\n` +
          `แล้วส่งสลิปใหม่ใน Ticket นี้`
        );

      await interaction.reply({ embeds: [e] });
      await updateReceipt(channel, state);
      return;
    }

    if (customId === "dbx_verify_bad") {
      state.status = "REJECTED";

      const e = new EmbedBuilder()
        .setColor(COLOR_DANGER)
        .setTitle("❌ สลิปไม่ถูกต้อง/ข้อมูลไม่ตรง")
        .setDescription(
          `โปรดชำระใหม่ตามยอดในใบเสร็จ และส่งสลิปใหม่อีกครั้ง\n\n` +
          `📝 ต้องมีโน้ต: "${NOTE_REQUIRED}"`
        );

      await interaction.reply({ embeds: [e] });
      await updateReceipt(channel, state);
      return;
    }

    if (customId === "dbx_st_close") {
      state.status = "CLOSED";
      state.closed = true;

      const e = new EmbedBuilder()
        .setColor(COLOR_DARK)
        .setTitle("🔒 ปิด Ticket เรียบร้อย")
        .setDescription("ขอบคุณที่ใช้บริการ ✅");

      await interaction.reply({ embeds: [e] });

      const logCh = await interaction.guild.channels.fetch(LOG_CHANNEL_ID);
      await logCh.send({
        content: `📌 LOG: ปิด Ticket (${state.ticketCode}) ห้อง: ${channel}`,
        embeds: [buildReceiptEmbed(state)],
      });

      await channel.permissionOverwrites.edit(state.customerId, { SendMessages: false });
      await updateReceipt(channel, state);

      try {
        await channel.setName(`closed-${state.ticketCode.toLowerCase()}`);
        await channel.setTopic(`DBX_CLOSED:${state.customerId}`);
      } catch {}

      return;
    }
  } catch (err) {
    console.error(err);
    if (interaction.replied || interaction.deferred) {
      interaction.followUp({ content: "เกิดข้อผิดพลาด", ephemeral: true }).catch(() => {});
    } else {
      interaction.reply({ content: "เกิดข้อผิดพลาด", ephemeral: true }).catch(() => {});
    }
  }
});

/** =======================
 *  Slip upload listener
 *  ======================= */
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    const channel = message.channel;
    const state = await loadState(channel);
    if (!state || state.closed) return;

    if (message.author.id !== state.customerId) return;

    const att = message.attachments.first();
    if (!att) return;

    if (!state.locked || !state.paymentMethod) {
      await channel.send({
        embeds: [
          new EmbedBuilder()
            .setColor(COLOR_WARNING)
            .setTitle("⚠️ ยังรับสลิปไม่ได้")
            .setDescription("กรุณารอให้ staff ล็อกยอด และเลือกช่องทางชำระเงินก่อน แล้วค่อยส่งสลิปครับ"),
        ],
      });
      return;
    }

    state.slipUrl = att.url;
    state.status = "VERIFYING";

    await saveState(channel, state);
    await updateReceipt(channel, state);

    await channel.send({
      embeds: [
        new EmbedBuilder()
          .setColor(COLOR_WARNING)
          .setTitle("🧾 รับสลิปแล้ว")
          .setDescription(
            `กำลังส่งให้ทีมงานตรวจสอบ…\n\n` +
            `🔍 <@&${STAFF_ROLE_ID}> มีสลิปใหม่ให้ตรวจในห้องนี้\n` +
            `📝 กติกาโน้ต: ต้องมี **"${NOTE_REQUIRED}"**`
          ),
      ],
    });
  } catch (e) {
    console.error(e);
  }
});

/** =======================
 *  Modals
 *  ======================= */
client.on(Events.InteractionCreate, async (interaction) => {
  try {
    if (!interaction.isModalSubmit()) return;

    const channel = interaction.channel;
    const state = await loadState(channel);
    if (!state) return interaction.reply({ content: "ไม่พบข้อมูล Ticket", ephemeral: true });
    if (!isStaff(interaction.member)) return interaction.reply({ content: "เฉพาะ staff", ephemeral: true });

    if (interaction.customId === "dbx_modal_add") {
      const name = interaction.fields.getTextInputValue("name");
      const qty = Number(interaction.fields.getTextInputValue("qty"));
      const unit = Number(interaction.fields.getTextInputValue("unit"));

      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unit) || unit < 0) {
        return interaction.reply({ content: "Qty/ราคาไม่ถูกต้อง", ephemeral: true });
      }

      state.items.push({ name, qty, unitPrice: unit });
      state.staffId = state.staffId || interaction.user.id;
      state.status = "CART";

      await interaction.reply({ content: "➕ เพิ่มรายการแล้ว ✅", ephemeral: true });
      await updateReceipt(channel, state);
      return;
    }

    if (interaction.customId === "dbx_modal_edit") {
      const idx = Number(interaction.fields.getTextInputValue("index")) - 1;
      const qty = Number(interaction.fields.getTextInputValue("qty"));
      const unit = Number(interaction.fields.getTextInputValue("unit"));

      if (!state.items[idx]) return interaction.reply({ content: "ไม่พบรายการลำดับนี้", ephemeral: true });
      if (!Number.isFinite(qty) || qty <= 0 || !Number.isFinite(unit) || unit < 0) {
        return interaction.reply({ content: "Qty/ราคาไม่ถูกต้อง", ephemeral: true });
      }

      state.items[idx].qty = qty;
      state.items[idx].unitPrice = unit;
      state.status = "CART";

      await interaction.reply({ content: "✏️ แก้ไขแล้ว ✅", ephemeral: true });
      await updateReceipt(channel, state);
      return;
    }

    if (interaction.customId === "dbx_modal_del") {
      const idx = Number(interaction.fields.getTextInputValue("index")) - 1;
      if (!state.items[idx]) return interaction.reply({ content: "ไม่พบรายการลำดับนี้", ephemeral: true });

      state.items.splice(idx, 1);
      state.status = state.items.length ? "CART" : "NEW";

      await interaction.reply({ content: "🗑️ ลบแล้ว ✅", ephemeral: true });
      await updateReceipt(channel, state);
      return;
    }
  } catch (e) {
    console.error(e);
    if (interaction.replied || interaction.deferred) {
      interaction.followUp({ content: "เกิดข้อผิดพลาด", ephemeral: true }).catch(() => {});
    } else {
      interaction.reply({ content: "เกิดข้อผิดพลาด", ephemeral: true }).catch(() => {});
    }
  }
});

/** =======================
 *  Boot
 *  ======================= */
client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

(async () => {
  // ไม่ให้ล่มทั้งบอทถ้า register พัง
  try {
    await registerCommands();
  } catch (e) {
    console.error("⚠️ registerCommands failed:", e?.message || e);
  }
  await client.login(DISCORD_TOKEN);
})();
