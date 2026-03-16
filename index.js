// Подключаем библиотеки
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const LocalSession = require('telegraf-session-local');

// Подключаем модели
const User = require('./models/User');
const Like = require('./models/Like');
const Match = require('./models/Match');

// Создаём бота
const bot = new Telegraf(process.env.BOT_TOKEN);

// Подключаем сессии в MongoDB
//const session = new MongoSession({ url: process.env.MONGODB_URI });
//bot.use(session.middleware());
bot.use(new LocalSession({ database: 'sessions.json' }).middleware());
// Подключаемся к базе данных
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ База данных подключена');
    // Миграция: добавляем поле active старым пользователям
    User.updateMany({ active: { $exists: false } }, { $set: { active: true } })
      .then(result => console.log(`✅ Обновлено ${result.modifiedCount} пользователей: active=true`))
      .catch(err => console.error('❌ Ошибка миграции active:', err));
  })
  .catch(err => console.error('❌ Ошибка подключения к БД:', err));

// ---------- Вспомогательные функции ----------
async function getUser(telegramId) {
  return await User.findOne({ telegramId });
}

async function createUser(telegramId, data) {
  const user = new User({ telegramId, ...data, active: true });
  return await user.save();
}

async function updateUserField(telegramId, field, value) {
  const update = {};
  update[field] = value;
  update.updatedAt = Date.now();
  return await User.findOneAndUpdate({ telegramId }, update, { new: true });
}

// Функция отправки уведомления о лайках (кумулятивное)
async function sendLikeNotification(toUserId, fromUserId) {
  const toUser = await getUser(toUserId);
  if (!toUser) return;

  const count = await Like.countDocuments({ toUser: toUserId, notified: false });
  if (count === 0) return;

  const text = `✨ У тебя ${count} новых лайков! Посмотрим?`;
  await bot.telegram.sendMessage(toUserId, text, Markup.inlineKeyboard([
    [Markup.button.callback('Да', 'view_likers')],
    [Markup.button.callback('Нет', 'skip_likers')]
  ]));
}

// ---------- Показать свою анкету (с городом) ----------
async function showMyProfile(ctx, user) {
  const caption = `${user.name}, ${user.age}, г. ${user.city}\n\n${user.description}`;
  await ctx.replyWithPhoto(user.photoFileId, { caption });
}

// ---------- Показать следующую анкету для лайков (основной просмотр) ----------
async function showNextProfile(ctx, currentUserId) {
  const currentUser = await getUser(currentUserId);
  if (!currentUser) {
    await ctx.reply('Сначала создай анкету через /start');
    return;
  }

  const filter = {
    telegramId: { $ne: currentUserId },
    gender: currentUser.lookingFor === 'all'
      ? { $in: ['male', 'female', 'other'] }
      : currentUser.lookingFor,
    active: true
  };

  const likedUsers = await Like.find({ fromUser: currentUserId }).select('toUser');
  const likedIds = likedUsers.map(l => l.toUser);
  filter.telegramId = { $nin: [currentUserId, ...likedIds] };

  const candidate = await User.findOne(filter);
  if (!candidate) {
    await ctx.reply('😕 Больше нет анкет для показа. Загляни позже!');
    return;
  }

  ctx.session = { viewing: candidate.telegramId };

  const caption = `${candidate.name}, ${candidate.age}, г. ${candidate.city}\n\n${candidate.description}`;
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
}

// ---------- Показать следующую анкету в очереди лайков (с городом) ----------
async function showNextLiker(ctx, userId) {
  const likes = await Like.find({ toUser: userId, notified: false }).sort({ createdAt: 1 });
  if (likes.length === 0) {
    await ctx.reply('Больше нет анкет для просмотра.', mainMenu(await getUser(userId)));
    return;
  }

  const likerIds = likes.map(l => l.fromUser);
  const likers = await User.find({ telegramId: { $in: likerIds } });

  const mutualLikers = [];
  const normalLikers = [];

  for (const like of likes) {
    const liker = likers.find(u => u.telegramId === like.fromUser);
    if (!liker) continue;

    const isMutual = await Match.exists({ users: { $all: [userId, liker.telegramId] } });
    if (isMutual) {
      mutualLikers.push({ like, liker });
    } else {
      normalLikers.push({ like, liker });
    }
  }

  for (const item of [...mutualLikers, ...normalLikers]) {
    await Like.updateOne({ _id: item.like._id }, { $set: { notified: true } });
  }

  // Показываем взаимных
  for (const item of mutualLikers) {
    const { liker } = item;
    let caption = `${liker.name}, ${liker.age}, г. ${liker.city}`;
    if (liker.username) {
      caption += ` (@${liker.username})`;
    }
    caption += `\n\n${liker.description}`;
    await ctx.replyWithPhoto(liker.photoFileId, { caption });

    let contactMsg = `👤 Контакт: ${liker.name}`;
    if (liker.username) {
      contactMsg += `\nЮзернейм: @${liker.username}\nПерейти: t.me/${liker.username}`;
    } else {
      contactMsg += `\n(у пользователя нет username)`;
    }
    await ctx.reply(contactMsg);
  }

  if (normalLikers.length === 0) {
    await ctx.reply('Все анкеты просмотрены!', mainMenu(await getUser(userId)));
    return;
  }

  ctx.session = {
    normalLikerQueue: normalLikers.map(item => ({
      likeId: item.like._id.toString(),
      likerId: item.liker.telegramId
    })),
    currentNormalIndex: 0
  };

  await showNextNormalLiker(ctx, userId);
}

