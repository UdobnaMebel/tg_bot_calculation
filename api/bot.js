const { Bot, webhookCallback } = require('grammy');

const bot = new Bot(process.env.BOT_TOKEN);
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;

// === НАСТРОЙКА КЛАВИАТУРЫ ===
// Добавляем параметр ?v=chat, чтобы сбросить кэш Телеграма.
// Это гарантирует, что при открытии передадутся данные пользователя (ID, Имя).
const webAppUrl = 'https://calculation-smoky.vercel.app/?menu=fix';

const KEYBOARD = {
    keyboard: [[{ text: "🛏 Открыть конструктор", web_app: { url: webAppUrl } }]],
    resize_keyboard: true
};

// 1. Команда /start
bot.command('start', async (ctx) => {
    await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже, чтобы начать.', { 
        reply_markup: KEYBOARD 
    });
});

// --- ФУНКЦИЯ 1: Отправка заказа МЕНЕДЖЕРУ ---
async function sendOrderToManager(orderData, userData) {
    let message = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n`;
    
    // Красивое отображение имени
    const username = userData.username ? `@${userData.username}` : 'Без юзернейма';
    const name = userData.first_name || 'Клиент';
    
    message += `👤 <b>Клиент:</b> ${username} (ID: <code>${userData.id}</code>)\n`;
    message += `💰 <b>Итого:</b> ${orderData.total}\n`;
    message += `📏 <b>Габариты:</b> ${orderData.dims}\n`;
    message += `⚖️ <b>Вес:</b> ${orderData.weight}\n\n`;
    message += `📋 <b>Состав заказа:</b>\n`;

    orderData.items.forEach((item, i) => {
        message += `${i + 1}. ${item.name} (${item.color})\n`;
        // Если цена 0 или не указана, пишем "Включено"
        message += `   └ ${item.price ? item.price.toLocaleString() + ' ₽' : 'Включено'}\n`;
    });

    if (MANAGER_CHAT_ID) {
        try {
            await bot.api.sendMessage(MANAGER_CHAT_ID, message, { parse_mode: 'HTML' });
        } catch (e) {
            console.error("Ошибка отправки менеджеру:", e);
        }
    } else {
        console.error("MANAGER_CHAT_ID не задан в настройках Vercel");
    }
}

// --- ФУНКЦИЯ 2: Отправка подтверждения КЛИЕНТУ ---
async function sendConfirmationToClient(orderData, userData) {
    // Если ID нет (анонимный заказ из-за бага), выходим
    if (!userData || !userData.id) return;

    let clientMsg = `✅ <b>Ваша заявка принята!</b>\n\n`;
    clientMsg += `Менеджер свяжется с вами в ближайшее время для уточнения деталей.\n\n`;
    clientMsg += `<b>Ваш заказ:</b>\n`;
    
    orderData.items.forEach((item) => {
        clientMsg += `• ${item.name} (${item.color})\n`;
    });
    
    clientMsg += `\n<b>Итого: ${orderData.total}</b>`;

    try {
        await bot.api.sendMessage(userData.id, clientMsg, { 
            parse_mode: 'HTML',
            reply_markup: KEYBOARD // Возвращаем кнопку, чтобы можно было заказать снова
        });
    } catch (e) {
        // Это может случиться, если пользователь заблокировал бота
        console.error("Не удалось отправить сообщение клиенту:", e.message);
    }
}

// Инициализация Webhook для Vercel
const handleUpdate = webhookCallback(bot, 'http');

// === ГЛАВНЫЙ ОБРАБОТЧИК ЗАПРОСОВ ===
module.exports = async (req, res) => {
    // 1. Проверка работоспособности (если открыть в браузере)
    if (req.method === 'GET') {
        return res.status(200).send('Bot is running...');
    }

    // 2. Обработка ПРЯМОГО ЗАКАЗА от Frontend (через fetch)
    if (req.body && req.body.type === 'DIRECT_ORDER') {
        try {
            const { order, user } = req.body;
            
            // Логируем для отладки
            console.log("🚀 Получен прямой заказ от:", user?.first_name);

            // Параллельно отправляем сообщения
            await Promise.all([
                sendOrderToManager(order, user),
                sendConfirmationToClient(order, user)
            ]);
            
            return res.status(200).json({ success: true });
        } catch (e) {
            console.error("Ошибка обработки прямого заказа:", e);
            return res.status(500).json({ error: e.message });
        }
    }

    // 3. Обработка стандартных обновлений от Telegram (Webhook)
    try {
        return await handleUpdate(req, res);
    } catch (e) {
        console.error("Telegram Webhook Error:", e);
        return res.status(500).send('Internal Server Error');
    }
};