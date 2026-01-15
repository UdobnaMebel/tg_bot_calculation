const { Bot, webhookCallback } = require('grammy');

const bot = new Bot(process.env.BOT_TOKEN);
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;

// === ИСПРАВЛЕНИЕ ТУТ ===
// Добавляем к URL параметр ?v=chat, чтобы сбросить кэш и передать данные
const webAppUrl = process.env.WEBAPP_URL + '?v=chat'; 

const KEYBOARD = {
    keyboard: [[{ text: "🛏 Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};
// =======================

bot.command('start', async (ctx) => {
    await ctx.reply('👋 Конструктор готов! Жмите кнопку.', { reply_markup: KEYBOARD });
});

// ... (остальной код функций отправки sendOrderToManager и sendConfirmationToClient оставляем как был) ...
async function sendOrderToManager(orderData, userData) {
    // ... твой код ...
    let message = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n`;
    // Добавим проверку, чтобы красиво писать "Без ника"
    const username = userData.username ? `@${userData.username}` : 'Без ника';
    const name = userData.first_name || 'Клиент';
    
    message += `👤 <b>Клиент:</b> ${username} (ID: ${userData.id})\n`;
    // ... остальной код ...
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
    }
}

async function sendConfirmationToClient(orderData, userData) {
    if (!userData || !userData.id) return;

    let clientMsg = `✅ <b>Ваша заявка принята!</b>\n\n`;
    clientMsg += `Мы свяжемся с вами в ближайшее время.\n\n`;
    clientMsg += `<b>Ваш заказ:</b>\n`;
    
    orderData.items.forEach((item) => {
        clientMsg += `• ${item.name} (${item.color})\n`;
    });
    
    clientMsg += `\n<b>Итого: ${orderData.total}</b>`;

    try {
        await bot.api.sendMessage(userData.id, clientMsg, { 
            parse_mode: 'HTML',
            reply_markup: KEYBOARD // Возвращаем ОБНОВЛЕННУЮ кнопку
        });
    } catch (e) {
        console.error("Ошибка отправки клиенту:", e);
    }
}

const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    if (req.body && req.body.type === 'DIRECT_ORDER') {
        try {
            const { order, user } = req.body;
            await sendOrderToManager(order, user);
            await sendConfirmationToClient(order, user);
            return res.status(200).json({ success: true });
        } catch (e) {
            return res.status(500).json({ error: e.message });
        }
    }
    try {
        return await handleUpdate(req, res);
    } catch (e) {
        return res.status(500).send('Error');
    }
};