// Функция для показа обычного лайка (с городом)
async function showNextNormalLiker(ctx, userId) {
  const queue = ctx.session?.normalLikerQueue;
  const index = ctx.session?.currentNormalIndex || 0;

  if (!queue || index >= queue.length) {
    ctx.session = null;
    await ctx.reply('Все анкеты просмотрены!', mainMenu(await getUser(userId)));
    return;
  }

  const item = queue[index];
  const liker = await getUser(item.likerId);
  if (!liker) {
    await Like.deleteOne({ _id: item.likeId });
    ctx.session.currentNormalIndex = index + 1;
    return showNextNormalLiker(ctx, userId);
  }

  ctx.session.currentLikerId = liker.telegramId;
  ctx.session.currentLikeId = item.likeId;

  let caption = `${liker.name}, ${liker.age}, г. ${liker.city}`;
  if (liker.username) {
    caption += ` (@${liker.username})`;
  }
  caption += `\n\n${liker.description}`;

  const keyboard = Markup.inlineKeyboard([
    [
      Markup.button.callback('❤️', 'like_liker'),
      Markup.button.callback('👎', 'dislike_liker')
    ]
  ]);

  await ctx.replyWithPhoto(liker.photoFileId, { caption, ...keyboard });
}

// ---------- Главное меню (reply-клавиатура) ----------
function mainMenu(user) {
  if (!user) {
    return Markup.keyboard([['📝 Создать анкету']]).resize();
  }
  if (user.active) {
    return Markup.keyboard([
      ['👀 Смотреть анкеты', '📝 Моя анкета'],
      ['✏️ Редактировать анкету']
    ]).resize();
  } else {
    return Markup.keyboard([
      ['▶️ Начать поиск', '📝 Моя анкета'],
      ['✏️ Редактировать анкету']
    ]).resize();
  }
}

// ---------- Команды администратора ----------
const OWNER_ID = 5729593990; // ЗАМЕНИ НА СВОЙ ID
const ADMIN_IDS = [5729593990]; // сюда можно добавить ID других администраторов

// Статистика для владельца и админов
bot.command('stats', async (ctx) => {
    console.log('stats command called by user', ctx.from.id);
    const isAdmin = ctx.from.id === OWNER_ID || ADMIN_IDS.includes(ctx.from.id);
    if (!isAdmin) return ctx.reply('Недоступно.');

    const totalUsers = await User.countDocuments({});
    const activeUsers = await User.countDocuments({ active: true });
    const totalLikes = await Like.countDocuments({});
    const totalMatches = await Match.countDocuments({});

    const msg = `📊 Статистика:\n👥 Всего пользователей: ${totalUsers}\n✅ Активных: ${activeUsers}\n❤️ Лайков: ${totalLikes}\n💕 Мэтчей: ${totalMatches}`;
});

// Рассылка (только для владельца)
bot.command('broadcast', async (ctx) => {
  if (ctx.from.id !== OWNER_ID) return ctx.reply('Только для владельца.');

  const text = ctx.message.text.replace('/broadcast', '').trim();
  if (!text) return ctx.reply('Использование: /broadcast <текст>');

  const users = await User.find({}, 'telegramId');
  let success = 0, fail = 0;
  await ctx.reply('⏳ Начинаю рассылку...');
  for (const user of users) {
    try {
      await ctx.telegram.sendMessage(user.telegramId, text);
      success++;
      await new Promise(resolve => setTimeout(resolve, 50));
    } catch (e) {
      fail++;
    }
  }
  await ctx.reply(`✅ Рассылка завершена.\nУспешно: ${success}\nНе удалось: ${fail}`);
});

