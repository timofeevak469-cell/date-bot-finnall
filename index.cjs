// Подключаем библиотеки
require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const mongoose = require('mongoose');
const LocalSession = require('telegraf-session-local');

// Подключаем наши модели
const User = require('./models/User');
const Like = require('./models/Like');
const Match = require('./models/Match');

// Создаём бота с токеном из .env
const bot = new Telegraf(process.env.BOT_TOKEN);

// Подключаем сессии (хранятся в файле sessions.json)
bot.use(new LocalSession({ database: 'sessions.json' }).middleware());

// Подключаемся к базе данных MongoDB (локально)
mongoose.connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('✅ База данных подключена');
    // Миграция: добавляем поле active старым пользователям (если его нет)
    User.updateMany({ active: { $exists: false } }, { $set: { active: true } })
      .then(result => console.log(`✅ Обновлено ${result.modifiedCount} пользователей: добавлено active=true`))
      .catch(err => console.error('❌ Ошибка при обновлении active:', err));
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

// Показать свою анкету
async function showMyProfile(ctx, user) {
  const caption = `${user.name}, ${user.age}\n\n${user.description}`;
  await ctx.replyWithPhoto(user.photoFileId, { caption });
}

// Показать следующую анкету для лайков
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

  const caption = `${candidate.name}, ${candidate.age}\n\n${candidate.description}`;
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

// Показать следующего лайкнувшего (для просмотра лайков)
async function showNextLiker(ctx, userId) {
  // Находим непросмотренные лайки в сторону этого пользователя
  const like = await Like.findOne({ 
    toUser: userId, 
    notified: false 
  }).sort({ createdAt: 1 }); // сначала старые

  if (!like) {
    await ctx.reply('Больше нет анкет для просмотра.');
    return;
  }

  const liker = await User.findOne({ telegramId: like.fromUser });
  if (!liker) {
    // Странно, но удалим лайк
    await Like.deleteOne({ _id: like._id });
    await showNextLiker(ctx, userId); // рекурсивно пробуем следующего
    return;
  }

  // Сохраняем в сессию ID текущего просматриваемого лайка
  ctx.session = { viewingLiker: like._id.toString() };

  const caption = `${liker.name}, ${liker.age}\n\n${liker.description}`;
  await ctx.replyWithPhoto(liker.photoFileId, {
    caption,
    ...Markup.inlineKeyboard([
      [
        Markup.button.callback('❤️', 'like_liker'),
        Markup.button.callback('👎', 'dislike_liker'),
        Markup.button.callback('🔙', 'back_liker')
      ]
    ])
  });
}

// ---------- Главное меню (клавиатура) ----------
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

// ---------- Команда /start ----------
bot.start(async (ctx) => {
  const userId = ctx.from.id;
  const user = await getUser(userId);
  if (!user) {
    ctx.session = { step: 'name' };
    await ctx.reply('Привет! Давай создадим твою анкету.\nКак тебя зовут?');
  } else {
    await ctx.reply('Ты уже зарегистрирован. Что хочешь сделать?',
      Markup.inlineKeyboard([
        [Markup.button.callback('📝 Создать новую анкету', 'start_new')],
        [Markup.button.callback('✅ Продолжить со старой', 'start_old')]
      ]));
  }
});

// ---------- Обработка всех текстовых сообщений ----------
bot.on('text', async (ctx) => {
  const userId = ctx.from.id;
  const text = ctx.message.text;

  // Регистрация
  if (ctx.session && ctx.session.step) {
    await handleRegistration(ctx, userId, text);
    return;
  }

  // Редактирование (ввод описания)
  if (ctx.session && ctx.session.editStep === 'editDescription') {
    await handleEdit(ctx, userId, text);
    return;
  }

  // Обычное меню (текстовые кнопки)
  await handleMenu(ctx, userId, text);
});

