const { Bot, webhookCallback } = require('grammy');

const bot = new Bot(process.env.BOT_TOKEN);
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;

// Клавиатура
const KEYBOARD = {
    keyboard: [[{ text: "🛏 Открыть конструктор", web_app: { url: process.env.WEBAPP_URL } }]],
    resize_keyboard: true
};

// 1. Команда /start
bot.command('start', async (ctx) => {
    await ctx.reply('👋 Конструктор готов! Нажмите кнопку ниже.', { reply_markup: KEYBOARD });
});

// 2. УНИВЕРСАЛЬНЫЙ ОБРАБОТЧИК (Ловим вообще всё)
bot.on('message', async (ctx) => {
    // Логируем, что пришло (для отладки в Vercel)
    console.log("📨 Пришло сообщение:", JSON.stringify(ctx.message, null, 2));

    // Проверяем вручную: есть ли данные от WebApp?
    if (ctx.message.web_app_data) {
        console.log("🟢 ОБНАРУЖЕНЫ ДАННЫЕ WEBAPP!");
        
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
                message += `${i + 1}. ${item.name} (${item.color})\n`;
                message += `   └ ${item.price ? item.price.toLocaleString() + ' ₽' : 'Включено'}\n`;
            });

            // Отправка менеджеру
            if (MANAGER_CHAT_ID) {
                await ctx.api.sendMessage(MANAGER_CHAT_ID, message, { parse_mode: 'HTML' });
            } else {
                console.error("⚠️ Не задан MANAGER_CHAT_ID!");
            }

            // Ответ клиенту
            await ctx.reply('✅ Заявка принята! Менеджер скоро свяжется с вами.', {
                reply_markup: KEYBOARD
            });

        } catch (e) {
            console.error("🔴 ОШИБКА ОБРАБОТКИ:", e);
            await ctx.reply(`Ошибка чтения данных: ${e.message}`);
        }
    } 
    // Если это просто текст или что-то другое - игнорируем (или можно отвечать для теста)
    else {
        console.log("⚪️ Это не WebApp данные, пропускаем.");
    }
});

// 3. Запуск Vercel
const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    // Проверка для браузера (чтобы не было Timeout)
    if (req.method === 'GET') {
        return res.status(200).send('Bot is running!');
    }

    // Логируем сам запрос от Телеграма (на всякий случай)
    try {
        console.log("🌐 VERCEL REQUEST BODY:", JSON.stringify(req.body).substring(0, 200) + "...");
        return await handleUpdate(req, res);
    } catch (e) {
        console.error("💥 CRITICAL ERROR:", e);
        return res.status(500).send(e.message);
    }
};