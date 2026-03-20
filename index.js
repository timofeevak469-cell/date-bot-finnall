// ============================================
// ДАТИНГ-БОТ (как Дайвинчик)
// ============================================

require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const LocalSession = require('telegraf-session-local');

// Модели
const User = require('./models/User');
const Like = require('./models/Like');
const Match = require('./models/Match');

// Инициализация бота
const bot = new Telegraf(process.env.BOT_TOKEN);
bot.use(new LocalSession({ database: 'sessions.json' }).middleware());

// ============================================
// ПОДКЛЮЧЕНИЕ К БАЗЕ
// ============================================
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ База данных подключена');
    User.updateMany({ active: { $exists: false } }, { $set: { active: true } })
      .then(r => console.log(`✅ Обновлено ${r.modifiedCount} пользователей: active=true`))
      .catch(e => console.error('❌ Ошибка миграции active:', e));
  })
  .catch(e => console.error('❌ Ошибка подключения к БД:', e));

// ============================================
// ВСПОМОГАТЕЛЬНЫЕ ФУНКЦИИ
// ============================================
const getUser = async (id) => await User.findOne({ telegramId: id });
const createUser = async (id, data) => new User({ telegramId: id, ...data, active: true }).save();
const updateField = async (id, field, value) => {
  const update = { [field]: value, updatedAt: Date.now() };
  return await User.findOneAndUpdate({ telegramId: id }, update, { new: true });
};

// Отправка кумулятивного уведомления о лайках
const sendLikeNotification = async (toUserId, fromUserId) => {
  const toUser = await getUser(toUserId);
  if (!toUser) return;
  const count = await Like.countDocuments({ toUser: toUserId, notified: false });
  if (count === 0) return;
  const text = `✨ У тебя ${count} новых лайков! Посмотрим?`;
  await bot.telegram.sendMessage(toUserId, text, Markup.inlineKeyboard([
    [Markup.button.callback('Да', 'view_likers'), Markup.button.callback('Нет', 'skip_likers')]
  ]));
};

// ============================================
// ГЛАВНОЕ МЕНЮ
// ============================================
const mainMenu = (user) => {
  if (!user) return Markup.keyboard([['📝 Создать анкету']]).resize();
  return Markup.keyboard([
    [user.active ? '👀 Смотреть анкеты' : '▶️ Начать поиск', '📝 Моя анкета'],
    ['✏️ Редактировать анкету']
  ]).resize();
};

// ============================================
// ПОКАЗ АНКЕТ
// ============================================
const showMyProfile = async (ctx, user) => {
  const caption = `${user.name}, ${user.age} г., г. ${user.city}\n\n${user.description}`;
  await ctx.replyWithPhoto(user.photoFileId, { caption });
};

