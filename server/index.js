import 'dotenv/config'
import express from 'express'
import pg from 'pg'
import cors from 'cors'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { createServer } from 'node:http'
import { Server } from 'socket.io'

const { Pool } = pg

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL не задана в .env')
  process.exit(1)
}
if (!process.env.JWT_SECRET) {
  console.error('JWT_SECRET не задана в .env')
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('neon.tech')
    ? { rejectUnauthorized: true }
    : undefined,
  max: 5,
  connectionTimeoutMillis: 10000,
})

const app = express()
app.use(cors({ origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' }))
app.use(express.json({ limit: '4mb' }))

const roles = {
  engineer: 'Инженер',
  senior: 'Старший инженер',
  lead: 'Ведущий инженер',
  teamlead: 'Тимлид',
}
const validStatuses = ['new', 'in_progress', 'postponed', 'closed']

const schema = `
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'engineer'
    CHECK (role IN ('engineer', 'senior', 'lead', 'teamlead')),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  avatar TEXT NOT NULL DEFAULT '',
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  stat_date DATE NOT NULL,
  closed INTEGER NOT NULL DEFAULT 0 CHECK (closed >= 0),
  trip INTEGER NOT NULL DEFAULT 0 CHECK (trip >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, stat_date)
);
CREATE INDEX IF NOT EXISTS stats_date_idx ON stats(stat_date);

CREATE TABLE IF NOT EXISTS work_schedule (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_date DATE NOT NULL,
  is_working BOOLEAN NOT NULL DEFAULT TRUE,
  note TEXT NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (user_id, work_date)
);
ALTER TABLE work_schedule ADD COLUMN IF NOT EXISTS note TEXT NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS work_schedule_date_idx ON work_schedule(work_date);

CREATE TABLE IF NOT EXISTS tickets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  number TEXT NOT NULL,
  question TEXT NOT NULL,
  author_id UUID NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'new'
    CHECK (status IN ('new', 'in_progress', 'postponed', 'closed')),
  answer TEXT NOT NULL DEFAULT '',
  answered_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS tickets_created_at_idx ON tickets(created_at DESC);
CREATE INDEX IF NOT EXISTS tickets_author_idx ON tickets(author_id);

CREATE TABLE IF NOT EXISTS ticket_followups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES tickets(id) ON DELETE CASCADE,
  author_id UUID NOT NULL REFERENCES users(id),
  message TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  answer TEXT NOT NULL DEFAULT '',
  answered_by UUID REFERENCES users(id) ON DELETE SET NULL,
  answered_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS ticket_followups_ticket_idx ON ticket_followups(ticket_id, created_at);
`

async function initDb() {
  await pool.query(schema)
  console.log('PostgreSQL schema is ready')
}

const present = (u) => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  roleLabel: roles[u.role],
  avatar: u.avatar || '',
})

async function getUserById(id) {
  const { rows } = await pool.query(
    'SELECT id, name, email, role, active, avatar, password_hash FROM users WHERE id = $1',
    [id],
  )
  return rows[0] || null
}

const auth = async (req, res, next) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '')
    if (!token) return res.status(401).json({ error: 'Требуется вход в систему' })
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    const user = await getUserById(payload.sub)
    if (!user || !user.active) return res.status(401).json({ error: 'Пользователь недоступен' })
    req.user = user
    next()
  } catch {
    return res.status(401).json({ error: 'Сессия истекла, войдите снова' })
  }
}

const allow = (...rolesAllowed) => (req, res, next) =>
  rolesAllowed.includes(req.user.role)
    ? next()
    : res.status(403).json({ error: 'Недостаточно прав' })

const today = () =>
  new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Yekaterinburg' }).format(new Date())

async function clearPreviousMonthStats() {
  const monthStart = today().slice(0, 7) + '-01'
  const { rowCount } = await pool.query('DELETE FROM stats WHERE stat_date < $1::date', [monthStart])
  if (rowCount) console.log('Removed ' + rowCount + ' old daily-stat rows before ' + monthStart)
}

