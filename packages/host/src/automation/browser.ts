import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';
import { CDP_ENDPOINT, DEFAULT_CDP_PORT, PLATFORM_URLS } from '@job-autoapply/shared';
import { logger } from '../logging/logger.js';

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
}

export async function connectOverCDP(port = DEFAULT_CDP_PORT): Promise<BrowserSession> {
  const endpoint = `http://127.0.0.1:${port}`;

  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (err) {
    logger.error({ err, endpoint }, 'CDP connection failed');
    throw new Error(
      'Could not connect to Chrome. Launch it with remote debugging:\n' +
        `  bash scripts/launch-chrome-debug.sh\n` +
        `Or: google-chrome --remote-debugging-port=${port} --remote-allow-origins=* --user-data-dir="$HOME/.config/job-autoapply-chrome"\n` +
        'Automation never runs in headless mode.',
    );
  }

  const contexts = browser.contexts();
  const context = contexts[0] ?? (await browser.newContext());
  const pages = context.pages();
  const page = pages[0] ?? (await context.newPage());

  await page.bringToFront();

  return { browser, context, page };
}

export async function findOrOpenPlatformTab(
  session: BrowserSession,
  platform: 'linkedin' | 'naukri',
  preferredUrl?: string,
): Promise<Page> {
  const { context } = session;
  const baseUrl = PLATFORM_URLS[platform];

  const pages = context.pages();
  for (const p of pages) {
    const url = p.url();
    if (preferredUrl && url.startsWith(preferredUrl.split('?')[0])) {
      await p.bringToFront();
      return p;
    }
    if (url.includes(platform === 'linkedin' ? 'linkedin.com' : 'naukri.com')) {
      await p.bringToFront();
      return p;
    }
  }

  const page = await context.newPage();
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
  return page;
}

export async function isLoggedIn(page: Page, platform: 'linkedin' | 'naukri'): Promise<boolean> {
  const url = page.url();
  if (platform === 'linkedin') {
    return !url.includes('/login') && !url.includes('/checkpoint');
  }
  return !url.includes('/login') && !url.includes('/sign-in');
}

export async function detectBlockingUI(page: Page): Promise<string | null> {
  const captchaSelectors = [
    'text=verify you',
    'text=security verification',
    'text=unusual activity',
    'text=too fast',
    'text=temporarily restricted',
    '#captcha',
    'iframe[src*="captcha"]',
  ];

  for (const sel of captchaSelectors) {
    try {
      const el = page.locator(sel).first();
      if (await el.isVisible({ timeout: 500 })) {
        return sel;
      }
    } catch {
      // not found
    }
  }
  return null;
}

export async function humanClick(page: Page, selector: string): Promise<void> {
  const locator = page.locator(selector).first();
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
}

export async function humanFill(page: Page, selector: string, value: string): Promise<void> {
  const locator = page.locator(selector).first();
  await locator.scrollIntoViewIfNeeded();
  await locator.click();
  await locator.fill('');
  await locator.type(value, { delay: 50 + Math.random() * 100 });
}

export async function getTabInfo(page: Page): Promise<{ title: string; url: string }> {
  return { title: await page.title(), url: page.url() };
}