// ---------- Команда /start ----------
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const user = await getUser(userId);
  if (!user) {
    ctx.session = { step: 'name' };
    await ctx.reply('Привет! Давай найдем тебе сладкую омежку или чбчг альфу?).\nКак тебя зовут?');
  } else {
    await ctx.reply('Ты уже зарегистрирован. Что хочешь сделать?',
      Markup.inlineKeyboard([
        [Markup.button.callback('📝 Создать новую анкету', 'start_new')],
        [Markup.button.callback('✅ Продолжить со старой', 'start_old')]
      ]));
  }
});

// ---------- Обработка текстовых сообщений ----------
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  if (ctx.session && ctx.session.step) {
    await handleRegistration(ctx, userId, text);
    return;
  }
  if (ctx.session && ctx.session.editStep === 'editDescription') {
    await handleEdit(ctx, userId, text);
    return;
  }
  await handleMenu(ctx, userId, text);
});

// ---------- Регистрация (с добавлением города) ----------
async function handleRegistration(ctx, userId, text) {
  const step = ctx.session.step;
  try {
    switch (step) {
      case 'name':
        ctx.session.name = text;
        ctx.session.step = 'age';
        await ctx.reply('Сколько тебе лет?');
        break;
      case 'age':
        const age = parseInt(text);
        if (isNaN(age) || age < 0 || age > 100) {
          await ctx.reply('Пожалуйста, введи корректный возраст (число от 0 до 100).');
          return;
        }
        ctx.session.age = age;
        ctx.session.step = 'city';
        await ctx.reply('Из какого ты города?');
        break;
      case 'city':
        ctx.session.city = text;
        ctx.session.step = 'gender';
        await ctx.reply('Твой пол?', Markup.keyboard([
          ['Я парень', 'Я девушка']
        ]).oneTime().resize());
        break;
      case 'gender':
        let gender = '';
        if (text === 'Я парень') gender = 'male';
        else if (text === 'Я девушка') gender = 'female';
        else gender = 'other';
        ctx.session.gender = gender;
        ctx.session.step = 'lookingFor';
        await ctx.reply('Кого будем искать?', Markup.keyboard([
          ['Парни', 'Девушки', 'Все равно']
        ]).oneTime().resize());
        break;
      case 'lookingFor':
        let lookingFor = '';
        if (text === 'Парни') lookingFor = 'male';
        else if (text === 'Девушки') lookingFor = 'female';
        else lookingFor = 'all';
        ctx.session.lookingFor = lookingFor;
        ctx.session.step = 'description';
        await ctx.reply('Расскажи о себе (с каким запахои должна быть омежка или насколько ревнивым должен быть твой чгчг дадду)');
        break;
      case 'description':
        ctx.session.description = text;
        ctx.session.step = 'photo';
        await ctx.reply('Отправь своё фото');
        break;
      default:
        ctx.session = null;
        await ctx.reply('Что-то пошло не так. Начни заново /start');
    }
  } catch (error) {
    console.error(error);
    await ctx.reply('Произошла ошибка. Попробуй позже.');
    ctx.session = null;
  }
}

// ---------- Обработка фото (регистрация и редактирование) ----------
bot.on('photo', async (ctx) => {
  const userId = ctx.from.id;
  const photos = ctx.message.photo;
  const fileId = photos[photos.length - 1].file_id;

  if (ctx.session && ctx.session.editStep === 'editPhoto') {
    try {
      await updateUserField(userId, 'photoFileId', fileId);
      ctx.session = null;
      const user = await getUser(userId);
      await ctx.reply('✅ Фото обновлено!', mainMenu(user));
    } catch (error) {
      console.error(error);
      await ctx.reply('Ошибка при обновлении фото.');
      ctx.session = null;
    }
    return;
  }

  if (ctx.session && ctx.session.step === 'photo') {
    try {
      const userData = {
        firstName: ctx.from.first_name,
        username: ctx.from.username,
        name: ctx.session.name,
        age: ctx.session.age,
        city: ctx.session.city,
        gender: ctx.session.gender,
        lookingFor: ctx.session.lookingFor,
        description: ctx.session.description,
        photoFileId: fileId,
        active: true
      };
      const newUser = await createUser(userId, userData);
      ctx.session = null;

      await showMyProfile(ctx, newUser);
      await ctx.reply('Всё верно?', Markup.inlineKeyboard([
        [Markup.button.callback('✅ Да', 'confirm_ok')],
        [Markup.button.callback('✏️ Редактировать', 'confirm_edit')]
      ]));
    } catch (error) {
      console.error(error);
      await ctx.reply('Ошибка при сохранении анкеты. Попробуй ещё раз /start');
      ctx.session = null;
    }
    return;
  }

  await ctx.reply('Сейчас не нужно фото. Используй меню.');
});