// ---------- Регистрация (по шагам) ----------
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
        ctx.session.step = 'gender';
        await ctx.reply('Твой пол?', Markup.keyboard([
          ['Парень', 'Девушка',]
        ]).oneTime().resize());
        break;
      case 'gender':
        let gender = '';
        if (text === 'Парень') gender = 'male';
        else if (text === 'Девушка') gender = 'female';
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
        await ctx.reply('Напиши немного о себе (Какой запах омежки предпочитаешь?)).');
        break;
      case 'description':
        ctx.session.description = text;
        ctx.session.step = 'photo';
        await ctx.reply('Отправь своё фото.');
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
  // Редактирование фото
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

  // Регистрация (завершение)
  if (ctx.session && ctx.session.step === 'photo') {
    try {
      const userData = {
        firstName: ctx.from.first_name,
        username: ctx.from.username,
        name: ctx.session.name,
        age: ctx.session.age,
        gender: ctx.session.gender,
        lookingFor: ctx.session.lookingFor,
        description: ctx.session.description,
        photoFileId: fileId,
        active: true
      };
      const newUser = await createUser(userId, userData);
      ctx.session = null;

      await showMyProfile(ctx, newUser);
      await ctx.reply('Всё верно?\n1. Да\n2. Редактировать',
        Markup.inlineKeyboard([
          [Markup.button.callback('1', 'confirm_ok')],
          [Markup.button.callback('2', 'confirm_edit')]
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
  await ctx.reply('Выбери действие:\n1. Изменить фото\n2. Изменить описание\n3. Заполнить анкету заново\n4. Отмена',
    Markup.inlineKeyboard([
      [Markup.button.callback('1', 'edit_photo')],
      [Markup.button.callback('2', 'edit_description')],
      [Markup.button.callback('3', 'edit_restart')],
      [Markup.button.callback('4', 'edit_cancel')]
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
// Лайк (в просмотре анкет)
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
      // Если лайк поставили текущему пользователю (т.е. toUserId === ctx.from.id?) – но здесь fromUserId это текущий, toUserId другой.
      // Проверим, нужно ли отправить уведомление тому, кого лайкнули.
      // Это будет в обработчике лайка от другого пользователя, а здесь мы отправили лайк другому, значит уведомление получит другой.
      // Мы должны уведомить toUserId о новом лайке, если это не взаимность.
      // Для этого нужно отправить сообщение пользователю toUserId.
      // Но здесь мы не можем просто так отправить, потому что это может быть асинхронно.
      // Лучше в момент создания лайка проверить, если это не взаимность и лайк поставили не себе, то отправить уведомление получателю.
      // Перенесём логику уведомления в отдельную функцию и вызовем после создания лайка, если не взаимность.
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

// Дизлайк (в просмотре анкет)
bot.action('dislike', async (ctx) => {
  await ctx.answerCbQuery();
  const fromUserId = ctx.from.id;
  await ctx.reply('👎 Пропускаем...');
  await showNextProfile(ctx, fromUserId);
});

// Назад (выход из просмотра анкет)
bot.action('back', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage(); // удаляем анкету
  const userId = ctx.from.id;
  await ctx.reply('Выбери действие:\n1. Моя анкета\n2. Продолжить\n3. Не искать',
    Markup.inlineKeyboard([
      [Markup.button.callback('1', 'back_myprofile')],
      [Markup.button.callback('2', 'back_continue')],
      [Markup.button.callback('3', 'back_deactivate')]
    ]));
});

// Назад -> Моя анкета
bot.action('back_myprofile', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  const user = await getUser(userId);
  await showMyProfile(ctx, user);
  await ctx.reply('Что хочешь сделать?\n1. Изменить фото\n2. Изменить описание\n3. Заполнить анкету заново\n4. Вернуться в меню',
    Markup.inlineKeyboard([
      [Markup.button.callback('1', 'edit_photo')],
      [Markup.button.callback('2', 'edit_description')],
      [Markup.button.callback('3', 'edit_restart')],
      [Markup.button.callback('4', 'back_to_menu')]
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
// ---------- Обработка уведомлений о лайках ----------
// Функция для отправки уведомления о новом лайке
async function sendLikeNotification(toUserId, fromUserId) {
  const toUser = await getUser(toUserId);
  if (!toUser) return;
  const fromUser = await getUser(fromUserId);
  if (!fromUser) return;

  // Проверяем, есть ли непросмотренные лайки у этого пользователя
  const count = await Like.countDocuments({ toUser: toUserId, notified: false });
  const text = count > 1 
    ? `✨ У тебя ${count} новых лайков! Посмотрим?`
    : `✨ Кому-то понравилась твоя анкета. Посмотрим?;`

  await bot.telegram.sendMessage(toUserId, text, 
    Markup.inlineKeyboard([
      [Markup.button.callback('Да', 'view_likers'), Markup.button.callback('Нет', 'skip_likers')]
    ]));
}

// Обработчик "Да" на уведомление о лайках
bot.action('view_likers', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage(); // удаляем уведомление
  const userId = ctx.from.id;
  await showNextLiker(ctx, userId);
});

// Обработчик "Нет" на уведомление
bot.action('skip_likers', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  // Ничего не делаем, просто закрываем
});

// Обработчики для просмотра лайков
bot.action('like_liker', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const likeId = ctx.session?.viewingLiker;
  if (!likeId) {
    await ctx.reply('Ошибка. Попробуй снова.');
    return;
  }

  const like = await Like.findById(likeId);
  if (!like) {
    await ctx.reply('Этот лайк уже не существует.');
    await showNextLiker(ctx, userId);
    return;
  }

  const fromUserId = like.fromUser;
  const toUserId = like.toUser;

  // Удаляем лайк, так как мы на него ответили (теперь взаимность)
  await Like.deleteOne({ _id: likeId });

  // Проверяем взаимность
  const mutual = await Like.findOne({ fromUser: toUserId, toUser: fromUserId });
  if (mutual) {
    await Match.create({ users: [fromUserId, toUserId] });
    await ctx.telegram.sendMessage(fromUserId, '🎉 Взаимная симпатия!');
    await ctx.telegram.sendMessage(toUserId, '🎉 Взаимная симпатия!');
  } else {
    // Если ещё нет взаимного лайка, создаём его? Нет, мы уже лайкнули в ответ, значит нужно создать лайк от текущего к лайкнувшему.
    // Но мы уже удалили исходный лайк. Создадим новый лайк от текущего к лайкнувшему.
    await Like.create({ fromUser: toUserId, toUser: fromUserId, notified: false });
    await ctx.reply('❤️ Лайк отправлен!');
    // Также нужно уведомить другую сторону о новом лайке? Если она ещё не видела? Но мы не знаем. Можно не уведомлять, т.к. она уже получила уведомление ранее.
  }

  // Показываем следующего лайкера
  await showNextLiker(ctx, userId);
});

bot.action('dislike_liker', async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const likeId = ctx.session?.viewingLiker;
  if (!likeId) {
    await ctx.reply('Ошибка. Попробуй снова.');
    return;
  }

  // Помечаем лайк как просмотренный (notified = true), чтобы больше не показывать
  await Like.updateOne({ _id: likeId }, { $set: { notified: true } });
  await ctx.reply('👎 Пропускаем...');
  await showNextLiker(ctx, userId);
});

bot.action('back_liker', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.deleteMessage();
  const userId = ctx.from.id;
  const user = await getUser(userId);
  await ctx.reply('Главное меню:', mainMenu(user));
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
// ---------- Обработка обычного меню (текстовые кнопки) ----------
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
    await ctx.reply('Что хочешь сделать?\n1. Изменить фото\n2. Изменить описание\n3. Заполнить анкету заново\n4. Вернуться в меню',
      Markup.inlineKeyboard([
        [Markup.button.callback('1', 'edit_photo')],
        [Markup.button.callback('2', 'edit_description')],
        [Markup.button.callback('3', 'edit_restart')],
        [Markup.button.callback('4', 'back_to_menu')]
      ]));
  } else if (text === '✏️ Редактировать анкету') {
    await ctx.reply('Выбери действие:\n1. Изменить фото\n2. Изменить описание\n3. Заполнить анкету заново\n4. Отмена',
      Markup.inlineKeyboard([
        [Markup.button.callback('1', 'edit_photo')],
        [Markup.button.callback('2', 'edit_description')],
        [Markup.button.callback('3', 'edit_restart')],
        [Markup.button.callback('4', 'edit_cancel')]
      ]));
  } else {
    await ctx.reply('Не понял команду. Используй кнопки меню.');
  }
}

// ---------- Запуск бота ----------
bot.launch();
console.log('🤖 Бот запущен...');

// Корректное завершение
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));