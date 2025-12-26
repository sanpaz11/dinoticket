require("dotenv").config();
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

function buildDinobuxCover() {
  const banner = process.env.BANNER_URL; // ใส่รูปแบนเนอร์ (1000x400 แนะนำ)
  const logo = process.env.LOGO_URL;     // ใส่โลโก้/มาสคอต (รูปสี่เหลี่ยมจัตุรัส)

  return new EmbedBuilder()
    .setColor(0x57F287) // โทนเขียวสด
    .setAuthor({ name: "Dinobux Store" })
    .setTitle("🦖 เติมเกมไว • ระบบ Ticket • เช็คประวัติได้")
    .setDescription(
      [
        "⏰ **เปิดบริการ:** 09:00 – 02:00 น.",
        "🧾 **ส่งสลิปใน Ticket เท่านั้น** (รูปชัด ไม่ครอป)",
        "🔎 **เช็คยอดสะสม/ประวัติการสั่งซื้อ** ได้",
        "",
        "พิมพ์ “ต้องการเติมอะไร” แล้วรอ Staff สรุปยอดให้ใน Ticket",
      ].join("\n")
    )
    .addFields(
      { name: "⚡ ขั้นตอนสั่งซื้อ", value: "แจ้งรายการ → สรุปยอด → ชำระเงิน → ส่งสลิป → ดำเนินการ", inline: false },
      { name: "✅ บริการ", value: "เติมเกม / เติมพาส / ดูแลหลังการขาย", inline: false },
    )
    .setThumbnail(logo || null)
    .setImage(banner || null)
    .setFooter({ text: "Dinobux • Fast & Safe" });
}

client.once("ready", async () => {
  const channel = await client.channels.fetch(process.env.PANEL_CHANNEL_ID);
  await channel.send({ embeds: [buildDinobuxCover()] });
  console.log("Dinobux cover sent ✅");
});

client.login(process.env.DISCORD_TOKEN);
