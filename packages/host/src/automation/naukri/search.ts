import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { SearchCriteria } from '@job-autoapply/shared';
import type { Page } from 'playwright-core';
import selectors from './selectors.naukri.json' with { type: 'json' };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
let config = selectors;

export function reloadSelectors(): void {
  const configPath = path.join(__dirname, 'selectors.naukri.json');
  config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

export function buildSearchUrl(criteria: SearchCriteria): string {
  const keywords = criteria.jobTitles.trim().replace(/\s+/g, '-').toLowerCase();
  const locationQuery = criteria.location?.trim()
    ? `-in-${criteria.location.trim().replace(/\s+/g, '-').toLowerCase()}`
    : '';

  return config.searchUrl
    .replace('{keywords}', encodeURIComponent(keywords))
    .replace('{locationQuery}', locationQuery);
}

export async function navigateToSearch(page: Page, criteria: SearchCriteria): Promise<void> {
  const url = buildSearchUrl(criteria);
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.bringToFront();
}

export function getSelectors() {
  return config.selectors;
}
