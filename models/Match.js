const mongoose = require('mongoose');

const matchSchema = new mongoose.Schema({
  users: [{ type: Number }],
  matchedAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Match', matchSchema);