function scheduleMonthlyStatsCleanup() {
  const [year, month] = today().slice(0, 7).split('-').map(Number)
  const nextMonthStartUtc = Date.UTC(year, month, 1) - 5 * 60 * 60 * 1000
  const delay = Math.max(1000, nextMonthStartUtc - Date.now() + 1000)
  const timer = setTimeout(async () => {
    try {
      await clearPreviousMonthStats()
    } catch (error) {
      console.error('Monthly stats cleanup failed:', error.message)
    }
    scheduleMonthlyStatsCleanup()
  }, Math.min(delay, 2_000_000_000))
  timer.unref?.()
}

const httpServer = createServer(app)
const io = new Server(httpServer, {
  cors: { origin: process.env.CLIENT_ORIGIN || 'http://localhost:5173' },
})

io.use(async (socket, next) => {
  try {
    const token = socket.handshake.auth?.token
    if (!token) return next(new Error('Требуется вход'))
    const payload = jwt.verify(token, process.env.JWT_SECRET)
    const user = await getUserById(payload.sub)
    if (!user || !user.active) return next(new Error('Нет доступа'))
    socket.data.userId = String(user.id)
    next()
  } catch {
    next(new Error('Недействительная сессия'))
  }
})

const onlineUsers = new Map()
io.on('connection', (socket) => {
  const userId = socket.data.userId
  let sockets = onlineUsers.get(userId)
  if (!sockets) {
    sockets = new Set()
    onlineUsers.set(userId, sockets)
  }
  sockets.add(socket.id)
  io.emit('dashboard:refresh')
  socket.on('disconnect', () => {
    const activeSockets = onlineUsers.get(userId)
    if (!activeSockets) return
    activeSockets.delete(socket.id)
    if (activeSockets.size === 0) {
      onlineUsers.delete(userId)
      io.emit('dashboard:refresh')
    }
  })
})

app.post('/api/auth/login', async (req, res) => {
  const email = String(req.body.email || '').toLowerCase().trim()
  const password = String(req.body.password || '')
  const { rows } = await pool.query(
    'SELECT id, name, email, role, active, avatar, password_hash FROM users WHERE email = $1',
    [email],
  )
  const user = rows[0]
  if (!user || !user.active || !await bcrypt.compare(password, user.password_hash)) {
    return res.status(401).json({ error: 'Неверный email или пароль' })
  }
  const token = jwt.sign({ sub: user.id }, process.env.JWT_SECRET, { expiresIn: '7d' })
  res.json({ token, user: present(user) })
})

app.get('/api/auth/me', auth, (req, res) => res.json({ user: present(req.user) }))

// Vercel runs serverless functions, so presence is tracked in PostgreSQL, not an in-memory Socket.IO map.
app.post('/api/presence/heartbeat', auth, async (req, res) => {
  await pool.query('UPDATE users SET last_seen_at = NOW() WHERE id = $1', [req.user.id])
  res.json({ ok: true })
})

