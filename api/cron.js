// Turn-timer sweep. Called every 15 min by Supabase (2-timer-job.sql)
// and once a day by Vercel's cron as a backup. Needs: Authorization: Bearer <CRON_SECRET>
const { sweep, sendError } = require('./_lib/core');

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const secret = process.env.CRON_SECRET || '';
  if (!secret || (req.headers.authorization || '') !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });
  try { res.json({ ok: true, ...(await sweep()) }); }
  catch (e) { sendError(res, e); }
};
