const { Bot, webhookCallback } = require('grammy');

const bot = new Bot(process.env.BOT_TOKEN);
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;

// 1. ГИБКАЯ ССЫЛКА (Берется из настроек Vercel)
// Важно: В настройках Vercel переменная WEBAPP_URL должна быть
// точь-в-точь как та, что вы указали в BotFather (включая слэш в конце, если он там есть)
const webAppUrl = process.env.WEBAPP_URL; 

const KEYBOARD = {
    keyboard: [
        [{ 
            text: "✅ Открыть конструктор", 
            web_app: { url: webAppUrl } 
        }]
    ],
    resize_keyboard: true
};

// 1. Команда /start
bot.command('start', async (ctx) => {
    // Сначала чистим старое, потом шлем новое
    // await ctx.reply('Меню обновлено.', { reply_markup: { remove_keyboard: true } });
    await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже:', { reply_markup: KEYBOARD });
});

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

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

// Отправка менеджеру
async function sendOrderToManager(orderData, userData) {
    const message = createMessage(orderData, userData);
    if (MANAGER_CHAT_ID) {
        await bot.api.sendMessage(MANAGER_CHAT_ID, message, { parse_mode: 'HTML' }).catch(e => console.error(e));
    }
}

// Отправка клиенту (С УДАЛЕНИЕМ КНОПКИ)
async function sendConfirmationToClient(orderData, userData) {
    if (!userData || !userData.id) return;

    let clientMsg = `✅ <b>Ваша заявка принята!</b>\n\n`;
    clientMsg += `Менеджер свяжется с вами в ближайшее время.\n`;
    clientMsg += `\n<b>Итого: ${orderData.total}</b>`;

    try {
        await bot.api.sendMessage(userData.id, clientMsg, { 
            parse_mode: 'HTML',
            // Убираем нижнюю кнопку после заказа
            reply_markup: { remove_keyboard: true } 
        });
    } catch (e) {
        console.error("Ошибка отправки клиенту:", e);
    }
}

// --- ОБРАБОТЧИКИ ---

// 1. Старый способ (tg.sendData) - для ПК (где нет ID) и надежности
bot.on('message:web_app_data', async (ctx) => {
    try {
        const { data } = ctx.message.web_app_data;
        const order = JSON.parse(data);
        const user = ctx.from; 

        // Отправляем менеджеру
        await sendOrderToManager(order, user);
        
        // Отвечаем клиенту и УБИРАЕМ КНОПКУ
        await ctx.reply(`✅ <b>Заявка принята!</b>\n\nМенеджер скоро свяжется с вами.`, { 
            parse_mode: 'HTML',
            reply_markup: { remove_keyboard: true } 
        });
        
    } catch (e) {
        console.error("Ошибка web_app_data:", e);
    }
});

// 2. Прямой способ (fetch) - для Меню и Телефонов
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