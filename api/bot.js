const { Bot, webhookCallback } = require('grammy');

const bot = new Bot(process.env.BOT_TOKEN);
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;

// Клавиатура (используем в ответах)
const KEYBOARD = {
    keyboard: [[{ text: "🛏 Открыть конструктор", web_app: { url: process.env.WEBAPP_URL } }]],
    resize_keyboard: true
};

// Команда /start
bot.command('start', async (ctx) => {
    await ctx.reply('👋 Добро пожаловать! Нажмите кнопку ниже.', { reply_markup: KEYBOARD });
});

// Обработка данных из WebApp
bot.on('message:web_app_data', async (ctx) => {
    try {
        const { data } = ctx.message.web_app_data;
        const order = JSON.parse(data);

        let message = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n`;
        message += `👤 <b>Клиент:</b> @${ctx.from.username || 'Нет'} (${ctx.from.first_name})\n`;
        message += `💰 <b>Итого:</b> ${order.total}\n`;
        message += `📏 <b>Габариты:</b> ${order.dims}\n`;
        message += `⚖️ <b>Вес:</b> ${order.weight}\n\n`;
        message += `📋 <b>Состав:</b>\n`;
        
        order.items.forEach((item, i) => {
            message += `${i + 1}. ${item.name} (${item.color}) — ${item.price ? item.price.toLocaleString() + ' ₽' : 'Вкл'}\n`;
        });

        // 1. Менеджеру
        if (MANAGER_CHAT_ID) {
            await ctx.api.sendMessage(MANAGER_CHAT_ID, message, { parse_mode: 'HTML' });
        }

        // 2. Клиенту
        await ctx.reply('✅ Заявка принята! Менеджер скоро свяжется с вами.', {
            reply_markup: KEYBOARD
        });

    } catch (e) {
        console.error("Error processing data:", e);
        await ctx.reply("Произошла ошибка обработки данных.");
    }
});

// Служебная функция Vercel
const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    // Если кто-то открыл ссылку в браузере (GET), не запускаем бота, а просто отвечаем
    if (req.method === 'GET') {
        return res.status(200).json({ status: "Bot is running via Webhook!" });
    }

    // Если это POST (от Телеграма) — запускаем бота
    try {
        return await handleUpdate(req, res);
    } catch (e) {
        console.error(e);
        return res.status(500).json({ error: "Something went wrong" });
    }
};