const showNextProfile = async (ctx, userId) => {
  const user = await getUser(userId);
  if (!user) return ctx.reply('Сначала создай анкету через /start');

  // Получаем ВСЕХ, кого пользователь уже лайкнул или дизлайкнул (без ограничений по времени)
  const interactions = await Like.find({ fromUser: userId }).select('toUser');
  const excludedIds = interactions.map(i => i.toUser);
  
  console.log('Исключаем ID:', excludedIds); // для отладки

  const filter = {
    telegramId: { 
      $ne: userId,               // не себя
      $nin: excludedIds           // исключаем всех, с кем уже взаимодействовал
    },
    gender: user.lookingFor === 'all' 
      ? { $in: ['male', 'female', 'other'] } 
      : user.lookingFor,
    active: true
  };

  const candidate = await User.findOne(filter);
  if (!candidate) return ctx.reply('😕 Больше нет анкет для показа. Загляни позже!');

  ctx.session = { viewing: candidate.telegramId };
  const caption = `${candidate.name}, ${candidate.age} г., г. ${candidate.city}\n\n${candidate.description}`;
  await ctx.replyWithPhoto(candidate.photoFileId, {
    caption,
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('❤️', 'like'),
        Markup.button.callback('👎', 'dislike'),
        Markup.button.callback('🔙', 'back')
      ]
    ])
  });
};
// ============================================
// ПРОСМОТР ЛАЙКОВ
// ============================================
const showNextLiker = async (ctx, userId) => {
  const likes = await Like.find({ toUser: userId, notified: false }).sort({ createdAt: 1 });
  if (!likes.length) return ctx.reply('Больше нет анкет для просмотра.', mainMenu(await getUser(userId)));

  const likerIds = likes.map(l => l.fromUser);
  const likers = await User.find({ telegramId: { $in: likerIds } });

  const mutual = [], normal = [];
  for (const like of likes) {
    const liker = likers.find(u => u.telegramId === like.fromUser);
    if (!liker) continue;
    const isMutual = await Match.exists({ users: { $all: [userId, liker.telegramId] } });
    (isMutual ? mutual : normal).push({ like, liker });
  }

  // Помечаем как уведомлённые
  for (const item of [...mutual, ...normal]) {
    await Like.updateOne({ _id: item.like._id }, { $set: { notified: true } });
  }

  // Показываем взаимных
  for (const { liker } of mutual) {
   const caption = `${liker.name}, ${liker.age} г., г. ${liker.city}\n\n${liker.description}`;
    await ctx.replyWithPhoto(liker.photoFileId, { caption });
    const contact = `👤 Контакт: ${liker.name}` + (liker.username ? `\nЮзернейм: @${liker.username}\nПерейти: t.me/${liker.username}` : '\n(нет username)');
    await ctx.reply(contact);
  }

  if (!normal.length) return ctx.reply('Все анкеты просмотрены!', mainMenu(await getUser(userId)));

  ctx.session = {
    normalQueue: normal.map(i => ({ likeId: i.like._id.toString(), likerId: i.liker.telegramId })),
    currentIdx: 0
  };
  await showNextNormal(ctx, userId);
};

const showNextNormal = async (ctx, userId) => {
  const { normalQueue, currentIdx } = ctx.session || {};
  if (!normalQueue || currentIdx >= normalQueue.length) {
    ctx.session = null;
    return ctx.reply('Все анкеты просмотрены!', mainMenu(await getUser(userId)));
  }

  const item = normalQueue[currentIdx];
  const liker = await getUser(item.likerId);
  if (!liker) {
    await Like.deleteOne({ _id: item.likeId });
    ctx.session.currentIdx = currentIdx + 1;
    return showNextNormal(ctx, userId);
  }

  ctx.session.currentLikerId = liker.telegramId;
  ctx.session.currentLikeId = item.likeId;

  await ctx.reply('✨ Кому-то понравилась твоя анкета:');

  const caption = `${liker.name}, ${liker.age} г., г. ${liker.city}${liker.username ? ' (@' + liker.username + ')' : ''}\n\n${liker.description}`;
  await ctx.replyWithPhoto(liker.photoFileId, {
    caption,
    ...Markup.inlineKeyboard([
      [Markup.button.callback('❤️', 'like_liker'), Markup.button.callback('👎', 'dislike_liker')]
    ])
  });
};

// Команда для запуска BTS Clicker
bot.command('bts', async (ctx) => {
  await ctx.reply('🎮 Запустить BTS Clicker', {
    reply_markup: {
      inline_keyboard: [[
        { 
          text: '🐰 Играть', 
          web_app: { url: 'https://твой-сайт.com/bts-clicker/' } 
        }
      ]]
    }
  });
});

// ============================================
// КОМАНДЫ АДМИНИСТРАТОРА
// ============================================
const OWNER_ID = 5729593990; // ← ЗАМЕНИ НА СВОЙ ID
const ADMIN_IDS = [5729593990];

bot.command('stats', async (ctx) => {
  if (!ADMIN_IDS.includes(ctx.from.id) && ctx.from.id !== OWNER_ID)
    return ctx.reply('Недоступно.');
  const total = await User.countDocuments();
  const active = await User.countDocuments({ active: true });
  const likes = await Like.countDocuments({ type: 'like' });
  const matches = await Match.countDocuments();
  await ctx.reply(`📊 Статистика:\n👥 Всего: ${total}\n✅ Активных: ${active}\n❤️ Лайков: ${likes}\n💕 Мэтчей: ${matches}`);
});

