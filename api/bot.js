const { Bot, webhookCallback } = require('grammy');

const bot = new Bot(process.env.BOT_TOKEN);
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;

const KEYBOARD = {
    keyboard: [[{ text: "🛏 Открыть конструктор", web_app: { url: process.env.WEBAPP_URL } }]],
    resize_keyboard: true
};

bot.command('start', async (ctx) => {
    await ctx.reply('👋 Конструктор готов! Жмите кнопку.', { reply_markup: KEYBOARD });
});

// --- ФУНКЦИЯ 1: Отправка МЕНЕДЖЕРУ ---
async function sendOrderToManager(orderData, userData) {
    let message = `🆕 <b>НОВЫЙ ЗАКАЗ (Site)</b>\n\n`;
    const username = userData.username ? `@${userData.username}` : 'Без ника';
    const name = userData.first_name || 'Клиент';
    
    message += `👤 <b>Клиент:</b> ${username} (ID: ${userData.id})\n`;
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

// --- ФУНКЦИЯ 2: Отправка КЛИЕНТУ (Новое) ---
async function sendConfirmationToClient(orderData, userData) {
    if (!userData || !userData.id) return;

    // Формируем чек для клиента
    let clientMsg = `✅ <b>Ваша заявка принята!</b>\n\n`;
    clientMsg += `Мы свяжемся с вами в ближайшее время.\n\n`;
    clientMsg += `<b>Ваш заказ:</b>\n`;
    
    orderData.items.forEach((item) => {
        clientMsg += `• ${item.name} (${item.color})\n`;
    });
    
    clientMsg += `\n<b>Итого: ${orderData.total}</b>`;

    try {
        // Отправляем сообщение по ID пользователя
        await bot.api.sendMessage(userData.id, clientMsg, { 
            parse_mode: 'HTML',
            reply_markup: KEYBOARD // Возвращаем кнопку клиенту
        });
    } catch (e) {
        console.error("Не удалось отправить сообщение клиенту (возможно, бот заблокирован):", e);
    }
}

// Запуск Vercel
const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    // 1. Обработка ПРЯМОГО запроса (fetch)
    if (req.body && req.body.type === 'DIRECT_ORDER') {
        try {
            const { order, user } = req.body;
            
            // 1. Шлем менеджеру
            await sendOrderToManager(order, user);
            
            // 2. Шлем клиенту (ВОТ ЭТО МЫ ДОБАВИЛИ)
            await sendConfirmationToClient(order, user);
            
            return res.status(200).json({ success: true });
        } catch (e) {
            console.error("ОШИБКА ПРЯМОГО ЗАКАЗА:", e);
            return res.status(500).json({ error: e.message });
        }
    }

    // 2. Обработка Webhook (для /start и прочего)
    try {
        return await handleUpdate(req, res);
    } catch (e) {
        return res.status(500).send('Error');
    }
};