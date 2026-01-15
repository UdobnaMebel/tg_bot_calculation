const { Bot, webhookCallback } = require('grammy');

const bot = new Bot(process.env.BOT_TOKEN);
const MANAGER_CHAT_ID = process.env.MANAGER_CHAT_ID; 

const KEYBOARD = {
    keyboard: [[{ text: "🛏 Открыть конструктор", web_app: { url: process.env.WEBAPP_URL } }]],
    resize_keyboard: true
};

bot.command('start', async (ctx) => {
    await ctx.reply('👋 Добро пожаловать!', { reply_markup: KEYBOARD });
});

// ИЗМЕНЕНИЕ: Слушаем абсолютно ВСЕ сообщения
bot.on('message', async (ctx) => {
    // 1. Проверяем, есть ли данные WebApp
    if (ctx.message.web_app_data) {
        try {
            const { data } = ctx.message.web_app_data;
            const order = JSON.parse(data);

            let message = `🆕 <b>НОВЫЙ ЗАКАЗ</b>\n\n`;
            message += `👤 <b>Клиент:</b> @${ctx.from.username || 'Нет'} (${ctx.from.first_name})\n`;
            message += `💰 <b>Сумма:</b> ${order.total}\n\n`;
            
            // Краткий список для теста
            order.items.forEach((item, i) => {
                message += `${i+1}. ${item.name} (${item.color})\n`;
            });

            // Отправляем менеджеру
            if (MANAGER_CHAT_ID) {
                await ctx.api.sendMessage(MANAGER_CHAT_ID, message, { parse_mode: 'HTML' });
            }

            // Отправляем клиенту
            await ctx.reply('✅ Заявка получена! Скоро свяжемся.', { 
                reply_markup: KEYBOARD 
            });

        } catch (e) {
            console.error("ОШИБКА ОБРАБОТКИ:", e); // Увидим в логах Vercel
            await ctx.reply(`Ошибка бота: ${e.message}`);
        }
    } else {
        // Если это просто текст или что-то другое
        // Не отвечаем, чтобы не спамить, или можно вывести в консоль
        console.log("Получено сообщение без web_app_data:", ctx.message);
    }
});

module.exports = webhookCallback(bot, 'http');