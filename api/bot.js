const { Bot, webhookCallback } = require('grammy');

const bot = new Bot(process.env.BOT_TOKEN);
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;

const webAppUrl = process.env.WEBAPP_URL; 

const KEYBOARD = {
    keyboard: [
        [{ 
            text: "📏 Открыть конструктор", 
            web_app: { url: webAppUrl } 
        }]
    ],
    resize_keyboard: true
};

// 1. Команда /start
bot.command('start', async (ctx) => {
    await ctx.reply(
        '👋 Конструктор готов! Нажмите кнопку ниже.\n\nПо другим вопросам пишите прямо в <u><b><a href="https://t.me/Udobna_Chat">чат производства 💬</a></b></u>', 
        { 
            reply_markup: KEYBOARD,
            parse_mode: 'HTML', // ЭТО САМОЕ ВАЖНОЕ: включает поддержку тегов
            disable_web_page_preview: true // (Опционально) Убирает превью ссылки, чтобы сообщение было компактным
        }
    );
});

// --- ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ ---

// Формирование сообщения для МЕНЕДЖЕРА
function createManagerMessage(orderData, user) {
    let msg = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n`;
    const username = user.username ? `@${user.username}` : 'Без ника';
    const userId = user.id || 'Не определен';
    
    msg += `👤 <b>Клиент:</b> ${username} (ID: <code>${userId}</code>)\n`;
    msg += `💰 <b>Итого:</b> ${orderData.total}\n`;
    msg += `📏 <b>Габариты:</b> ${orderData.dims}\n`;
    
    // ИСПРАВЛЕНИЕ: Убираем дубль слова "Вес", но делаем его жирным
    msg += `⚖️ ${orderData.weight.replace('Вес:', '<b>Вес:</b>')}\n\n`;
    
    msg += `📋 <b>Состав:</b>\n`;

    orderData.items.forEach((item, i) => {
        msg += `${i + 1}. ${item.name} (${item.color})\n`;
        msg += `   └ ${item.price ? item.price.toLocaleString() + ' ₽' : 'Вкл'}\n`;
    });
    return msg;
}

// Формирование сообщения для КЛИЕНТА
function createClientMessage(orderData) {
    let msg = `✅ <b>Ваша заявка принята!</b>\n\n`;
    msg += `Менеджер свяжется с вами в ближайшее время.\n\n`;
    
    msg += `📋 <b>Ваш заказ:</b>\n`;
    orderData.items.forEach((item, i) => {
        msg += `${i + 1}. ${item.name} (${item.color})\n`;
        msg += `   └ ${item.price ? item.price.toLocaleString() + ' ₽' : 'Вкл'}\n`;
    });

    msg += `\n💰 <b>Итого:</b> ${orderData.total}\n`;
    msg += `📏 <b>Габариты:</b> ${orderData.dims}\n`;
    
    // ИСПРАВЛЕНИЕ: То же самое для клиента
    msg += `⚖️ ${orderData.weight.replace('Вес:', '<b>Вес:</b>')}`;
    
    return msg;
}

// Отправка менеджеру
async function sendOrderToManager(orderData, userData) {
    const message = createManagerMessage(orderData, userData);
    if (MANAGER_CHAT_ID) {
        await bot.api.sendMessage(MANAGER_CHAT_ID, message, { parse_mode: 'HTML' }).catch(e => console.error(e));
    }
}

// Отправка клиенту (С УДАЛЕНИЕМ КНОПКИ)
async function sendConfirmationToClient(orderData, userData) {
    if (!userData || !userData.id) return;

    // Генерируем подробный текст
    const message = createClientMessage(orderData);

    try {
        await bot.api.sendMessage(userData.id, message, { 
            parse_mode: 'HTML',
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

        await sendOrderToManager(order, user);
        
        const clientMsg = createClientMessage(order);
        
        await ctx.reply(clientMsg, { 
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