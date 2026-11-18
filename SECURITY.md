# Security

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's
**Security → Report a vulnerability** form on this repository so the report stays private.

## What DMLand stores, and where

- Everything is stored locally in `data/app.db` (SQLite) on the machine that runs DMLand.
- Meta access tokens are encrypted in SQLite with AES-256-GCM. The dashboard shows only the last four characters. The key is generated in `.env` on first start unless supplied through `TOKEN_ENCRYPTION_KEY`. Keep a protected backup of the key away from the SQLite backup. Keep both private.
- Emails collected through the "ask for email first" mode are stored in the same database and
  can be exported as CSV from the Contacts page.
- DMLand sends nothing to any third party. It only talks to the Meta Graph API.

## Keep safe

- Never commit `.env` or `data/`. The included `.gitignore` already excludes them.
- Never paste your access token or App Secret into chats, issues or screenshots.
- The dashboard binds to `127.0.0.1` by default and uses HTTP Basic auth. For remote access use an encrypted private tunnel or a private HTTPS reverse proxy. Publish only the proxy and keep the raw HTTP listener private.
- Webhooks are disabled by default. Enable them only if needed and route only `/webhooks/meta` to Meta. The app requires signed events. Polling requires no inbound public route.
- On upgrade the app encrypts existing token rows. Older backups and SQLite storage may still contain the original plaintext. Rotate any previously stored tokens if upgrading an existing installation.
- You are responsible for how you use collected emails (consent, privacy laws such as GDPR).
  The default email request includes a consent line you can edit.

## Sending controls

Private reply attempts share a rolling per-account cap across polling and webhooks. The default is 60 per hour. To start a pilot, use a secondary professional account, one reel and one exact keyword, with a single DM and no public reply or email capture.

If Meta restricts sending, the dashboard shows a stop that survives restarts. Review the restriction in Meta before clearing it. When ready, stop DMLand, run the following from the repository root (use your actual database path if you set `DB_FILE`), then start DMLand again.

```sh
sqlite3 data/app.db 'DELETE FROM sending_stop WHERE id=1;'
```

The stop covers all accounts on the instance. A regular rate limit has a ten-minute retry delay. Inbox analytics are opt-in via `INBOX_ANALYTICS=on`. Email capture still reads conversations when an active capture is waiting.
