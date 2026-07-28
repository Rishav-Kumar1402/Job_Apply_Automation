# Job Auto-Apply — Simple Chrome Extension

Load and use. No terminal, no native host, no special Chrome flags.

## Install (30 seconds)

1. Open Chrome → `chrome://extensions`
2. Enable **Developer mode**
3. Click **Load unpacked**
4. Select the **`load-in-chrome`** folder from this project

That's it.

## Use

1. Click the extension icon (opens side panel)
2. Set a passphrase (first time only)
3. **Profile** tab → fill your details + resume → Save
4. **Apply** tab → enter job keywords → **Apply via LinkedIn**
5. A LinkedIn tab opens and applies automatically — watch it live in the **Run** tab

## Share with others

Zip the `load-in-chrome` folder and share it. They load it the same way in Chrome.

## Requirements

- Google Chrome
- Logged into LinkedIn (or Naukri) in that Chrome browser

## Email reports (Brevo)

Configure Brevo in extension **Settings** to email the skipped / company-site table + CSV.
See [docs/BREVO_SETUP.md](docs/BREVO_SETUP.md).

## Build from source

```bash
npm install
npm run build -w @job-autoapply/extension
```

Output: `load-in-chrome/` folder ready to load in Chrome.
