const { Bot, webhookCallback } = require('grammy');

const bot = new Bot(process.env.BOT_TOKEN);
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;

// Клавиатура
const KEYBOARD = {
    keyboard: [[{ text: "🛏 Открыть конструктор", web_app: { url: process.env.WEBAPP_URL } }]],
    resize_keyboard: true
};

bot.command('start', async (ctx) => {
    await ctx.reply('👋 Конструктор готов! Жмите кнопку.', { reply_markup: KEYBOARD });
});

// Этот обработчик оставим для совместимости (если вдруг sendData заработает)
bot.on('message:web_app_data', async (ctx) => {
    // Логика обработки старого метода (можно оставить пустой или как было)
    await ctx.reply('Данные получены через Telegram API');
});

// --- ФУНКЦИЯ ОТПРАВКИ ЗАКАЗА МЕНЕДЖЕРУ ---
async function sendOrderToManager(orderData, userData) {
    let message = `🆕 <b>НОВЫЙ ЗАКАЗ (Прямой)</b>\n\n`;
    // Берем данные юзера, которые прислал фронтенд
    const username = userData.username ? `@${userData.username}` : 'Без ника';
    const name = userData.first_name || 'Клиент';
    
    message += `👤 <b>Клиент:</b> ${username} (${name})\n`;
    message += `💰 <b>Итого:</b> ${orderData.total}\n`;
    message += `📏 <b>Габариты:</b> ${orderData.dims}\n`;
    message += `⚖️ <b>Вес:</b> ${orderData.weight}\n\n`;
    message += `📋 <b>Состав:</b>\n`;

    orderData.items.forEach((item, i) => {
        message += `${i + 1}. ${item.name} (${item.color})\n`;
        message += `   └ ${item.price ? item.price.toLocaleString() + ' ₽' : 'Вкл'}\n`;
    });

    if (MANAGER_CHAT_ID) {
        await bot.api.sendMessage(MANAGER_CHAT_ID, message, { parse_mode: 'HTML' });
    } else {
        console.error("MANAGER_CHAT_ID не задан");
    }
}

// Запуск Vercel
const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    // 1. Обработка ПРЯМОГО запроса от фронтенда (fetch)
    if (req.body && req.body.type === 'DIRECT_ORDER') {
        try {
            console.log("🚀 ПОЛУЧЕН ПРЯМОЙ ЗАКАЗ:", req.body);
            const { order, user } = req.body;
            
            // Отправляем сообщение менеджеру
            await sendOrderToManager(order, user);
            
            return res.status(200).json({ success: true });
        } catch (e) {
            console.error("ОШИБКА ПРЯМОГО ЗАКАЗА:", e);
            return res.status(500).json({ error: e.message });
        }
    }

    // 2. Обработка обычных запросов от Telegram (Webhook)
    try {
        return await handleUpdate(req, res);
    } catch (e) {
        console.error("Telegram Webhook Error:", e);
        return res.status(500).send('Error');
    }
};