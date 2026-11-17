# Private testing

This page has two parts: the owner's checklist for going live, and a
short guide you can forward to each tester. Every tester sets up their
own criteria; there are no shared or default rules.

## Owner: launch checklist

1. **Merge the latest pull request** into `main`.
2. **Get the two keys.**
   - `TELEGRAM_BOT_TOKEN`: from @BotFather (you already have it; bot
     tokens don't expire unless revoked).
   - `ANTHROPIC_API_KEY`: at console.anthropic.com, create an API key
     and add credits. Set a monthly spend limit there as a safety net.
3. **Host the bot** on a small Linux server by following
   [hosting.md](hosting.md) (about 20 minutes, a few dollars a month).
4. **Run the preflight check** on the server:
   `npm run preflight`. Every line should start with ✓ and the last
   line should read `Ready for private testing.` Each ✗ line says what
   to fix. The Claude check makes two small paid requests.
5. **Test it yourself first.** Send the bot `/id`, put that number in
   `SIFT_ALLOWED_USER_IDS`, restart (`sudo systemctl restart sift-bot`),
   then follow the tester guide below. Keep `/scan on` for an hour and
   check that alerts look right.
6. **Invite 2 to 5 testers.** Forward them the tester guide. Each one
   sends you their `/id` number; add all of them to
   `SIFT_ALLOWED_USER_IDS`, separated by commas, and restart.
7. **Watch it run.** `journalctl -u sift-bot -f` shows the log (it
   never contains message text or keys). `/scan` in Telegram shows the
   last check: new pools found, tokens being watched, matches.

**Removing a tester:** delete their ID from `SIFT_ALLOWED_USER_IDS`
and restart. They are cut off at once, including alerts already queued.

**Costs:** the server is a few dollars a month. Each `/criteria` and
each plain-language message is one paid Claude request, typically a
cent or a few cents with the default model; for a handful of testers
that is usually a few dollars a month. Per tester, at most 3 criteria
and 5 plain-language requests a minute go to Claude. To spend less,
set `SIFT_CLAUDE_MODEL=claude-haiku-5-5` in `.env` (much cheaper,
somewhat less careful with unusual wording).

**Questions worth asking testers after a few days:**
- Were alerts relevant? Too many, too few?
- Did Sift misread any of your rules, or list something as not
  understood that it should have understood?
- Which numbers did you want that Sift doesn't support yet?
- Did any alert arrive too late to be useful?

## Tester guide (forward this)

> **Welcome to the Sift private test.**
>
> Sift watches new Solana tokens for you and messages you when one
> matches the rules you set. It never trades, never asks for a wallet,
> and never says a token is safe.
>
> 1. Open **@SiftAgentbot** in Telegram, send `/id`, and send me the
>    number it replies with. I'll add you and let you know.
> 2. Describe what you look for, in your own words, with numbers. For
>    example:
>    `/criteria market cap between 20k and 300k, at least 5k liquidity, at least 50 trades in the last hour, warn if the pool is younger than 10 minutes`
> 3. Sift replies with the rules it understood. Each rule quotes your
>    words; anything it couldn't turn into a rule is listed separately
>    and never used. If it misread something, say it again more simply.
>    When it's right, send `/approve`.
> 4. Send `/scan on`. When a new token matches all your required rules,
>    you get an alert showing each number, where it came from and when.
>    Tap the token address to copy it.
> 5. Paste any token address to check it against your rules at any time.
>
> `/scan off` stops alerts. `/status` shows what's running.
> `/criteria` shows your saved rules; describe new ones to replace them
> (you approve every change).
>
> **What Sift can measure:** market cap, FDV, liquidity, 1-hour volume,
> 1-hour trades and pool age. It can't judge holders, developer
> wallets, socials or bundles yet; it will tell you when your rules
> mention them.
>
> **Good to know:**
> - Each token alerts you at most once.
> - Brand-new pump.fun tokens have no liquidity figure on DexScreener
>   until they move to a trading pool, so a required liquidity rule
>   mostly matches at launch or after that move.
> - Matching your rules does not make a token safe or profitable. Most
>   scams are new tokens: always check before acting.
>
> Please tell me when an alert was useful, useless or late, and when
> Sift misunderstood your rules.