bot.command('broadcast', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.reply('Только для владельца.');
  const text = ctx.message.text.replace('/broadcast', '').trim();
  if (!text) return ctx.reply('Использование: /broadcast <текст>');
  const users = await User.find({}, 'telegramId');
  let ok = 0, fail = 0;
  await ctx.reply('⏳ Рассылка...');
  for (const u of users) {
    try {
      await ctx.telegram.sendMessage(u.telegramId, text);
      ok++;
      await new Promise(r => setTimeout(r, 50));
    } catch { fail++; }
  }
  await ctx.reply(`✅ Успешно: ${ok}\n❌ Не удалось: ${fail}`);
});

// ============================================
// СТАРТ
// ============================================
bot.start(async (ctx) => {
  const user = await getUser(ctx.from.id);
  if (!user) {
    ctx.session = { step: 'name' };
    return ctx.reply('Привет! Давай найдем тебе сладкую омежку или чбчг альфу?)\nКак тебя зовут?');
  }
  await ctx.reply('С возвращением!', mainMenu(user));
});

// ============================================
// РЕГИСТРАЦИЯ
// ============================================
bot.on('text', async (ctx) => {
  const { id } = ctx.from;
  const { step } = ctx.session || {};
  if (!step) return handleMenu(ctx, id, ctx.message.text);

  try {
    if (step === 'name') {
      ctx.session.name = ctx.message.text;
      ctx.session.step = 'age';
      await ctx.reply('Сколько тебе лет?');
    } else if (step === 'age') {
      const age = parseInt(ctx.message.text);
      if (isNaN(age) || age < 0 || age > 100)
        return ctx.reply('Введи число от 0 до 100.');
      ctx.session.age = age;
      ctx.session.step = 'city';
      await ctx.reply('Из какого ты города?');
    } else if (step === 'city') {
      ctx.session.city = ctx.message.text;
      ctx.session.step = 'gender';
      await ctx.reply('Твой пол?', Markup.keyboard([['Я парень', 'Я девушка']]).oneTime().resize());
    } else if (step === 'gender') {
      ctx.session.gender = { 'Я парень': 'male', 'Я девушка': 'female'}[ctx.message.text] || 'other';
      ctx.session.step = 'lookingFor';
      await ctx.reply('Кого будем искать??', Markup.keyboard([['Парни', 'Девушки', 'Все равно']]).oneTime().resize());
    } else if (step === 'lookingFor') {
      ctx.session.lookingFor = { 'Парни': 'male', 'Девушки': 'female', 'Все равно': 'all' }[ctx.message.text] || 'all';
      ctx.session.step = 'description';
      await ctx.reply('Расскажи о себе (с каким запахом омежку хочешь найти или насколько ревнивым должен быть твой чбчг дадду?)');
    } else if (step === 'description') {
      ctx.session.description = ctx.message.text;
      ctx.session.step = 'photo';
      await ctx.reply('Отправь своё фото.');
    } else {
      ctx.session = null;
      await ctx.reply('Что-то пошло не так. Начни /start');
    }
  } catch (e) {
    console.error(e);
    await ctx.reply('Ошибка. Попробуй позже.');
    ctx.session = null;
  }
});

