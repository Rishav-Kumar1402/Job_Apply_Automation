import type { Page } from 'playwright-core';
import type { Profile } from '@job-autoapply/shared';
import { actionDelay, applicationDelay } from '../rateLimiter.js';
import {
  humanClick,
  humanFill,
  detectBlockingUI,
} from '../browser.js';
import {
  mapQuestion,
  isFreeTextQuestion,
  meetsConfidenceThreshold,
} from '../questionMapper.js';
import { getSelectors } from './search.js';
import { logger } from '../../logging/logger.js';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

export interface ApplyResult {
  status: 'applied' | 'skipped' | 'failed';
  reason?: string;
  jobId: string;
  jobTitle: string;
  company: string;
}

async function writeTempResume(profile: Profile): Promise<string> {
  const tmpDir = os.tmpdir();
  const filePath = path.join(tmpDir, profile.resumeFile.fileName);
  const buffer = Buffer.from(profile.resumeFile.base64, 'base64');
  fs.writeFileSync(filePath, buffer);
  return filePath;
}

async function fillFormStep(page: Page, profile: Profile): Promise<{ ok: boolean; reason?: string }> {
  const sel = getSelectors();

  const fields = page.locator(sel.formField);
  const count = await fields.count();

  for (let i = 0; i < count; i++) {
    const field = fields.nth(i);
    const labelEl = field.locator(sel.formLabel).first();
    let labelText = '';
    try {
      labelText = (await labelEl.textContent({ timeout: 1000 }))?.trim() ?? '';
    } catch {
      continue;
    }

    if (!labelText) continue;

    if (isFreeTextQuestion(labelText)) {
      if (profile.coverLetterTemplate) {
        const textarea = field.locator('textarea').first();
        if (await textarea.isVisible({ timeout: 500 }).catch(() => false)) {
          await humanFill(page, 'textarea', profile.coverLetterTemplate);
          await actionDelay();
          continue;
        }
      }
      return { ok: false, reason: `unmapped question: ${labelText}` };
    }

    const mapped = mapQuestion(labelText, profile);
    if (!mapped || !meetsConfidenceThreshold(mapped.confidence)) {
      const input = field.locator(sel.formInput).first();
      const isRequired = await input.getAttribute('required').catch(() => null);
      const isEmpty = await input.inputValue().catch(() => '');
      if (isRequired && !isEmpty) {
        return { ok: false, reason: `unmapped question: ${labelText}` };
      }
      continue;
    }

    const input = field.locator(sel.formInput).first();
    const tagName = await input.evaluate((el) => el.tagName.toLowerCase()).catch(() => 'input');

    if (tagName === 'select') {
      await input.selectOption({ label: mapped.value }).catch(async () => {
        await input.selectOption(mapped.value);
      });
    } else {
      const current = await input.inputValue().catch(() => '');
      if (!current) {
        await humanFill(page, `${sel.formField}:nth-child(${i + 1}) ${sel.formInput}`, mapped.value);
      }
    }
    await actionDelay();
  }

  const fileInput = page.locator('input[type="file"]').first();
  if (await fileInput.isVisible({ timeout: 500 }).catch(() => false)) {
    if (!profile.linkedinResumeAlreadyUploaded) {
      const resumePath = await writeTempResume(profile);
      await fileInput.setInputFiles(resumePath);
      await actionDelay();
    }
  }

  return { ok: true };
}

export async function applyToJob(
  page: Page,
  profile: Profile,
  cardIndex: number,
): Promise<ApplyResult> {
  const sel = getSelectors();
  const cards = page.locator(sel.jobCard);
  const card = cards.nth(cardIndex);

  const jobTitle = (await card.locator(sel.jobTitle).first().textContent())?.trim() ?? 'Unknown';
  const company = (await card.locator(sel.jobCompany).first().textContent())?.trim() ?? 'Unknown';
  const jobId =
    (await card.getAttribute(sel.jobIdAttr)) ??
    `${jobTitle}-${company}`.replace(/\s+/g, '-').toLowerCase();

  const appliedBadge = card.locator(sel.appliedBadge);
  if (await appliedBadge.isVisible({ timeout: 500 }).catch(() => false)) {
    return { status: 'skipped', reason: 'already applied (badge)', jobId, jobTitle, company };
  }

  await card.click();
  await actionDelay();
  await page.bringToFront();

  const blocking = await detectBlockingUI(page);
  if (blocking) {
    return { status: 'failed', reason: `blocking UI detected: ${blocking}`, jobId, jobTitle, company };
  }

  const closed = page.locator(sel.closedJob);
  if (await closed.isVisible({ timeout: 500 }).catch(() => false)) {
    return { status: 'skipped', reason: 'listing no longer available', jobId, jobTitle, company };
  }

  const externalBtn = page.locator(sel.externalApplyButton);
  if (await externalBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
    return { status: 'skipped', reason: 'external application, out of scope', jobId, jobTitle, company };
  }

  const easyApply = page.locator(sel.easyApplyButton);
  if (!(await easyApply.isVisible({ timeout: 3000 }).catch(() => false))) {
    return { status: 'skipped', reason: 'Easy Apply not available', jobId, jobTitle, company };
  }

  await humanClick(page, sel.easyApplyButton);
  await actionDelay();

  const modal = page.locator(sel.modal);
  if (!(await modal.isVisible({ timeout: 5000 }).catch(() => false))) {
    return { status: 'failed', reason: 'Easy Apply modal did not open', jobId, jobTitle, company };
  }

  let steps = 0;
  const maxSteps = 10;

  while (steps < maxSteps) {
    const fillResult = await fillFormStep(page, profile);
    if (!fillResult.ok) {
      await humanClick(page, sel.modalDismiss).catch(() => {});
      return { status: 'skipped', reason: fillResult.reason, jobId, jobTitle, company };
    }

    const submitBtn = page.locator(sel.modalSubmit);
    if (await submitBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await humanClick(page, sel.modalSubmit);
      await actionDelay();

      const success = page.locator(sel.successToast);
      const confirmed = await success.isVisible({ timeout: 10000 }).catch(() => false);
      if (!confirmed) {
        return { status: 'failed', reason: 'submit confirmation not detected', jobId, jobTitle, company };
      }

      await applicationDelay();
      return { status: 'applied', jobId, jobTitle, company };
    }

    const nextBtn = page.locator(sel.modalNext);
    if (await nextBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      await humanClick(page, sel.modalNext);
      await actionDelay();
      steps++;
      continue;
    }

    break;
  }

  await humanClick(page, sel.modalDismiss).catch(() => {});
  return { status: 'failed', reason: 'could not complete Easy Apply flow', jobId, jobTitle, company };
}

export async function getJobCardCount(page: Page): Promise<number> {
  return page.locator(getSelectors().jobCard).count();
}

export async function goToNextPage(page: Page): Promise<boolean> {
  const next = page.locator(getSelectors().paginationNext);
  if (!(await next.isVisible({ timeout: 2000 }).catch(() => false))) return false;
  if (await next.isDisabled().catch(() => true)) return false;
  await humanClick(page, getSelectors().paginationNext);
  await actionDelay();
  return true;
}

export { logger };
