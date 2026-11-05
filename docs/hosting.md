# Hosting Sift on a VPS

This guide runs @SiftAgentbot around the clock on a small Linux server
(VPS). The bot restarts by itself after a crash or a reboot. Expect
about 15–20 minutes, plus a small monthly server fee from the provider
you choose (check their current prices).

The bot uses Telegram long polling. It only makes outbound HTTPS
requests, so the server needs **no open ports** apart from SSH.

## What you need

- A VPS provider account, for example Hetzner, DigitalOcean or Vultr.
- `TELEGRAM_BOT_TOKEN` from @BotFather. Telegram bot tokens do not
  expire; they stop working only if you revoke them.
- Your numeric Telegram user ID for `SIFT_ALLOWED_USER_IDS`. If you
  don't have it yet, leave it empty at first and send `/id` to the bot.
- Optional: `ANTHROPIC_API_KEY` for plain-language commands.

You do **not** need a GitHub personal access token. Step 4 uses a
read-only deploy key, which does not expire.

## 1. Create the server

- Image: **Ubuntu 24.04 LTS**.
- Size: the smallest plan (1 vCPU and 1 GB of RAM is plenty).
- Login: add your **SSH key** when you create it rather than using a
  password.

Connect from your computer:

```sh
ssh root@YOUR_SERVER_IP
```

## 2. Update the server and turn on the firewall

```sh
apt update && apt upgrade -y
apt install -y git ufw unattended-upgrades
ufw allow OpenSSH
ufw --force enable
```

`unattended-upgrades` installs security updates automatically. The
firewall blocks everything except SSH, which is all the bot needs.

## 3. Install Node.js 24

This uses NodeSource's official package repository:

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x -o nodesource_setup.sh
less nodesource_setup.sh        # optional: read the script before running it
bash nodesource_setup.sh
apt install -y nodejs
node --version                  # should print v24.x
command -v node                 # should print /usr/bin/node
```

If `command -v node` prints a different path, change `ExecStart` in
`deploy/sift-bot.service` to match it in step 7.

## 4. Create a user for the bot and fetch the code

Run the bot as its own user, never as root:

```sh
adduser --disabled-password --gecos "" sift
sudo -iu sift
```

You are now the `sift` user. Create a deploy key:

```sh
ssh-keygen -t ed25519 -f ~/.ssh/sift_deploy -N "" -C "sift-vps"
cat ~/.ssh/sift_deploy.pub
```

On GitHub, open the repository's **Settings → Deploy keys → Add deploy
key**. Paste the printed public key, give it a name like "VPS", and
leave **Allow write access** unchecked.

Back on the server, tell SSH to use that key for GitHub, then clone:

```sh
cat >> ~/.ssh/config <<'EOF'
Host github.com
  IdentityFile ~/.ssh/sift_deploy
  IdentitiesOnly yes
EOF
chmod 600 ~/.ssh/config

git clone git@github.com:Damianonyx/Sift-bot.git
cd Sift-bot
npm ci
```

Type `yes` if SSH asks whether to trust github.com. If the repository
is public, `git clone https://github.com/Damianonyx/Sift-bot.git` also
works without a deploy key.

## 5. Add your secrets

```sh
cp .env.example .env
chmod 600 .env
nano .env
```

Fill in `TELEGRAM_BOT_TOKEN`, `SIFT_ALLOWED_USER_IDS` and, optionally,
`ANTHROPIC_API_KEY`. Save with Ctrl+O, Enter, then exit with Ctrl+X.

`chmod 600` means only the `sift` user can read the file. Never commit
`.env`, paste it into chat, or put secrets in the service file.

## 6. Do a test run

**Stop every other copy of the bot first**, such as a Codespace or your
own computer. Telegram allows only one polling process per bot; a second
one makes the bot stop with a `409` conflict.

```sh
node --env-file=.env src/index.js
```

You should see `Sift welcome bot is running.` Send `/status` to the bot
in Telegram, check that it answers, then stop it with Ctrl+C.

Now leave the `sift` user:

```sh
exit
```

## 7. Install the service

As root:

```sh
cp /home/sift/Sift-bot/deploy/sift-bot.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now sift-bot
systemctl status sift-bot
```

The status should say `active (running)`. `enable` makes it start on
every boot, and the service restarts the bot 10 seconds after a crash.

Watch the logs live (Ctrl+C to stop watching; the bot keeps running):

```sh
journalctl -u sift-bot -f
```

Send `/start` and `/status` from your tester account to confirm.

## Everyday commands

| Task | Command (as root) |
|---|---|
| See if it is running | `systemctl status sift-bot` |
| Watch logs | `journalctl -u sift-bot -f` |
| Logs from the last hour | `journalctl -u sift-bot --since "1 hour ago"` |
| Restart (after editing `.env`) | `systemctl restart sift-bot` |
| Stop | `systemctl stop sift-bot` |

## Updating to new code

After a pull request is merged into `main`:

```sh
sudo -iu sift bash -c 'cd ~/Sift-bot && git pull && npm ci'
systemctl restart sift-bot
journalctl -u sift-bot -n 20
```

If `deploy/sift-bot.service` itself changed, copy it again and run
`systemctl daemon-reload` before restarting.

## Troubleshooting

| Log message or symptom | Cause and fix |
|---|---|
| `Telegram request failed (409).` | Another copy of the bot is polling. Stop the Codespace or other machine, then `systemctl restart sift-bot`. |
| `A Telegram webhook is already configured.` | A webhook deployment (for example the Cloudflare setup in PR #2) is registered. Only if nothing else should be serving the bot, remove it with the snippet below, then restart. |
| `Telegram request failed (401).` | The token is wrong or was revoked. Get the current one from @BotFather, update `.env`, restart. |
| `Set a valid TELEGRAM_BOT_TOKEN` or `SIFT_ALLOWED_USER_IDS must contain...` | Fix the value in `.env`; IDs are numbers separated by commas. Then restart. |
| `start request repeated too quickly` / `failed` | The service gave up after 10 failed starts in 5 minutes. Fix the cause in the logs, then `systemctl reset-failed sift-bot && systemctl start sift-bot`. |
| `.env: not found` | The service runs from `/home/sift/Sift-bot`; create `.env` there (step 5). |
| Bot answers, but plain-language requests get "not available yet" | `ANTHROPIC_API_KEY` is missing or invalid, or the Claude request failed. Look for `Claude request failed (...)` in the logs. |

To remove a webhook without saving the token in your shell history:

```sh
read -rs TOKEN && curl -s "https://api.telegram.org/bot${TOKEN}/deleteWebhook"; unset TOKEN
```

Paste the token when the cursor waits (nothing is shown), then press
Enter. The reply should contain `"ok":true`.

## Saved data and backups

The service gives the bot one writable folder, `/var/lib/sift-bot`, and
sets `SIFT_DATA_DIR` to it (overriding any value in `.env`). The current
welcome bot saves nothing there. Later versions that keep SQLite data
will use it. Once they do, back that folder up, for example with your
provider's snapshot feature.

## Security notes

- The bot runs as the unprivileged `sift` user. The service makes the
  rest of the system read-only to it.
- No inbound ports are opened for the bot; only SSH is reachable.
- Secrets live only in `/home/sift/Sift-bot/.env`.
- The deploy key can read this one repository and nothing else. Remove
  it from **Settings → Deploy keys** if you retire the server.