// ---------- Обработка инлайн-кнопок ----------
// Старт: создание новой анкеты
bot.action('start_new', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  await User.deleteOne({ telegramId: userId });
  await Like.deleteMany({ $or: [{ fromUser: userId }, { toUser: userId }] });
  await Match.deleteMany({ users: userId });
  ctx.session = { step: 'name' };
  await ctx.reply('Давай создадим новую анкету.\nКак тебя зовут?');
});

// Старт: продолжение со старой анкетой
bot.action('start_old', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  const user = await getUser(userId);
  await ctx.reply('С возвращением!', mainMenu(user));
});

// Подтверждение после регистрации: "Да"
bot.action('confirm_ok', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const user = await getUser(ctx.from.id);
  await ctx.reply('Отлично!', mainMenu(user));
});

// Подтверждение после регистрации: "Редактировать"
bot.action('confirm_edit', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  await ctx.reply('Выбери действие:', Markup.inlineKeyboard([
    [Markup.button.callback('1. Изменить фото', 'edit_photo')],
    [Markup.button.callback('2. Изменить описание', 'edit_description')],
    [Markup.button.callback('3. Заполнить анкету заново', 'edit_restart')],
    [Markup.button.callback('4. Отмена', 'edit_cancel')]
  ]));
});

// Редактирование: изменить фото
bot.action('edit_photo', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  ctx.session = { editStep: 'editPhoto' };
  await ctx.reply('Отправь новое фото.');
});

// Редактирование: изменить описание
bot.action('edit_description', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  ctx.session = { editStep: 'editDescription' };
  await ctx.reply('Напиши новое описание.');
});

// Редактирование: заполнить анкету заново
bot.action('edit_restart', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  await User.deleteOne({ telegramId: userId });
  ctx.session = { step: 'name' };
  await ctx.reply('Давай создадим анкету заново.\nКак тебя зовут?');
});

// Редактирование: отмена
bot.action('edit_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  ctx.session = null;
  const user = await getUser(ctx.from.id);
  await ctx.reply('Редактирование отменено.', mainMenu(user));
});

// Обработчик лайка (в основном просмотре анкет)
bot.action('like', async (ctx) => {
  await ctx.answerCbQuery();
  const fromUserId = ctx.from.id;
  const toUserId = ctx.session?.viewing;

  if (!toUserId) {
    await ctx.reply('Ошибка: не выбран пользователь. Начни поиск заново.');
    return;
  }

  try {
    await Like.create({ fromUser: fromUserId, toUser: toUserId });

    const mutual = await Like.findOne({ fromUser: toUserId, toUser: fromUserId });

    if (mutual) {
      await Match.create({ users: [fromUserId, toUserId] });
      await ctx.telegram.sendMessage(fromUserId, '🎉 Взаимная симпатия!');
      await ctx.telegram.sendMessage(toUserId, '🎉 Взаимная симпатия!');
    } else {
      await ctx.reply('❤️ Лайк отправлен!');
      await sendLikeNotification(toUserId, fromUserId);
    }

    await showNextProfile(ctx, fromUserId);
  } catch (error) {
    if (error.code === 11000) {
      await ctx.reply('Вы уже лайкали этого пользователя.');
      await showNextProfile(ctx, fromUserId);
    } else {
      console.error(error);
      await ctx.reply('Ошибка при отправке лайка.');
    }
  }
});

// Дизлайк (основной просмотр)
bot.action('dislike', async (ctx) => {
  await ctx.answerCbQuery();
  const fromUserId = ctx.from.id;
  await ctx.reply('👎 Пропускаем...');
  await showNextProfile(ctx, fromUserId);
});

// Назад (выход из просмотра анкет)
bot.action('back', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  await ctx.reply('Выбери действие:', Markup.inlineKeyboard([
    [Markup.button.callback('1. Моя анкета', 'back_myprofile')],
    [Markup.button.callback('2. Продолжить', 'back_continue')],
    [Markup.button.callback('3. Не искать', 'back_deactivate')]
  ]));
});

// Назад -> Моя анкета
bot.action('back_myprofile', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  const user = await getUser(userId);
  await showMyProfile(ctx, user);
  await ctx.reply('Что хочешь сделать?', Markup.inlineKeyboard([
    [Markup.button.callback('1. Изменить фото', 'edit_photo')],
    [Markup.button.callback('2. Изменить описание', 'edit_description')],
    [Markup.button.callback('3. Заполнить анкету заново', 'edit_restart')],
    [Markup.button.callback('4. Вернуться в меню', 'back_to_menu')]
  ]));
});