// ============================================
// ФОТО
// ============================================
bot.on('photo', async (ctx) => {
  const { id } = ctx.from;
  const { step, editStep } = ctx.session || {};

  const fileId = ctx.message.photo.pop().file_id;

  // Редактирование фото
  if (editStep === 'editPhoto') {
    await updateField(id, 'photoFileId', fileId);
    ctx.session = null;
    return ctx.reply('✅ Фото обновлено!', mainMenu(await getUser(id)));
  }

  // Завершение регистрации
  if (step === 'photo') {
    const newUser = await createUser(id, {
      firstName: ctx.from.first_name,
      username: ctx.from.username,
      name: ctx.session.name,
      age: ctx.session.age,
      city: ctx.session.city,
      gender: ctx.session.gender,
      lookingFor: ctx.session.lookingFor,
      description: ctx.session.description,
      photoFileId: fileId
    });
    ctx.session = null;
    await showMyProfile(ctx, newUser);
    await ctx.reply('Всё верно?', Markup.inlineKeyboard([
      [Markup.button.callback('✅ Да', 'confirm_ok')],
      [Markup.button.callback('✏️ Редактировать', 'confirm_edit')]
    ]));
    return;
  }

  await ctx.reply('Сейчас не нужно фото.');
});

// ============================================
// ИНЛАЙН-КНОПКИ
// ============================================
bot.action('confirm_ok', async (ctx) => {
  console.log('back action started');
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const user = await getUser(ctx.from.id);
  await ctx.reply('Отлично!', mainMenu(user));
});

bot.action('confirm_edit', async (ctx) => {
  console.log('back action started');
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await ctx.reply('Выбери действие:', Markup.inlineKeyboard([
    [Markup.button.callback('1. Изменить фото', 'edit_photo')],
    [Markup.button.callback('2. Изменить описание', 'edit_description')],
    [Markup.button.callback('3. Заполнить заново', 'edit_restart')],
    [Markup.button.callback('4. Отмена', 'edit_cancel')]
  ]));
});

bot.action('edit_photo', async (ctx) => {
  console.log('back action started');
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  ctx.session = { editStep: 'editPhoto' };
  await ctx.reply('Отправь новое фото.');
});

bot.action('edit_description', async (ctx) => {
  console.log('back action started');
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  ctx.session = { editStep: 'editDescription' };
  await ctx.reply('Напиши новое описание.');
});

bot.action('edit_restart', async (ctx) => {
  console.log('back action started');
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await User.deleteOne({ telegramId: ctx.from.id });
  ctx.session = { step: 'name' };
  await ctx.reply('Начнём заново. Как тебя зовут?');
});

bot.action('edit_cancel', async (ctx) => {
  console.log('back action started');
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  ctx.session = null;
  const user = await getUser(ctx.from.id);
  await ctx.reply('Отменено.', mainMenu(user));
});

// ============================================
// ЛАЙК (основной)
// ============================================
// ЛАЙК (основной)
// ============================================
bot.action('like', async (ctx) => {
  console.log('like action started');
  await ctx.answerCbQuery();
  const fromId = ctx.from.id;
  const toId = ctx.session?.viewing;
  if (!toId) return ctx.reply('Ошибка.');

  try {
    await Like.create({ fromUser: fromId, toUser: toId, type: 'like' });
    const mutual = await Like.findOne({ fromUser: toId, toUser: fromId, type: 'like' });

    if (mutual) {
      await Match.create({ users: [fromId, toId] });
      
      // Получаем данные обоих пользователей
      const fromData = await getUser(fromId);
      const toData = await getUser(toId);

      // Функция для отправки анкеты и ссылки на имя
      const sendProfileAndLink = async (uid, other) => {
        // 1. Отправляем анкету
        const caption = `${other.name}, ${other.age} г., г. ${other.city}\n\n${other.description}`;
        await ctx.telegram.sendPhoto(uid, other.photoFileId, { caption });
        
        // 2. Формируем имя-ссылку
        let nameLink;
        if (other.username) {
          nameLink = `[${other.name}](t.me/${other.username})`;
        } else {
          nameLink = `[${other.name}](tg://user?id=${other.telegramId})`;
        }
        
        // 3. Отправляем сообщение с именем-ссылкой
        const text = `Отлично! Хорошо проведите время. Начинай общаться с ${nameLink}`;
        await ctx.telegram.sendMessage(uid, text, { parse_mode: 'Markdown' });
      };

      // Отправляем обоим
      await sendProfileAndLink(fromId, toData);
      await sendProfileAndLink(toId, fromData);
    } else {
      // Если не взаимно – просто лайк
      await ctx.reply('❤️ Лайк отправлен!');
      await sendLikeNotification(toId, fromId);
    }

    // Показываем следующую анкету (в любом случае, но после обработки)
    await showNextProfile(ctx, fromId);
  } catch (e) {
    if (e.code === 11000) await ctx.reply('Вы уже взаимодействовали с этим человеком.');
    else console.error(e);
    await showNextProfile(ctx, fromId);
  }
});

