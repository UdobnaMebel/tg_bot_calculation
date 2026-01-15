const { Bot, webhookCallback } = require('grammy');

const bot = new Bot(process.env.BOT_TOKEN);
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;

const webAppUrl = 'https://calculation-smoky.vercel.app/'; 

// Используем обычную кнопку, она лучше работает с sendData
const KEYBOARD = {
    keyboard: [[{ text: "🛏 Рассчитать стоимость", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

bot.command('start', async (ctx) => {
    await ctx.reply('👋 Конструктор готов! Нажмите кнопку внизу.', { reply_markup: KEYBOARD });
});

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

// Формируем текст сообщения
function createMessage(orderData, user) {
    let msg = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n`;
    const username = user.username ? `@${user.username}` : 'Без ника';
    const userId = user.id || 'Не определен';
    
    msg += `👤 <b>Клиент:</b> ${username} (ID: <code>${userId}</code>)\n`;
    msg += `💰 <b>Итого:</b> ${orderData.total}\n`;
    msg += `📏 <b>Габариты:</b> ${orderData.dims}\n`;
    msg += `⚖️ <b>Вес:</b> ${orderData.weight}\n\n`;
    msg += `📋 <b>Состав:</b>\n`;

    orderData.items.forEach((item, i) => {
        msg += `${i + 1}. ${item.name} (${item.color})\n`;
        msg += `   └ ${item.price ? item.price.toLocaleString() + ' ₽' : 'Вкл'}\n`;
    });
    return msg;
}

// Отправка менеджеру и клиенту
async function processOrder(ctx, orderData, userData) {
    const message = createMessage(orderData, userData);

    // 1. Менеджеру
    if (MANAGER_CHAT_ID) {
        await bot.api.sendMessage(MANAGER_CHAT_ID, message, { parse_mode: 'HTML' }).catch(e => console.error(e));
    }

    // 2. Клиенту
    // Если контекст (ctx) есть (это sendData), отвечаем прямо ему
    // Если контекста нет (это fetch), шлем по ID
    if (ctx) {
        await ctx.reply(`✅ <b>Заявка принята!</b>\n\nМенеджер скоро свяжется с вами.`, { 
            parse_mode: 'HTML',
            reply_markup: KEYBOARD 
        });
    } else if (userData.id) {
        await bot.api.sendMessage(userData.id, `✅ <b>Заявка принята!</b>\n\nМенеджер скоро свяжется с вами.`, { 
            parse_mode: 'HTML',
            reply_markup: KEYBOARD 
        }).catch(e => console.error(e));
    }
}

// --- ОБРАБОТЧИКИ ---

// 1. Старый добрый способ (tg.sendData)
// Сюда придет заказ с кнопки внизу, и тут ID БУДЕТ ГАРАНТИРОВАННО
bot.on('message:web_app_data', async (ctx) => {
    try {
        const { data } = ctx.message.web_app_data;
        const order = JSON.parse(data);
        const user = ctx.from; // Берем юзера из сообщения Телеграм (это надежно!)

        await processOrder(ctx, order, user);
    } catch (e) {
        console.error("Ошибка web_app_data:", e);
    }
});

// 2. Прямой способ (fetch) - для Меню и подстраховки
const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    if (req.method === 'GET') return res.status(200).send('Bot Running');

    if (req.body && req.body.type === 'DIRECT_ORDER') {
        // Если прилетел прямой заказ, обрабатываем, но только если он не дублирует sendData
        // (Для простоты пока просто обрабатываем, дубли маловероятны, т.к. окно закрывается)
        const { order, user } = req.body;
        // Если ID нет (0), то processOrder просто не отправит клиенту, но отправит менеджеру
        await processOrder(null, order, user); 
        return res.status(200).json({ success: true });
    }

    try {
        return await handleUpdate(req, res);
    } catch (e) {
        return res.status(500).send('Error');
    }
};