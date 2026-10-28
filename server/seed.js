import 'dotenv/config'
import pg from 'pg'
import bcrypt from 'bcryptjs'

const { Pool } = pg
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL не задана в .env')
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('neon.tech') ? { rejectUnauthorized: true } : undefined,
})

const defaults = [
  ['Руководитель команды', 'teamlead@example.com', process.env.SEED_TEAMLEAD_PASSWORD || 'TeamLead123!', 'teamlead'],
  ['Александр Волков', 'lead@example.com', process.env.SEED_LEAD_PASSWORD || 'Lead12345!', 'lead'],
  ['Мария Смирнова', 'engineer@example.com', process.env.SEED_ENGINEER_PASSWORD || 'Engineer123!', 'engineer'],
]

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'engineer'
        CHECK (role IN ('engineer', 'senior', 'lead', 'teamlead')),
      active BOOLEAN NOT NULL DEFAULT TRUE,
      avatar TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `)
  for (const [name, email, password, role] of defaults) {
    const passwordHash = await bcrypt.hash(password, 12)
    await pool.query(
      `INSERT INTO users (name, email, password_hash, role, active)
       VALUES ($1, $2, $3, $4, TRUE)
       ON CONFLICT (email) DO NOTHING`,
      [name, email, passwordHash, role],
    )
    console.log(`Ready: ${email}`)
  }
} catch (error) {
  console.error('Не удалось создать начальных пользователей:', error.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
