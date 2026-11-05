# Lifeline

Build a timeline of a life from a simple form, a spreadsheet, or a Facebook or Instagram download, then share it with a link.

- Horizontal timeline that magnifies events as you pass over them, plus a list view
- Events with photos, optional date ranges (vacations, trips) and box colors you can name ("Work", "Family") and filter by
- Eras: shaded stretches of time like "Texas Tech" or "Teaching in Garland"
- Spreadsheet import (.xlsx, .xls, .csv), including a Photos column of picture links that are downloaded onto each event (Google Drive and Dropbox share links work when shared publicly)
- Facebook and Instagram import (Meta's "Download your information" .zip) with photos, an optional Claude review that picks out real life events, and progress you can stop and resume
- Accounts with email and password; each person can keep several private timelines (a life, a job, a hobby) and move events between them
- Share links per timeline: anyone with the link can view that one timeline, no account needed
- Delete-account and data download for every user

## What's in here

| File | What it does |
|---|---|
| `server.js` | The web server: accounts, saving timelines, photos, share links, Claude review |
| `public/index.html` | The whole app people use in their browser |
| `public/privacy.html` | Plain-language privacy page |
| `railway.json` | Tells Railway how to start the app and check it's healthy |

## Deploy on Railway

You need a Railway account and this code in a GitHub repository.

1. **Create the project.** In Railway, choose **New Project → Deploy from GitHub repo** and pick this repository. The first deploy will fail until the database is added. That's expected.
2. **Add a database.** In the same project, add **PostgreSQL** (New → Database → PostgreSQL).
3. **Connect the app to the database.** Open the app's service → **Variables** and add:
   - `DATABASE_URL` = `${{Postgres.DATABASE_URL}}` (Railway fills in the real value)
4. **Add storage for photos.** Attach a **Volume** to the app's service with mount path `/data`, then add the variable:
   - `DATA_DIR` = `/data`

   Without a volume, uploaded photos are lost every time the app redeploys.
5. **Turn on the Claude review (optional).** Create an API key at [console.anthropic.com](https://console.anthropic.com) and add:
   - `ANTHROPIC_API_KEY` = your key

   Without it, the Facebook import still works using the built-in keyword check.
6. **Give it a web address.** Service → **Settings → Networking → Generate Domain**. You can add your own domain there later.

Railway redeploys automatically whenever you push to GitHub.

### Optional settings

| Variable | Default | Meaning |
|---|---|---|
| `MAX_TIMELINES` | `50` | How many timelines one account can have. |
| `REVIEW_DAILY_LIMIT` | `50` | How many Claude review batches (up to 60 posts each) one person can run per day. Keeps your API bill predictable. |
| `CLAUDE_MODEL` | `claude-haiku-5-5` | Which Claude model reviews Facebook posts. |
| `PGSSL` | off | Set to `1` only if you connect to a database that requires SSL from outside Railway. |

## Costs to expect

- **Railway** charges by usage. The app itself is small; the database and photo volume grow as people add photos.
- **Claude API** is only used when someone clicks "Find life events with Claude". Each batch of 60 posts costs a fraction of a cent on the default model. The daily limit above caps how much one person can use.

## Run it on your own computer

You need Node.js 20 or newer and a Postgres database.

```bash
npm install
DATABASE_URL=postgresql://user:pass@localhost:5432/lifeline npm start
```

Then open http://localhost:3000.

## Notes

- Keep the app at **one replica** on Railway. Photos live on the attached volume, which belongs to a single instance.
- Facebook downloads are read in the visitor's browser; only the posts they choose to add (and their photos) are uploaded.
- Saving uses a version number, so an older copy open on another device can't overwrite newer changes. If that happens, the page loads the newest version and tells the person.