app.get('/api/dashboard', auth, async (req, res) => {
  const date = String(req.query.date || today())
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Некорректная дата' })
  }

  const { rows: users } = await pool.query(
    `SELECT id, name, email, role, active, avatar, last_seen_at
     FROM users WHERE active = TRUE ORDER BY name ASC`,
  )
  const { rows: stats } = await pool.query(
    'SELECT user_id, closed, trip FROM stats WHERE stat_date = $1',
    [date],
  )
  const previousDate = new Date(date + 'T00:00:00Z')
  previousDate.setUTCDate(previousDate.getUTCDate() - 7)
  const previousDateText = previousDate.toISOString().slice(0, 10)
  const { rows: previousStatsRows } = await pool.query(
    'SELECT user_id, closed, trip FROM stats WHERE stat_date = $1',
    [previousDateText],
  )
  const previousStats = previousStatsRows.reduce((totals, row) => ({
    closed: totals.closed + row.closed,
    trip: totals.trip + row.trip,
  }), { closed: 0, trip: 0 })
  const monthStart = `${date.slice(0, 7)}-01`
  const [year, month] = date.slice(0, 7).split('-').map(Number)
  const nextMonthDate = new Date(Date.UTC(year, month, 1))
  const nextMonth = `${nextMonthDate.getUTCFullYear()}-${String(nextMonthDate.getUTCMonth() + 1).padStart(2, '0')}-01`
  const { rows: monthlyStats } = await pool.query(
    `SELECT user_id, SUM(closed)::int AS closed, SUM(trip)::int AS trip
     FROM stats WHERE stat_date >= $1::date AND stat_date < $2::date
     GROUP BY user_id`,
    [monthStart, nextMonth],
  )

  const managersCanViewGroup = ['lead', 'teamlead'].includes(req.user.role)
  const weeklyWhere = 'WHERE stat_date >= $1::date AND stat_date < $2::date' + (managersCanViewGroup ? '' : ' AND user_id = $3')
  const weeklyStats = (await pool.query(
    "SELECT user_id AS \"userId\", TO_CHAR(date_trunc('week', stat_date), 'YYYY-MM-DD') AS \"weekStart\", SUM(closed)::int AS closed, SUM(trip)::int AS trip FROM stats " + weeklyWhere + " GROUP BY user_id, date_trunc('week', stat_date) ORDER BY \"weekStart\"",
    managersCanViewGroup ? [monthStart, nextMonth] : [monthStart, nextMonth, req.user.id],
  )).rows

  const ticketFilter = ['engineer', 'senior'].includes(req.user.role)
  const ticketQuery = ticketFilter
    ? `SELECT t.*, a.name AS author_name, a.avatar AS author_avatar,
              ab.name AS answered_by_name, ab.role AS answered_by_role
       FROM tickets t
       JOIN users a ON a.id = t.author_id
       LEFT JOIN users ab ON ab.id = t.answered_by
       WHERE t.author_id = $1
       ORDER BY t.created_at DESC LIMIT 100`
    : `SELECT t.*, a.name AS author_name, a.avatar AS author_avatar,
              ab.name AS answered_by_name, ab.role AS answered_by_role
       FROM tickets t
       JOIN users a ON a.id = t.author_id
       LEFT JOIN users ab ON ab.id = t.answered_by
       ORDER BY t.created_at DESC LIMIT 100`
  const { rows: tickets } = await pool.query(ticketQuery, ticketFilter ? [req.user.id] : [])
  const ticketIds = tickets.map((t) => t.id)
  let followUps = []
  if (ticketIds.length) {
    const result = await pool.query(
      `SELECT f.*, a.name AS author_name, ab.name AS answered_by_name, ab.role AS answered_by_role
       FROM ticket_followups f
       JOIN users a ON a.id = f.author_id
       LEFT JOIN users ab ON ab.id = f.answered_by
       WHERE f.ticket_id = ANY($1::uuid[])
       ORDER BY f.created_at ASC`,
      [ticketIds],
    )
    followUps = result.rows
  }

  const statsMap = new Map(stats.map((s) => [s.user_id, s]))
  const previousStatsMap = new Map(previousStatsRows.map((s) => [s.user_id, s]))
  const monthlyMap = new Map(monthlyStats.map((s) => [s.user_id, s]))
  const followUpsMap = new Map()
  for (const f of followUps) {
    if (!followUpsMap.has(f.ticket_id)) followUpsMap.set(f.ticket_id, [])
    followUpsMap.get(f.ticket_id).push({
      id: f.id,
      author: f.author_name || 'Сотрудник',
      message: f.message,
      createdAt: f.created_at,
      answer: f.answer || '',
      answeredBy: f.answered_by_name || '',
      answeredByRole: f.answered_by_role || '',
    })
  }

  res.json({
    date,
    previousStats,
    weeklyStats,
    monthlyUsers: users.map((u) => {
      const s = monthlyMap.get(u.id)
      return { ...present(u), closed: s?.closed || 0, trip: s?.trip || 0 }
    }),
    users: users.map((u) => {
      const s = statsMap.get(u.id)
      const previous = previousStatsMap.get(u.id)
      return {
        ...present(u),
        online: onlineUsers.has(String(u.id)) || Boolean(
          u.last_seen_at && Date.now() - new Date(u.last_seen_at).getTime() < 120_000,
        ),
        closed: s?.closed || 0,
        trip: s?.trip || 0,
        previousClosed: previous?.closed || 0,
        previousTrip: previous?.trip || 0,
        openTickets: tickets.filter((t) => t.author_id === u.id && t.status !== 'closed').length,
      }
    }),
    tickets: tickets.map((t) => ({
      id: t.id,
      number: t.number,
      question: t.question,
      status: t.status,
      answer: t.answer,
      author: t.author_name,
      authorAvatar: t.author_avatar || '',
      answeredBy: t.answered_by_name || undefined,
      answeredByRole: t.answered_by_role || undefined,
      followUps: followUpsMap.get(t.id) || [],
      createdAt: t.created_at,
      updatedAt: t.updated_at,
    })),
  })
})

