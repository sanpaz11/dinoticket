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
 *  CONFIG (แก้ได้จาก ENV)
 *  ======================= */
const NOTE_REQUIRED = 'ซื้อจากร้าน dinobux ทุกครั้ง';

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
      description: "ส่งแผงเปิด Ticket ของ Dinobux (ใช้ในห้อง #🧾-open-ticket)",
    },
  ];

  const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), { body: commands });
  console.log("✅ Registered /dbx_panel");
}

/** =======================
 *  Ticket state (pinned msg)
 *  ======================= */
const STATE_PREFIX = "DBX_STATE_V1:";

async function getStateMessage(channel) {
  const pins = await channel.messages.fetchPinned();
  return pins.find((m) => m.content.startsWith(STATE_PREFIX)) || null;
}

async function loadState(channel) {
  const msg = await getStateMessage(channel);
  if (!msg) return null;
  try {
    return JSON.parse(msg.content.slice(STATE_PREFIX.length));
  } catch {
    return null;
  }
}

async function saveState(channel, state) {
  const msg = await getStateMessage(channel);
  const content = `${STATE_PREFIX}${JSON.stringify(state)}`;
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

function fmt2(n) {
  return Number(n).toFixed(2);
}

function renderItems(items) {
  if (!items.length) return "ยังไม่มีรายการ — รอทีมงาน staff เพิ่มสินค้าเข้าตะกร้า";
  return items
    .map((it, idx) => {
      const lineTotal = Number(it.qty) * Number(it.unitPrice);
      return `${idx + 1}) ${it.name}\n   Qty ${it.qty} × ${fmt2(it.unitPrice)} = ${fmt2(lineTotal)}`;
    })
    .join("\n\n");
}

function buildReceiptEmbed(state) {
  const subtotal = calcSubtotal(state.items);
  const { total, rounding } = ceilBaht(subtotal);

  const staffText = state.staffId ? `<@${state.staffId}>` : "(รอ staff)";
  const payment =
    state.paymentMethod === "PROMPTPAY"
      ? "📱 PromptPay QR"
      : state.paymentMethod === "BANK"
      ? "🏦 โอนธนาคาร"
      : state.paymentMethod === "TRUEWALLET"
      ? "👛 TrueWallet"
      : "ยังไม่เลือก";

  const embed = new EmbedBuilder()
    .setTitle(`🧾 Dinobux POS Receipt • (${state.ticketCode})`)
    .addFields(
      { name: "👤 ลูกค้า", value: `<@${state.customerId}>`, inline: true },
      { name: "👨‍💼 ดูแลโดย", value: staffText, inline: true },
      { name: "📌 สถานะ", value: state.status, inline: true },
      { name: "รายการสินค้า", value: renderItems(state.items) },
      {
        name: "สรุปยอด",
        value:
          `Subtotal: ${fmt2(subtotal)}\n` +
          `ปัดเศษ (ทศนิยมปัดขึ้น +1): +${fmt2(rounding)}\n` +
          `✅ ยอดที่ต้องชำระ: **${total} บาท**`,
      },
      { name: "ช่องทางชำระ", value: payment, inline: true },
      { name: "📌 โน้ต/หมายเหตุที่ต้องใส่ตอนโอน (บังคับ)", value: `**"${NOTE_REQUIRED}"**` }
    );

  if (state.slipUrl) {
    embed.addFields({ name: "🧾 สลิปล่าสุด", value: state.slipUrl });
  }

  return embed;
}

function customerButtons(state) {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("dbx_cust_call_staff")
      .setLabel("เรียก staff")
      .setEmoji("🔔")
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
    new ButtonBuilder().setCustomId("dbx_st_edit").setLabel("แก้ไขรายการ").setEmoji("✏️").setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId("dbx_st_del").setLabel("ลบรายการ").setEmoji("🗑️").setStyle(ButtonStyle.Secondary),
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

async function updateReceipt(channel, state) {
  const receiptMsg = await channel.messages.fetch(state.receiptMessageId);
  await receiptMsg.edit({
    embeds: [buildReceiptEmbed(state)],
    components: [customerButtons(state), ...staffButtons()],
  });
  await saveState(channel, state);
}

/** =======================
 *  Open-ticket panel
 *  ======================= */
function buildOpenPanelEmbed() {
  return new EmbedBuilder()
    .setTitle("🛒 Dinobux POS • เปิด Ticket")
    .setDescription(
      "ยินดีต้อนรับสู่ Dinobux 🎫\n" +
        "กดปุ่มด้านล่างเพื่อเปิด Ticket สั่งซื้อ/สอบถาม\n" +
        "✅ ระบบจะสร้างห้องส่วนตัวให้คุณกับทีมงาน staff\n" +
        "🧾 ทุกออเดอร์จะมี “ใบเสร็จแบบ POS” ที่อัปเดตยอดอัตโนมัติ\n\n" +
        "📌 กติกาการชำระเงินของร้าน:\n" +
        `✅ ตอนโอน/ชำระ ต้องใส่โน้ต/หมายเหตุว่า **"${NOTE_REQUIRED}"**\n` +
        "❌ ถ้าไม่มี/พิมพ์ไม่ตรง = ต้องโอนใหม่"
    );
}

function buildOpenPanelRow() {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId("dbx_open_ticket")
      .setLabel("เปิด Ticket สั่งซื้อ")
      .setEmoji("🛒")
      .setStyle(ButtonStyle.Primary)
  );
}

/** =======================
 *  Create ticket channel
 *  ======================= */
async function findExistingTicket(guild, userId) {
  // หา ticket ที่ยังไม่ปิด โดยเช็ค topic
  const ch = guild.channels.cache.find(
    (c) =>
      c.type === ChannelType.GuildText &&
      c.parentId === TICKETS_CATEGORY_ID &&
      c.topic === `DBX_TICKET:${userId}`
  );
  return ch || null;
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

  const ticketCode = genTicketCode();
  const state = {
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
  };

  // Message #2 (ต้อนรับ + กติกา)
  await channel.send({
    content:
      `สวัสดี <@${user.id}> 👋\n` +
      `นี่คือห้อง Ticket ของคุณ ✅\n` +
      `โปรดรอทีมงาน staff เข้ามาดูแล และออกใบเสร็จให้\n\n` +
      `📌 กติกา:\n` +
      `- ยอดชำระจะยึดตาม **ยอดสุทธิในใบเสร็จ** เท่านั้น\n` +
      `- ถ้ามีทศนิยม ระบบจะ **ปัดขึ้นเป็น +1 บาท** อัตโนมัติ\n` +
      `- ✅ ตอนโอน/ชำระ ต้องใส่โน้ต/หมายเหตุว่า **"${NOTE_REQUIRED}"**\n` +
      `- ❌ ถ้าไม่มี/พิมพ์ไม่ตรง = **ต้องโอนใหม่เพื่อพิมพ์ใหม่** (ไม่รับสลิปนั้น)`,
  });

  // Receipt embed (#3)
  const receipt = await channel.send({
    embeds: [buildReceiptEmbed(state)],
    components: [customerButtons(state), ...staffButtons()],
  });
  await receipt.pin();
  state.receiptMessageId = receipt.id;

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
        await interaction.reply({
          embeds: [buildOpenPanelEmbed()],
          components: [buildOpenPanelRow()],
        });
      }
      return;
    }

    // Buttons
    if (interaction.isButton()) {
      const { customId } = interaction;

      // Open ticket from panel
      if (customId === "dbx_open_ticket") {
        await interaction.reply({ content: "กำลังสร้าง Ticket ให้ครับ ✅", ephemeral: true });
        const ch = await createTicketChannel(interaction.guild, interaction.user);
        await interaction.followUp({ content: `สร้าง Ticket แล้ว: ${ch}`, ephemeral: true });
        return;
      }

      // Ticket channel actions need state
      const channel = interaction.channel;
      const state = await loadState(channel);
      if (!state) return interaction.reply({ content: "ไม่พบข้อมูล Ticket ในห้องนี้", ephemeral: true });

      // Customer: call staff (#4)
      if (customId === "dbx_cust_call_staff") {
        await interaction.reply({
          content: `🔔 เรียกทีมงาน <@&${STAFF_ROLE_ID}> แล้วครับ\nโปรดรอสักครู่ ทีมงานกำลังเข้ามาดูแล ✅`,
        });
        return;
      }

      // Customer: pay (#8)
      if (customId === "dbx_cust_pay") {
        if (!state.locked) {
          return interaction.reply({ content: "ยังชำระเงินไม่ได้ ต้องให้ staff กด ✅ ล็อกยอด (QUOTE LOCK) ก่อน", ephemeral: true });
        }
        const subtotal = calcSubtotal(state.items);
        const { total } = ceilBaht(subtotal);

        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("dbx_pay_promptpay").setLabel("PromptPay QR").setEmoji("📱").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("dbx_pay_bank").setLabel("โอนธนาคาร").setEmoji("🏦").setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId("dbx_pay_truewallet").setLabel("TrueWallet").setEmoji("👛").setStyle(ButtonStyle.Primary)
        );

        await interaction.reply({
          content:
            `💳 เลือกช่องทางชำระเงิน\nยอดที่ต้องชำระ: **${total} บาท** (หลังปัดเศษแล้ว)\n\n` +
            `📌 ก่อนชำระ (บังคับ): ตอนโอน/ชำระ ต้องใส่โน้ต/หมายเหตุว่า **"${NOTE_REQUIRED}"**`,
          components: [row],
          ephemeral: true,
        });
        return;
      }

      // Customer: send slip (#12)
      if (customId === "dbx_cust_send_slip") {
        return interaction.reply({
          content:
            `📩 โปรดแนบรูปสลิป/หลักฐานการชำระเงินในห้องนี้ได้เลย\n` +
            `✅ ส่งเป็น “รูป/ไฟล์” เท่านั้น (ไม่แนะนำส่งเป็นลิงก์)\n\n` +
            `📌 เงื่อนไขผ่านการตรวจ (สำคัญ):\n` +
            `- ยอดต้องตรงตามใบเสร็จ\n` +
            `- สลิปต้องมีโน้ต/หมายเหตุว่า **"${NOTE_REQUIRED}"**\n` +
            `❌ ถ้าไม่มี/พิมพ์ไม่ตรง = ต้องโอนใหม่เพื่อพิมพ์ใหม่`,
          ephemeral: true,
        });
      }

      // Payment method buttons (#9-11)
      if (
        customId === "dbx_pay_promptpay" ||
        customId === "dbx_pay_bank" ||
        customId === "dbx_pay_truewallet"
      ) {
        const subtotal = calcSubtotal(state.items);
        const { total } = ceilBaht(subtotal);

        if (customId === "dbx_pay_promptpay") {
          state.paymentMethod = "PROMPTPAY";
          await interaction.reply({
            content:
              `📱 PromptPay QR\nยอดที่ต้องชำระ: **${total} บาท**\n\n` +
              `✅ โปรดสแกน QR และชำระตามยอดนี้เท่านั้น\n` +
              `📌 ก่อนกดยืนยันชำระ ต้องใส่โน้ต/หมายเหตุว่า **"${NOTE_REQUIRED}"**\n` +
              `เสร็จแล้วกด 📩 ส่งสลิป และแนบรูปสลิปในห้องนี้`,
            ephemeral: true,
          });
          if (PAY_QR_IMAGE_URL) await interaction.followUp({ content: PAY_QR_IMAGE_URL, ephemeral: true });
        }

        if (customId === "dbx_pay_bank") {
          state.paymentMethod = "BANK";
          await interaction.reply({
            content:
              `🏦 โอนธนาคาร\nยอดที่ต้องชำระ: **${total} บาท**\n\n` +
              `บัญชีรับเงิน:\n${BANK_TEXT || "ธนาคาร: ____\nชื่อบัญชี: ____\nเลขบัญชี: ____"}\n\n` +
              `📌 ตอนโอน ต้องใส่โน้ต/หมายเหตุว่า **"${NOTE_REQUIRED}"**\n` +
              `✅ โอนเสร็จแล้วกด 📩 ส่งสลิป และแนบรูปสลิปในห้องนี้`,
            ephemeral: true,
          });
        }

        if (customId === "dbx_pay_truewallet") {
          state.paymentMethod = "TRUEWALLET";
          await interaction.reply({
            content:
              `👛 TrueWallet\nยอดที่ต้องชำระ: **${total} บาท**\n\n` +
              `ช่องทางรับเงิน:\n${TRUEWALLET_TEXT || "เบอร์/ลิงก์รับเงิน: ____"}\n\n` +
              `📌 ก่อนยืนยันชำระ ต้องใส่โน้ต/หมายเหตุว่า **"${NOTE_REQUIRED}"**\n` +
              `✅ ชำระเสร็จแล้วกด 📩 ส่งสลิป และแนบรูปสลิปในห้องนี้`,
            ephemeral: true,
          });
        }

        await saveState(channel, state);
        await updateReceipt(channel, state);
        return;
      }

      // Staff-only buttons
      if (
        customId.startsWith("dbx_st_") ||
        customId === "dbx_verify_ok" ||
        customId === "dbx_verify_bad_note" ||
        customId === "dbx_verify_bad"
      ) {
        if (!isStaff(interaction.member)) {
          return interaction.reply({ content: "ปุ่มนี้ใช้ได้เฉพาะ staff", ephemeral: true });
        }
      }

      // Staff: add item (#5)
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

      // Staff: edit item
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

      // Staff: delete item
      if (customId === "dbx_st_del") {
        const modal = new ModalBuilder().setCustomId("dbx_modal_del").setTitle("🗑️ ลบรายการ");
        modal.addComponents(
          new ActionRowBuilder().addComponents(
            new TextInputBuilder().setCustomId("index").setLabel("ลำดับรายการที่ต้องการลบ (เช่น 1)").setStyle(TextInputStyle.Short).setRequired(true)
          )
        );
        return interaction.showModal(modal);
      }

      // Staff: lock/unlock (#7)
      if (customId === "dbx_st_lock") {
        state.locked = true;
        state.status = "AWAITING_PAYMENT";
        state.staffId = state.staffId || interaction.user.id;

        await interaction.reply({
          content:
            `✅ ล็อกยอดเรียบร้อย (QUOTE LOCK)\n` +
            `ตอนนี้ลูกค้าสามารถกด 💳 ชำระเงิน ได้แล้ว\n\n` +
            `📌 ย้ำอีกครั้ง (บังคับ): ตอนโอน/ชำระ ต้องใส่โน้ต/หมายเหตุว่า **"${NOTE_REQUIRED}"**\n` +
            `❌ ถ้าไม่มี/พิมพ์ไม่ตรง = ต้องโอนใหม่`,
        });

        await updateReceipt(channel, state);
        return;
      }

      if (customId === "dbx_st_unlock") {
        state.locked = false;
        state.status = "CART";
        await interaction.reply({ content: "🔓 ปลดล็อกยอดแล้ว (สามารถแก้ไขรายการได้)" });
        await updateReceipt(channel, state);
        return;
      }

      // Staff: verify panel (#15)
      if (customId === "dbx_st_verify") {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("dbx_verify_ok").setLabel("สลิปถูกต้อง / เงินเข้าแล้ว").setEmoji("✅").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId("dbx_verify_bad_note").setLabel("โน้ตไม่ถูกต้อง (ให้โอนใหม่)").setEmoji("📝").setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId("dbx_verify_bad").setLabel("สลิปไม่ถูกต้อง (ให้ส่งใหม่)").setEmoji("❌").setStyle(ButtonStyle.Secondary)
        );

        return interaction.reply({
          content:
            "🔍 ตรวจสลิป (Final)\n" +
            `📌 กติกาโน้ต: สลิปต้องมี **"${NOTE_REQUIRED}"**\n` +
            "เลือกผลตรวจ:",
          components: [row],
          ephemeral: true,
        });
      }

      // Staff: approve (#16)
      if (customId === "dbx_verify_ok" || customId === "dbx_st_paid") {
        state.status = "PAID";
        await interaction.reply({ content: "✅ ยืนยันชำระเงินเรียบร้อยแล้ว ขอบคุณครับ 🎉" });
        await updateReceipt(channel, state);

        const logCh = await interaction.guild.channels.fetch(LOG_CHANNEL_ID);
        await logCh.send({
          content: `📌 LOG: ชำระแล้ว (${state.ticketCode}) ห้อง: ${channel}`,
          embeds: [buildReceiptEmbed(state)],
        });
        return;
      }

      // Staff: reject because note missing -> must re-transfer (#17 note fail)
      if (customId === "dbx_verify_bad_note") {
        state.status = "REJECTED";
        await interaction.reply({
          content:
            "❌ สลิปไม่ผ่าน เนื่องจาก **โน้ต/หมายเหตุไม่ถูกต้องหรือไม่มีโน้ต**\n\n" +
            `✅ กรุณาโอนใหม่ และพิมพ์โน้ตว่า **"${NOTE_REQUIRED}"**\n` +
            "แล้วส่งสลิปใหม่ใน Ticket นี้ครับ",
        });
        await updateReceipt(channel, state);
        return;
      }

      // Staff: generic reject (send new slip)
      if (customId === "dbx_verify_bad") {
        state.status = "REJECTED";
        await interaction.reply({
          content:
            "❌ สลิปไม่ถูกต้อง/ข้อมูลไม่ตรง\n" +
            "โปรดชำระใหม่ตามยอดในใบเสร็จ และส่งสลิปใหม่อีกครั้ง\n\n" +
            `📌 หมายเหตุ: สลิปต้องมีโน้ต **"${NOTE_REQUIRED}"**`,
        });
        await updateReceipt(channel, state);
        return;
      }

      // Staff: close (#18)
      if (customId === "dbx_st_close") {
        await interaction.reply({ content: "🔒 ปิด Ticket เรียบร้อย\nขอบคุณที่ใช้บริการ Dinobux ✅" });

        const logCh = await interaction.guild.channels.fetch(LOG_CHANNEL_ID);
        await logCh.send({
          content: `📌 LOG: ปิด Ticket (${state.ticketCode}) ห้อง: ${channel}`,
          embeds: [buildReceiptEmbed(state)],
        });

        // lock customer from chatting
        await channel.permissionOverwrites.edit(state.customerId, { SendMessages: false });

        state.status = "CLOSED";
        state.closed = true;
        await updateReceipt(channel, state);

        // optional: rename channel
        try {
          await channel.setName(`closed-${state.ticketCode.toLowerCase()}`);
          await channel.setTopic(`DBX_CLOSED:${state.customerId}`);
        } catch {}
        return;
      }
    }

    // Modals (staff)
    if (interaction.isModalSubmit()) {
      const channel = interaction.channel;
      const state = await loadState(channel);
      if (!state) return interaction.reply({ content: "ไม่พบข้อมูล Ticket", ephemeral: true });
      if (!isStaff(interaction.member)) return interaction.reply({ content: "เฉพาะ staff", ephemeral: true });

      // Add item
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

      // Edit item
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

        await interaction.reply({ content: "✏️ แก้ไขรายการแล้ว ✅", ephemeral: true });
        await updateReceipt(channel, state);
        return;
      }

      // Delete item
      if (interaction.customId === "dbx_modal_del") {
        const idx = Number(interaction.fields.getTextInputValue("index")) - 1;
        if (!state.items[idx]) return interaction.reply({ content: "ไม่พบรายการลำดับนี้", ephemeral: true });

        state.items.splice(idx, 1);
        state.status = state.items.length ? "CART" : "NEW";

        await interaction.reply({ content: "🗑️ ลบรายการแล้ว ✅", ephemeral: true });
        await updateReceipt(channel, state);
        return;
      }
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
 *  Slip upload listener (#13)
 *  ======================= */
client.on(Events.MessageCreate, async (message) => {
  try {
    if (message.author.bot) return;
    if (!message.guild) return;

    const channel = message.channel;
    const state = await loadState(channel);
    if (!state) return;
    if (state.closed) return;

    // accept slip only from ticket owner
    if (message.author.id !== state.customerId) return;

    const att = message.attachments.first();
    if (!att) return;

    // เงื่อนไข: ต้อง lock และต้องเลือกช่องทางจ่ายก่อน
    if (!state.locked || !state.paymentMethod) {
      await channel.send({
        content:
          "❌ ยังไม่รับสลิปตอนนี้\n" +
          "กรุณารอให้ staff ✅ ล็อกยอด และเลือกช่องทางชำระเงินก่อน แล้วค่อยส่งสลิปครับ",
      });
      return;
    }

    state.slipUrl = att.url;
    state.status = "VERIFYING";

    await saveState(channel, state);
    await updateReceipt(channel, state);

    await channel.send({
      content:
        "🧾 รับสลิปเรียบร้อยแล้ว ✅\n" +
        "กำลังส่งให้ทีมงานตรวจสอบ…\n\n" +
        `🔍 <@&${STAFF_ROLE_ID}> มีสลิปใหม่ให้ตรวจในห้องนี้ครับ\n` +
        `📌 กติกาโน้ต: สลิปต้องมี **"${NOTE_REQUIRED}"**`,
    });
  } catch (e) {
    console.error(e);
  }
});

/** =======================
 *  Ready & boot
 *  ======================= */
client.once(Events.ClientReady, () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
});

(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();
