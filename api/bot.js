const { Bot, webhookCallback } = require('grammy');

const bot = new Bot(process.env.BOT_TOKEN);
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID;

// 1. ЛОГГЕР ВСЕХ СОБЫТИЙ (Spy Middleware)
// Этот код выведет в консоль Vercel всё, что присылает Телеграм
bot.use(async (ctx, next) => {
    console.log("📥 ПОЛУЧЕНО СОБЫТИЕ:", JSON.stringify(ctx.update, null, 2));
    await next();
});

// Клавиатура
const KEYBOARD = {
    keyboard: [[{ text: "🛏 Открыть конструктор", web_app: { url: process.env.WEBAPP_URL } }]],
    resize_keyboard: true
};

bot.command('start', async (ctx) => {
    await ctx.reply('Бот работает! Нажми кнопку.', { reply_markup: KEYBOARD });
});

// Обработчик данных
bot.on('message:web_app_data', async (ctx) => {
    console.log("🚀 ПРИШЛИ ДАННЫЕ WEBAPP!"); // Лог в консоль
    try {
        const { data } = ctx.message.web_app_data;
        const order = JSON.parse(data);

        let message = `🆕 ЗАКАЗ ПРИНЯТ!\nСумма: ${order.total}`;
        
        // Отправка менеджеру
        if (MANAGER_CHAT_ID) {
            console.log("📤 Отправляю менеджеру:", MANAGER_CHAT_ID);
            await ctx.api.sendMessage(MANAGER_CHAT_ID, message);
        } else {
            console.error("⛔️ НЕТ MANAGER_CHAT_ID в переменных!");
        }

        await ctx.reply('✅ Данные получены сервером!', { reply_markup: KEYBOARD });

    } catch (e) {
        console.error("🔥 ОШИБКА ВНУТРИ БОТА:", e);
        await ctx.reply('Ошибка обработки данных.');
    }
});

// Обертка для Vercel с принудительным логом
const handleUpdate = webhookCallback(bot, 'http');

module.exports = async (req, res) => {
    try {
        console.log("🌐 VERCEL FUNCTION STARTED"); // Этот лог должен быть всегда
        return await handleUpdate(req, res);
    } catch (e) {
        console.error("💥 CRITICAL VERCEL ERROR:", e);
        res.status(500).json({ error: e.message });
    }
};