// ============================================
// ДИЗЛАЙК
// ============================================
// ============================================
// ДИЗЛАЙК
// ============================================
bot.action('dislike', async (ctx) => {
  // 1. Обязательно сразу отвечаем на callback, чтобы убрать "часики" на кнопке
  await ctx.answerCbQuery();
  
  const fromId = ctx.from.id;
  const toId = ctx.session?.viewing;

  // 2. Если есть, кому ставим дизлайк — сохраняем это в базу данных
  if (toId) {
    try {
      // Пытаемся создать запись о дизлайке
      await Like.create({ fromUser: fromId, toUser: toId, type: 'dislike' });
      console.log(`Пользователь ${fromId} дизлайкнул ${toId}`);
    } catch (e) {
      // Если запись уже есть (код 11000) — просто игнорируем
      if (e.code !== 11000) {
        console.error('Ошибка при сохранении дизлайка:', e);
      }
    }
  }

  // 3. Короткое сообщение, что действие принято (можно убрать, если мешает)
  await ctx.reply('👎 Ок');

  // 4. Пытаемся показать следующую анкету
  try {
    await showNextProfile(ctx, fromId);
  } catch (error) {
    console.error('Ошибка при показе следующей анкеты после дизлайка:', error);
    // Если showNextProfile упала, просто скажем пользователю, что что-то не так
    await ctx.reply('Не удалось загрузить следующую анкету. Попробуй ещё раз.');
  }
});
// ============================================
// НАЗАД ИЗ ПРОСМОТРА
// ============================================
bot.action('back', async (ctx) => {
  console.log('back action started');
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await ctx.reply('Выбери действие:', Markup.inlineKeyboard([
    [Markup.button.callback('1. Моя анкета', 'back_myprofile')],
    [Markup.button.callback('2. Продолжить', 'back_continue')],
    [Markup.button.callback('3. Не искать', 'back_deactivate')]
  ]));
});

bot.action('back_myprofile', async (ctx) => {
  console.log('back action started');
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const user = await getUser(ctx.from.id);
  await showMyProfile(ctx, user);
  await ctx.reply('Что хочешь?', Markup.inlineKeyboard([
    [Markup.button.callback('1. Изменить фото', 'edit_photo')],
    [Markup.button.callback('2. Изменить описание', 'edit_description')],
    [Markup.button.callback('3. Заполнить заново', 'edit_restart')],
    [Markup.button.callback('4. В меню', 'back_to_menu')]
  ]));
});

bot.action('back_continue', async (ctx) => {
  console.log('back action started');
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await showNextProfile(ctx, ctx.from.id);
});

bot.action('back_deactivate', async (ctx) => {
  console.log('back action started');
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await updateField(ctx.from.id, 'active', false);
  const user = await getUser(ctx.from.id);
  await ctx.reply('Анкета скрыта. Для активации нажми "▶️ Начать поиск".', mainMenu(user));
});

bot.action('back_to_menu', async (ctx) => {
  console.log('back action started');
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const user = await getUser(ctx.from.id);
  await ctx.reply('Главное меню:', mainMenu(user));
});

// ============================================
// ПРОСМОТР ЛАЙКОВ – КНОПКИ
// ============================================
bot.action('view_likers', async (ctx) => {
  console.log('back action started');
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await showNextLiker(ctx, ctx.from.id);
});

bot.action('skip_likers', async (ctx) => {
  console.log('back action started');
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
});

