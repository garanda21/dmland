<p align="center">
  <img src="assets/banner.png" alt="DMLand: turn Instagram comments into DMs" width="100%">
</p>

<p align="center">
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-f0693a"></a>
  <img alt="Node 24+" src="https://img.shields.io/badge/node-%E2%89%A524-9a76f5">
  <img alt="Zero dependencies" src="https://img.shields.io/badge/dependencies-0-ee6f8c">
  <img alt="Self-hosted" src="https://img.shields.io/badge/self--hosted-yes-4f9bff">
</p>

**DMLand** is a free, self-hosted tool that turns Instagram and Facebook Page comments into DMs. Someone comments a keyword on your reel or post ("Comment GUIDE"), DMLand replies under the comment and sends them your link by DM. It can ask for their email first, tracks every step, and shows what works.

It runs on your own computer with **Node 24 and no npm dependencies**. Your token and your contacts never leave your machine.

> Not affiliated with Meta, Instagram, Facebook or ManyChat. DMLand uses the official Meta Graph API (Instagram and Messenger) with your own Meta app.

## Features

- **Comment → public reply + DM** on any reel or post, or on all of them. Keyword rules: contains, whole word, exact, or any comment.
- **Ask for email first.** Optional mode: DMLand asks for an email, reads the answer, saves it and then sends the resource. Edit the consent line, export emails as CSV.
- **A/B test** two versions of the message that asks for the email and see which wins.
- **UTM links.** Add campaign parameters to every link you send.
- **Instagram and Facebook Pages.** Connect Instagram Professional accounts, Facebook Pages (DMs through Messenger), or both. Facebook Page support is new and not yet tested against a real Page.
- **Multi-brand.** Connect several accounts and group them by brand.
- **Safe sending.** Stays under Meta's hourly limit, sends the DM before the public reply, never answers a comment twice, and pauses and retries if Meta slows you down.
- **Analytics.** Reels with views and DMs, funnel, best times to post, email list growth, speed to DM, uptime, and people who wrote back.
- **Any language.** The dashboard is in English and ships with Spanish. Add another language by translating one file ([docs/LANGUAGES.md](docs/LANGUAGES.md)); an AI agent can do it for you at install time. Dark glass theme, light mode included.
- **Zero dependencies, zero build.** One Node process, SQLite file, one HTML file.

## Screenshots

<p align="center">
  <img src="assets/screenshots/home.png" alt="Home: reels, trends and KPIs" width="100%">
</p>

<table>
  <tr>
    <td width="50%"><img src="assets/screenshots/automations.png" alt="Automations"><br><sub><b>Automations.</b> One card per reel with its keyword and results.</sub></td>
    <td width="50%"><img src="assets/screenshots/editor.png" alt="Automation editor with phone preview"><br><sub><b>Editor.</b> Live preview of what the commenter sees.</sub></td>
  </tr>
  <tr>
    <td width="50%"><img src="assets/screenshots/analytics.png" alt="Analytics"><br><sub><b>Analytics.</b> Reels, speed, emails, A/B tests and health.</sub></td>
    <td width="50%"><img src="assets/screenshots/contacts.png" alt="Contacts"><br><sub><b>Contacts.</b> Tags and collected emails, exportable as CSV.</sub></td>
  </tr>
</table>

*All screenshots use made-up demo data.*

## Quick start

You need **Node 24 or newer**.

```bash
git clone https://github.com/LordVayron/dmland.git
cd dmland
npm test        # optional: runs the tests, no Meta account needed
npm start       # opens on http://localhost:3000
```

On first run DMLand creates a `.env` file with a random dashboard password. Open `http://localhost:3000`, sign in with that password.

**Just want to look around?** Run the demo with made-up data (two Instagram accounts and one Facebook Page) and no Meta account:

```bash
npm run demo    # http://localhost:3100, password: demo
```

## Run with Docker

```sh
mkdir -p data config && sudo chown 1000:1000 data config   # the container runs as the "node" user (uid 1000)
docker compose up -d --build
docker compose exec dmland cat /config/.env               # dashboard password and generated keys
```

The dashboard listens on `127.0.0.1:3000` of the host only. Reach it through a VPN or a private HTTPS reverse proxy.
`data/` holds SQLite and `config/` holds `.env` with the token encryption key: back them up separately.
To keep the key out of `config/`, mount it as a Docker secret and set `TOKEN_ENCRYPTION_KEY_FILE`.

## Connect Instagram or a Facebook Page

DMLand uses your own Meta app (free, about 15 minutes, no Meta review needed for your own account).
Follow **[docs/META-SETUP.md](docs/META-SETUP.md)**; it has a section for Facebook Pages.

### Let an AI agent do the setup

Using Claude Code, Codex or a similar agent? Open this folder with it and say:

> Install DMLand and guide me through the setup.

The agent follows [AGENTS.md](AGENTS.md): it asks your language, installs and starts DMLand, looks up Meta's **current** documentation, and walks you through creating the Meta app step by step. You paste your token yourself; the agent never handles your secrets.

## Limits you should know

| Limit | Value |
|---|---|
| Replies per hour per Instagram account | Meta allows about 750. DMLand defaults to 60 private reply attempts per hour. |
| Replies per hour per Facebook Page | Meta publishes no number. DMLand uses the same default of 60 attempts per hour. |
| Comment age | Only comments under 7 days old can get a DM (both platforms). |
| One DM per comment | A comment is answered once. |
| Message size | 1000 bytes per DM. |
| Facebook Page analytics | Views and reach are not available for Pages yet. |

If Meta pauses sending, DMLand waits and retries by itself; comments are not lost while they are under 7 days old. Details in [docs/HOW-IT-WORKS.md](docs/HOW-IT-WORKS.md).

DMLand only works while your computer and the program are on. To use the dashboard from your phone, use a private network such as [Tailscale](https://tailscale.com). Do not expose it directly to the internet.

## Privacy

Everything is stored in `data/app.db` on your machine. DMLand talks only to the Meta Graph API. Emails you collect are personal data: you are responsible for consent and local privacy laws. See [SECURITY.md](SECURITY.md).

## Documentation

- [Connect to Instagram or a Facebook Page (Meta setup)](docs/META-SETUP.md)
- [Posts and automations: how DMLand finds your posts](docs/POSTS-AND-AUTOMATIONS.md)
- [How it works, limits and project layout](docs/HOW-IT-WORKS.md)
- [Languages](docs/LANGUAGES.md)
- [AI agent install guide](AGENTS.md)
- [Contributing](CONTRIBUTING.md) · [Security](SECURITY.md)

## License

[MIT](LICENSE)