async function saveStat(req, res, userId) {
  const date = String(req.body.date || today())
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return res.status(400).json({ error: 'Некорректная дата' })
  }
  const closed = Number(req.body.closed)
  const trip = Number(req.body.trip)
  if (!Number.isInteger(closed) || closed < 0 || !Number.isInteger(trip) || trip < 0) {
    return res.status(400).json({ error: 'Укажите целые неотрицательные значения' })
  }
  const { rows } = await pool.query(
    `INSERT INTO stats (user_id, stat_date, closed, trip)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, stat_date)
     DO UPDATE SET closed = EXCLUDED.closed, trip = EXCLUDED.trip, updated_at = NOW()
     RETURNING id, user_id AS "user", stat_date AS date, closed, trip, created_at AS "createdAt", updated_at AS "updatedAt"`,
    [userId, date, closed, trip],
  )
  return res.json(rows[0])
}

app.get('/api/schedule', auth, async (req, res) => {
  const month = String(req.query.month || today().slice(0, 7))
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return res.status(400).json({ error: 'Invalid month' })
  const [year, monthNumber] = month.split('-').map(Number)
  const nextMonthDate = new Date(Date.UTC(year, monthNumber, 1))
  const nextMonth = String(nextMonthDate.getUTCFullYear()) + '-' + String(nextMonthDate.getUTCMonth() + 1).padStart(2, '0') + '-01'
  const { rows } = await pool.query("SELECT TO_CHAR(work_date, 'YYYY-MM-DD') AS date, is_working AS working, note FROM work_schedule WHERE user_id = $1 AND work_date >= $2::date AND work_date < $3::date ORDER BY work_date", [req.user.id, month + '-01', nextMonth])
  res.json({ month, days: rows })
})

