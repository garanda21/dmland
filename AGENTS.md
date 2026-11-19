# Instructions for AI agents (Claude Code, Codex, and others)

If a person asked you to "install DMLand" or "set up DMLand", follow this file. You are the installer
and the guide. Be patient, go one step at a time, and wait for the person to confirm each step.

## Rules you must never break

1. **Never type, store, print or log secrets for the person.** That includes the Meta access token,
   the App Secret and any password. The person pastes the token into the DMLand dashboard themselves.
2. **Never create accounts, apps or system users in Meta for them.** Guide them; they click.
3. **Never send a real DM** to a real person without the owner's explicit permission. Use a test
   account the owner controls.
4. **Never commit** `.env`, `data/` or anything with tokens or personal data.
5. If something looks wrong (an error, an odd permission prompt), stop and explain it plainly.

## Step 0: ask the person two things

1. "Which language do you want DMLand and this setup in?" Conduct the whole setup in their language.
   - **English**: nothing to do, it is the base language.
   - **Spanish**: already included. Tell them to pick it in Settings → Interface language.
   - **Any other language**: follow [docs/LANGUAGES.md](docs/LANGUAGES.md). Copy `public/lang/es.json` to `public/lang/<code>.json`, set `name`, translate every value (keep the keys, regexes, `{0}` placeholders and `$1` references), run `npm test`, and tell the person what you created. Translate the two default DM texts into the language their followers speak, not only the dashboard.
2. "Do you want to connect Instagram, a Facebook Page, or both?"
   - **Instagram** needs a Professional account (Business or Creator). If not, they switch in the
     Instagram app first (Settings → Account type and tools).
   - **Facebook Page** needs a Page they manage, inside their Business Portfolio. Tell them Facebook
     Page support is new and has not been tested against a real Page yet.

## Step 1: install and start

1. Check Node 24 or newer: `node -v`. If missing or older, tell the person to install it from
   nodejs.org. Do not install system software without asking.
2. Run `npm test`. All tests should pass. They need no Meta account.
3. Run `npm start` and open http://localhost:3000. DMLand creates `.env` on first run with a random
   dashboard password. Tell the person where to find it (`.env`, line `DASHBOARD_PASSWORD`) but
   do not print it into the chat unless they ask. They can change it by editing that line and restarting.

## Step 2: create the Meta app (guide, don't do)

**Before guiding, look up the current Meta documentation.** Meta renames and moves things often.
Search the web and read the latest pages on developers.facebook.com for: creating an app, the
Instagram API with Instagram Login or Facebook Login for Business, system users, access tokens, and
the permissions `instagram_basic`, `instagram_manage_comments`, `instagram_manage_messages` and
`instagram_manage_insights`. For a Facebook Page, also read the Messenger Platform docs (private
replies to comments, the 24-hour messaging window) and the permissions `pages_show_list`,
`pages_read_engagement`, `pages_manage_engagement`, `pages_messaging`, `pages_manage_metadata` and
`business_management`. Prefer what you read there over `docs/META-SETUP.md`, which is a
fallback checklist and may be out of date. If you cannot browse, use `docs/META-SETUP.md` and tell the
person it may be slightly out of date.

Walk the person through the outcome: an app in development mode, an Instagram Professional account
(and/or a Facebook Page) in a Business Portfolio, a system user with that account or Page assigned,
and a token with the permissions above for each platform they connect.

## Step 3: connect and verify

1. The person opens the dashboard → **Brands & accounts**, creates a brand, picks the **Platform**
   (Instagram or Facebook Page), enters the Instagram account ID or Facebook Page ID and pastes the
   token themselves, then clicks **Connect**.
2. Confirm the status turns green and the account name appears.
3. Ask the person to create a first automation on one of their own posts with a test keyword.
4. Ask them to comment the keyword from a second account they own, and confirm the DM arrives.
   The comments are read about once a minute, so wait a minute.

## Step 4: remind them

- DMLand only runs while the computer and the program are on.
- Instagram allows roughly 200 automated messages per hour per account; DMLand defaults to 60 private reply attempts per hour, never more than 200 (and
  uses the same cap for Facebook Pages, where Meta publishes no number). If Meta pauses
  sending, DMLand waits and retries; comments are not lost as long as they are under 7 days old.
- Emails collected are personal data. They are responsible for consent and privacy law.

## Keeping up to date

When you update DMLand from this repository, run `npm test`. If it reports dashboard texts missing from the person's language file, translate only the new strings in `public/lang/<code>.json`.