// Назад -> Продолжить
bot.action('back_continue', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  await showNextProfile(ctx, userId);
});

// Назад -> Не искать (скрыть анкету)
bot.action('back_deactivate', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  await updateUserField(userId, 'active', false);
  const user = await getUser(userId);
  await ctx.reply('Твоя анкета скрыта. Чтобы снова начать поиск, нажми "▶️ Начать поиск" в меню.', mainMenu(user));
});

// Вернуться в главное меню
bot.action('back_to_menu', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  const user = await getUser(userId);
  await ctx.reply('Главное меню:', mainMenu(user));
});

// Обработчик "Да" на уведомление о лайках
bot.action('view_likers', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  await showNextLiker(ctx, userId);
});

// Обработчик "Нет" на уведомление
bot.action('skip_likers', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
});

// Обработчики для кнопок в обычных лайках
bot.action('like_liker', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const likerId = ctx.session?.currentLikerId;
  const likeId = ctx.session?.currentLikeId;

  if (!likerId || !likeId) {
    await ctx.reply('Ошибка. Попробуйте снова.');
    return;
  }

  try {
    await Like.create({ fromUser: userId, toUser: likerId });
    const mutual = await Like.findOne({ fromUser: likerId, toUser: userId });
    if (mutual) {
      await Match.create({ users: [userId, likerId] });
      await ctx.telegram.sendMessage(userId, '🎉 Взаимная симпатия!');
      await ctx.telegram.sendMessage(likerId, '🎉 Взаимная симпатия!');
    } else {
      await ctx.reply('❤️ Лайк отправлен!');
    }
  } catch (error) {
    if (error.code === 11000) {
      await ctx.reply('Вы уже лайкали этого пользователя.');
    } else {
      console.error(error);
      await ctx.reply('Ошибка при отправке лайка.');
    }
  }

  const index = ctx.session.currentNormalIndex + 1;
  ctx.session.currentNormalIndex = index;
  await showNextNormalLiker(ctx, userId);
});

bot.action('dislike_liker', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const index = ctx.session.currentNormalIndex + 1;
  ctx.session.currentNormalIndex = index;
  await showNextNormalLiker(ctx, userId);
});

// ---------- Обработка редактирования (ввод описания) ----------
async function handleEdit(ctx, userId, text) {
  try {
    await updateUserField(userId, 'description', text);
    ctx.session = null;
    const user = await getUser(userId);
    await ctx.reply('✅ Описание обновлено!', mainMenu(user));
  } catch (error) {
    console.error(error);
    await ctx.reply('Ошибка при обновлении описания.');
    ctx.session = null;
  }
}

// ---------- Обработка главного меню (текстовые кнопки) ----------
async function handleMenu(ctx, userId, text) {
  const user = await getUser(userId);
  if (!user) {
    if (text === '📝 Создать анкету') {
      ctx.session = { step: 'name' };
      await ctx.reply('Как тебя зовут?');
    } else {
      await ctx.reply('Нажми /start, чтобы начать.');
    }
    return;
  }

  if (text === '👀 Смотреть анкеты' || text === '▶️ Начать поиск') {
    if (text === '▶️ Начать поиск') {
      await updateUserField(userId, 'active', true);
    }
    await showNextProfile(ctx, userId);
  } else if (text === '📝 Моя анкета') {
    await showMyProfile(ctx, user);
    await ctx.reply('Что хочешь сделать?', Markup.inlineKeyboard([
      [Markup.button.callback('1. Изменить фото', 'edit_photo')],
      [Markup.button.callback('2. Изменить описание', 'edit_description')],
      [Markup.button.callback('3. Заполнить анкету заново', 'edit_restart')],
      [Markup.button.callback('4. Вернуться в меню', 'back_to_menu')]
    ]));
  } else if (text === '✏️ Редактировать анкету') {
    await ctx.reply('Выбери действие:', Markup.inlineKeyboard([
      [Markup.button.callback('1. Изменить фото', 'edit_photo')],
      [Markup.button.callback('2. Изменить описание', 'edit_description')],
      [Markup.button.callback('3. Заполнить анкету заново', 'edit_restart')],
      [Markup.button.callback('4. Отмена', 'edit_cancel')]
    ]));
  } else {
    await ctx.reply('Не понял команду. Используй кнопки меню.');
  }
}

// ---------- Запуск бота ----------
bot.launch();
console.log('🤖 Бот запущен...');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));