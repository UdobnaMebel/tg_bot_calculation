const { Bot, webhookCallback } = require('grammy');

const bot = new Bot(process.env.BOT_TOKEN);
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;

// ИСПОЛЬЗУЕМ ТОЧНО ТУ ЖЕ ССЫЛКУ, ЧТО И В КНОПКЕ МЕНЮ (она проверена)
const webAppUrl = 'https://calculation-smoky.vercel.app/?menu=fix'; 

// ВАЖНО: Я изменил текст кнопки на "🛏 Рассчитать стоимость".
// Это заставит Телеграм удалить старую глючную кнопку и создать новую с правильной ссылкой.
const KEYBOARD = {
    keyboard: [
        [{ 
            text: "🛏 Рассчитать стоимость", 
            web_app: { url: webAppUrl } 
        }]
    ],
    resize_keyboard: true // Делаем кнопку поменьше и аккуратнее
};

bot.command('start', async (ctx) => {
    await ctx.reply('👋 Конструктор готов! Нажмите кнопку внизу экрана.', { 
        reply_markup: KEYBOARD 
    });
});

// --- ФУНКЦИИ ОТПРАВКИ (Без изменений) ---

async function sendOrderToManager(orderData, userData) {
    let message = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n`;
    const username = userData.username ? `@${userData.username}` : 'Без ника';
    
    // Если ID нет, пишем "Не определен"
    const userId = userData.id || 'Не определен';
    
    message += `👤 <b>Клиент:</b> ${username} (ID: <code>${userId}</code>)\n`;
    message += `💰 <b>Итого:</b> ${orderData.total}\n`;
    message += `📏 <b>Габариты:</b> ${orderData.dims}\n`;
    message += `⚖️ <b>Вес:</b> ${orderData.weight}\n\n`;
    message += `📋 <b>Состав:</b>\n`;

    orderData.items.forEach((item, i) => {
        message += `${i + 1}. ${item.name} (${item.color})\n`;
        message += `   └ ${item.price ? item.price.toLocaleString() + ' ₽' : 'Вкл'}\n`;
    });

    if (MANAGER_CHAT_ID) {
        try {
            await bot.api.sendMessage(MANAGER_CHAT_ID, message, { parse_mode: 'HTML' });
        } catch (e) { console.error(e); }
    }
}

async function sendConfirmationToClient(orderData, userData) {
    if (!userData || !userData.id) return;

    let clientMsg = `✅ <b>Ваша заявка принята!</b>\n\n`;
    clientMsg += `Менеджер свяжется с вами в ближайшее время.\n`;
    clientMsg += `\n<b>Итого: ${orderData.total}</b>`;

    try {
        await bot.api.sendMessage(userData.id, clientMsg, { 
            parse_mode: 'HTML',
            reply_markup: KEYBOARD // Возвращаем кнопку клиенту
        });
    } catch (e) { console.error(e); }
}

const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');

    if (req.body && req.body.type === 'DIRECT_ORDER') {
        const { order, user } = req.body;
        await sendOrderToManager(order, user);
        await sendConfirmationToClient(order, user);
        return res.status(200).json({ success: true });
    }

    try {
        return await handleUpdate(req, res);
    } catch (e) {
        return res.status(500).send('Error');
    }
};