app.put('/api/schedule/:date', auth, async (req, res) => {
  const date = String(req.params.date || '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T12:00:00Z'))) return res.status(400).json({ error: 'Invalid date' })
  if (typeof req.body.working !== 'boolean') return res.status(400).json({ error: 'working must be true or false' })
  const { rows } = await pool.query("INSERT INTO work_schedule (user_id, work_date, is_working) VALUES ($1, $2::date, $3) ON CONFLICT (user_id, work_date) DO UPDATE SET is_working = EXCLUDED.is_working, updated_at = NOW() RETURNING TO_CHAR(work_date, 'YYYY-MM-DD') AS date, is_working AS working", [req.user.id, date, req.body.working])
  io.emit('dashboard:refresh')
  res.json(rows[0])
})
app.patch('/api/schedule/:date/note', auth, async (req, res) => {
  const date = String(req.params.date || '')
  const note = String(req.body.note || '').trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date + 'T12:00:00Z'))) return res.status(400).json({ error: 'Invalid date' })
  if (note.length > 2000) return res.status(400).json({ error: 'Note is too long' })
  const { rows } = await pool.query("INSERT INTO work_schedule (user_id, work_date, is_working, note) VALUES ($1, $2::date, FALSE, $3) ON CONFLICT (user_id, work_date) DO UPDATE SET note = EXCLUDED.note, updated_at = NOW() RETURNING TO_CHAR(work_date, 'YYYY-MM-DD') AS date, is_working AS working, note", [req.user.id, date, note])
  res.json(rows[0])
})
app.put('/api/stats/me', auth, async (req, res) => saveStat(req, res, req.user.id))
app.put('/api/stats/:userId', auth, allow('lead', 'teamlead'), async (req, res) => {
  const { rows } = await pool.query('SELECT id FROM users WHERE id = $1', [req.params.userId])
  if (!rows[0]) return res.status(404).json({ error: 'Сотрудник не найден' })
  return saveStat(req, res, req.params.userId)
})

app.post('/api/tickets', auth, async (req, res) => {
  const number = String(req.body.number || '').trim()
  const question = String(req.body.question || '').trim()
  if (!number || !question) return res.status(400).json({ error: 'Укажите номер заявки и вопрос' })
  const { rows } = await pool.query(
    `INSERT INTO tickets (number, question, author_id)
     VALUES ($1, $2, $3) RETURNING *`,
    [number, question, req.user.id],
  )
  const t = rows[0]
  io.emit('dashboard:refresh')
  res.status(201).json({
    id: t.id, number: t.number, question: t.question, author: t.author_id,
    status: t.status, answer: t.answer, createdAt: t.created_at, updatedAt: t.updated_at,
  })
})

app.delete('/api/tickets/:id', auth, allow('lead', 'teamlead'), async (req, res) => {
  const { rows } = await pool.query(
    "DELETE FROM tickets WHERE id = $1 AND status = 'closed' RETURNING id",
    [req.params.id],
  )
  if (!rows[0]) return res.status(404).json({ error: 'Закрытое обращение не найдено' })
  io.emit('dashboard:refresh')
  res.json({ ok: true })
})

app.post('/api/tickets/:id/close', auth, allow('engineer', 'senior'), async (req, res) => {
  const { rows } = await pool.query(
    `UPDATE tickets SET status = 'closed', updated_at = NOW()
     WHERE id = $1 AND author_id = $2 AND status <> 'closed'
     RETURNING id, status`,
    [req.params.id, req.user.id],
  )
  if (!rows[0]) {
    const exists = await pool.query('SELECT status FROM tickets WHERE id = $1 AND author_id = $2', [req.params.id, req.user.id])
    if (!exists.rows[0]) return res.status(404).json({ error: 'Обращение не найдено' })
    return res.status(400).json({ error: 'Обращение уже закрыто' })
  }
  io.emit('dashboard:refresh')
  res.json({ ok: true, status: rows[0].status })
})

