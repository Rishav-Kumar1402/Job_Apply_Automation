# Brevo email setup (Job Auto-Apply)

Sends the company-site / skipped-jobs **HTML table** in the email body with a **CSV attachment**.

## Security first

If you pasted an API key in chat or committed it anywhere, **revoke it now** in Brevo → Settings → SMTP & API → API Keys, then create a new key.

Never commit API keys. The extension stores the key only in Chrome local storage on your machine.

## Quick setup (direct from extension)

1. In Brevo, verify a **sender** under Settings → Senders.
2. Create an API key under Settings → SMTP & API → API Keys.
3. Rebuild / reload the extension (`load-in-chrome`).
4. Open extension **Settings** (options page).
5. Paste:
   - Brevo API key
   - Verified sender email
6. Click **Save Brevo settings**.
7. Enter your inbox under **Send test email to** → **Send test email**.
8. On the Apply tab, set **Receiver email for company-site report**.

After each run (or via Run dashboard → **Email**), reports go through Brevo when configured.

## Optional: Cloudflare Worker relay (safer)

Use this if you share the extension build with others and do not want the API key on each machine.

```bash
cd packages/brevo-relay
npm install
npx wrangler login
npx wrangler secret put BREVO_API_KEY
npx wrangler secret put BREVO_SENDER_EMAIL
npx wrangler deploy
```

Paste the Worker URL into Settings → **Optional relay URL**. Leave the local API key empty when using the relay.
