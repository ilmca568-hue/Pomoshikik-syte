# Group Tracker

A Vite + React frontend with an Express API and PostgreSQL storage on Neon.

## Local setup

1. Use Node.js 20.19 or newer.
2. Copy `.env.example` to `.env` and set your Neon `DATABASE_URL` and a unique `JWT_SECRET`.
3. Install dependencies with `npm install`.
4. Initialize demo accounts with `npm run seed`.
5. Start the API with `npm run server`.
6. In a second terminal, start the frontend with `npm run dev`.

The API creates and migrates its PostgreSQL tables on startup. Do not commit `.env`; it contains private connection details.