app.post('/api/tickets/:id/follow-ups', auth, allow('engineer', 'senior'), async (req, res) => {
  const message = String(req.body.message || '').trim()
  if (!message || message.length > 3000) return res.status(400).json({ error: 'Дополнение должно содержать от 1 до 3000 символов' })
  const { rows: tickets } = await pool.query(
    'SELECT id, number, status, answer FROM tickets WHERE id = $1 AND author_id = $2',
    [req.params.id, req.user.id],
  )
  const ticket = tickets[0]
  if (!ticket) return res.status(404).json({ error: 'Обращение не найдено' })
  if (ticket.status === 'closed') return res.status(400).json({ error: 'Закрытое обращение нельзя дополнить' })
  if (!ticket.answer) return res.status(400).json({ error: 'Дождитесь ответа ведущего инженера' })
  const { rows } = await pool.query(
    `INSERT INTO ticket_followups (ticket_id, author_id, message)
     VALUES ($1, $2, $3) RETURNING id, message, created_at`,
    [ticket.id, req.user.id, message],
  )
  io.emit('ticket:follow-up-added', { ticketId: ticket.id, number: ticket.number, author: req.user.name, message })
  io.emit('dashboard:refresh')
  res.status(201).json({ id: rows[0].id, author: req.user.name, message: rows[0].message, createdAt: rows[0].created_at })
})

app.patch('/api/tickets/:id/follow-ups/:followUpId', auth, allow('lead', 'teamlead'), async (req, res) => {
  const answer = String(req.body.answer || '').trim()
  if (!answer || answer.length > 3000) return res.status(400).json({ error: 'Ответ должен содержать от 1 до 3000 символов' })
  const { rows } = await pool.query(
    `UPDATE ticket_followups SET answer = $1, answered_by = $2, answered_at = NOW()
     WHERE id = $3 AND ticket_id = $4 RETURNING id`,
    [answer, req.user.id, req.params.followUpId, req.params.id],
  )
  if (!rows[0]) return res.status(404).json({ error: 'Дополнение не найдено' })
  io.emit('dashboard:refresh')
  io.emit('ticket:follow-up-replied', { ticketId: req.params.id, followUpId: req.params.followUpId })
  res.json({ ok: true })
})

app.patch('/api/tickets/:id', auth, allow('lead', 'teamlead'), async (req, res) => {
  const status = req.body.status
  const answer = String(req.body.answer || '').trim()
  if (!validStatuses.includes(status)) return res.status(400).json({ error: 'Неизвестный статус обращения' })
  if (status === 'in_progress' && !answer) return res.status(400).json({ error: 'Добавьте ответ инженеру' })
  const { rows } = await pool.query(
    `UPDATE tickets SET status = $1,
       answer = CASE WHEN $2 <> '' THEN $2 ELSE answer END,
       answered_by = CASE WHEN $2 <> '' THEN $3::uuid ELSE answered_by END,
       updated_at = NOW()
     WHERE id = $4
     RETURNING *`,
    [status, answer, req.user.id, req.params.id],
  )
  if (!rows[0]) return res.status(404).json({ error: 'Обращение не найдено' })
  io.emit('dashboard:refresh')
  res.json({
    id: rows[0].id, number: rows[0].number, question: rows[0].question,
    status: rows[0].status, answer: rows[0].answer, author: rows[0].author_id,
    answeredBy: rows[0].answered_by, createdAt: rows[0].created_at, updatedAt: rows[0].updated_at,
  })
})

app.post('/api/team', auth, allow('teamlead'), async (req, res) => {
  const name = String(req.body.name || '').trim()
  const email = String(req.body.email || '').trim().toLowerCase()
  const password = String(req.body.password || '')
  if (!name || !email || password.length < 8) return res.status(400).json({ error: 'Укажите имя, email и пароль не короче 8 символов' })
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Проверьте email' })
  const role = ['engineer', 'senior', 'lead'].includes(req.body.role) ? req.body.role : 'engineer'
  try {
    const { rows } = await pool.query(
      `INSERT INTO users (name, email, role, password_hash)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, email, role, active, avatar`,
      [name, email, role, await bcrypt.hash(password, 12)],
    )
    res.status(201).json(present(rows[0]))
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Пользователь с таким email уже есть' })
    throw error
  }
})

