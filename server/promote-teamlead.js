import 'dotenv/config'
import pg from 'pg'

const { Pool } = pg
const email = String(process.argv[2] || '').trim().toLowerCase()

if (!email) {
  console.error('Usage: npm run promote:teamlead -- user@example.com')
  process.exit(1)
}
if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL не задана в .env')
  process.exit(1)
}

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('neon.tech') ? { rejectUnauthorized: true } : undefined,
})

try {
  const { rows } = await pool.query(
    `UPDATE users SET role = 'teamlead', updated_at = NOW()
     WHERE email = $1
     RETURNING email`,
    [email],
  )
  if (!rows[0]) {
    console.error(`No account found for ${email}`)
    process.exitCode = 1
  } else {
    console.log(`Role restored: ${rows[0].email} → teamlead`)
  }
} catch (error) {
  console.error('Could not update the role:', error.message)
  process.exitCode = 1
} finally {
  await pool.end()
}
