const mongoose = require('mongoose');

const likeSchema = new mongoose.Schema({
  fromUser: { type: Number, required: true },
  toUser: { type: Number, required: true },
  notified: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

likeSchema.index({ fromUser: 1, toUser: 1 }, { unique: true });

module.exports = mongoose.model('Like', likeSchema);