app.patch('/api/team/:id', auth, allow('teamlead'), async (req, res) => {
  if (String(req.user.id) === req.params.id && req.body.active === false) return res.status(400).json({ error: 'Нельзя отключить собственную учетную запись' })
  if (String(req.user.id) === req.params.id && req.body.role && req.body.role !== req.user.role) return res.status(400).json({ error: 'Нельзя менять собственную роль' })
  const role = ['engineer', 'senior', 'lead', 'teamlead'].includes(req.body.role) ? req.body.role : null
  const active = typeof req.body.active === 'boolean' ? req.body.active : null
  const { rows } = await pool.query(
    `UPDATE users SET
       role = COALESCE($1, role),
       active = COALESCE($2, active),
       updated_at = NOW()
     WHERE id = $3
     RETURNING id, name, email, role, active, avatar`,
    [role, active, req.params.id],
  )
  if (!rows[0]) return res.status(404).json({ error: 'Сотрудник не найден' })
  res.json(present(rows[0]))
})

app.patch('/api/profile', auth, async (req, res) => {
  const user = await getUserById(req.user.id)
  if (!user) return res.status(404).json({ error: 'Профиль не найден' })
  let name = user.name
  let email = user.email
  let avatar = user.avatar || ''
  let passwordHash = user.password_hash

  if (req.body.name !== undefined) {
    name = String(req.body.name).trim()
    if (name.length < 2 || name.length > 80) return res.status(400).json({ error: 'Имя должно содержать от 2 до 80 символов' })
  }
  if (req.body.email !== undefined) {
    email = String(req.body.email).trim().toLowerCase()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Проверьте email' })
  }
  if (req.body.avatar !== undefined) {
    avatar = String(req.body.avatar)
    if (avatar && (!/^data:image\/(png|jpeg|webp);base64,/.test(avatar) || avatar.length > 3700000)) {
      return res.status(400).json({ error: 'Загрузите PNG, JPEG или WebP до 2,5 МБ' })
    }
  }
  if (req.body.newPassword !== undefined && req.body.newPassword !== '') {
    const currentPassword = String(req.body.currentPassword || '')
    const newPassword = String(req.body.newPassword)
    if (!await bcrypt.compare(currentPassword, user.password_hash)) return res.status(400).json({ error: 'Текущий пароль указан неверно' })
    if (newPassword.length < 8) return res.status(400).json({ error: 'Новый пароль должен быть не короче 8 символов' })
    passwordHash = await bcrypt.hash(newPassword, 12)
  }

  try {
    const { rows } = await pool.query(
      `UPDATE users SET name = $1, email = $2, avatar = $3, password_hash = $4, updated_at = NOW()
       WHERE id = $5 RETURNING id, name, email, role, active, avatar`,
      [name, email, avatar, passwordHash, req.user.id],
    )
    res.json({ user: present(rows[0]) })
  } catch (error) {
    if (error.code === '23505') return res.status(409).json({ error: 'Этот email уже используется' })
    throw error
  }
})

app.get('/api/health', async (req, res) => {
  await pool.query('SELECT 1')
  res.json({ ok: true, database: 'connected' })
})

app.use((err, req, res, next) => {
  console.error(err)
  if (res.headersSent) return next(err)
  if (err.code === '23503' || err.code === '22P02') {
    return res.status(400).json({ error: 'Некорректный идентификатор или связанные данные' })
  }
  res.status(500).json({ error: 'Внутренняя ошибка сервера' })
})

export default app

const port = Number(process.env.PORT || 3001)
try {
  await initDb()
  await pool.query('SELECT 1')
  if (!process.env.VERCEL) {
    await clearPreviousMonthStats()
    scheduleMonthlyStatsCleanup()
    httpServer.listen(port, () => console.log(`API started on http://localhost:${port}`))
  }
} catch (error) {
  console.error('PostgreSQL connection failed:', error.message)
  if (!process.env.VERCEL) process.exit(1)
  throw error
}

if (!process.env.VERCEL) {
  process.on('SIGINT', async () => { await pool.end(); process.exit(0) })
  process.on('SIGTERM', async () => { await pool.end(); process.exit(0) })
}
