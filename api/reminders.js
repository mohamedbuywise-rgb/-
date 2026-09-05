import remindersHandler from '../backend/api-handlers/reminders.js';

export default async function handler(req, res) {
  return remindersHandler(req, res);
}