bot.action('like_liker', async (ctx) => {
  console.log('like_liker action started');
  await ctx.answerCbQuery();
  const { id } = ctx.from;
  const likerId = ctx.session?.currentLikerId;
  const likeId = ctx.session?.currentLikeId;
  if (!likerId || !likeId) return ctx.reply('Ошибка');

  try {
    await Like.create({ fromUser: id, toUser: likerId, type: 'like' });
    const mutual = await Like.findOne({ fromUser: likerId, toUser: id, type: 'like' });

    if (mutual) {
      await Match.create({ users: [id, likerId] });
      
      // Получаем данные обоих пользователей
      const fromData = await getUser(id);
      const toData = await getUser(likerId);

      // Функция для отправки анкеты и ссылки на имя
      const sendProfileAndLink = async (uid, other) => {
        // 1. Отправляем анкету
        const caption = `${other.name}, ${other.age} г., г. ${other.city}\n\n${other.description}`;
        await ctx.telegram.sendPhoto(uid, other.photoFileId, { caption });
        
        // 2. Формируем имя-ссылку
        let nameLink;
        if (other.username) {
          nameLink = `[${other.name}](t.me/${other.username})`;
        } else {
          nameLink = `[${other.name}](tg://user?id=${other.telegramId})`;
        }
        
        // 3. Отправляем сообщение с именем-ссылкой
        const text = `Отлично! Хорошо проведите время. Начинай общаться с ${nameLink}`;
        await ctx.telegram.sendMessage(uid, text, { parse_mode: 'Markdown' });
      };

      // Отправляем обоим
      await sendProfileAndLink(id, toData);
      await sendProfileAndLink(likerId, fromData);
    } else {
      await ctx.reply('❤️ Лайк отправлен!');
    }
  } catch (e) {
    if (e.code === 11000) await ctx.reply('Уже было');
    else console.error(e);
  }

  ctx.session.currentIdx+
  await showNextNormal(ctx, id);
});
// ============================================
// ОБРАБОТКА РЕДАКТИРОВАНИЯ ОПИСАНИЯ
// ============================================
const handleEdit = async (ctx, userId, text) => {
  await updateField(userId, 'description', text);
  ctx.session = null;
  await ctx.reply('✅ Описание обновлено!', mainMenu(await getUser(userId)));
};

// ============================================
// ОБРАБОТКА МЕНЮ
// ============================================
const handleMenu = async (ctx, userId, text) => {
  const user = await getUser(userId);
  if (!user) {
    if (text === '📝 Создать анкету') {
      ctx.session = { step: 'name' };
      return ctx.reply('Как тебя зовут?');
    }
    return ctx.reply('Нажми /start');
  }

  if (text === '👀 Смотреть анкеты' || text === '▶️ Начать поиск') {
    if (text === '▶️ Начать поиск') await updateField(userId, 'active', true);
    return showNextProfile(ctx, userId);
  }
  if (text === '📝 Моя анкета') {
    await showMyProfile(ctx, user);
    return ctx.reply('Что хочешь?', Markup.inlineKeyboard([
      [Markup.button.callback('1. Изменить фото', 'edit_photo')],
      [Markup.button.callback('2. Изменить описание', 'edit_description')],
      [Markup.button.callback('3. Заполнить заново', 'edit_restart')],
      [Markup.button.callback('4. В меню', 'back_to_menu')]
    ]));
  }
  if (text === '✏️ Редактировать анкету') {
    return ctx.reply('Выбери действие:', Markup.inlineKeyboard([
      [Markup.button.callback('1. Изменить фото', 'edit_photo')],
      [Markup.button.callback('2. Изменить описание', 'edit_description')],
      [Markup.button.callback('3. Заполнить заново', 'edit_restart')],
      [Markup.button.callback('4. Отмена', 'edit_cancel')]
    ]));
  }
  await ctx.reply('Не понял.', mainMenu(user));
};

// ============================================
// ЗАПУСК
// ============================================
bot.launch();
console.log('🤖 Бот запущен...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));