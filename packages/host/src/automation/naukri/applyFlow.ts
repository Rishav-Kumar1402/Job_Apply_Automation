import type { Page } from 'playwright-core';
import type { Profile } from '@job-autoapply/shared';
import { actionDelay, applicationDelay } from '../rateLimiter.js';
import { humanClick, humanFill, detectBlockingUI } from '../browser.js';
import {
  mapQuestion,
  isFreeTextQuestion,
  meetsConfidenceThreshold,
  closestNoticePeriod,
} from '../questionMapper.js';
import { getSelectors } from './search.js';
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
  fs.writeFileSync(filePath, Buffer.from(profile.resumeFile.base64, 'base64'));
  return filePath;
}

async function handleChatbot(page: Page, profile: Profile): Promise<{ ok: boolean; reason?: string }> {
  const sel = getSelectors();
  const modal = page.locator(sel.chatbotModal);

  if (!(await modal.isVisible({ timeout: 3000 }).catch(() => false))) {
    return { ok: true };
  }

  const questions = modal.locator('label, .question, p');
  const count = await questions.count();

  for (let i = 0; i < count; i++) {
    const qText = (await questions.nth(i).textContent())?.trim() ?? '';
    if (!qText || qText.length < 5) continue;

    if (isFreeTextQuestion(qText)) {
      if (profile.coverLetterTemplate) {
        const textarea = modal.locator('textarea').first();
        if (await textarea.isVisible({ timeout: 500 }).catch(() => false)) {
          await humanFill(page, 'textarea', profile.coverLetterTemplate);
          continue;
        }
      }
      return { ok: false, reason: `unmapped question: ${qText}` };
    }

    const mapped = mapQuestion(qText, profile);
    if (!mapped || !meetsConfidenceThreshold(mapped.confidence)) {
      return { ok: false, reason: `unmapped question: ${qText}` };
    }

    const select = modal.locator(sel.chatbotSelect).first();
    if (await select.isVisible({ timeout: 500 }).catch(() => false)) {
      const options = await select.locator('option').allTextContents();
      if (qText.toLowerCase().includes('notice')) {
        const match = closestNoticePeriod(options, profile.noticePeriod);
        if (!match || !meetsConfidenceThreshold(match.confidence)) {
          return { ok: false, reason: `notice period mismatch: ${qText}` };
        }
        await select.selectOption({ label: match.value });
      } else {
        await select.selectOption({ label: mapped.value }).catch(() =>
          select.selectOption(mapped.value),
        );
      }
    } else {
      const input = modal.locator(sel.chatbotInput).first();
      if (await input.isVisible({ timeout: 500 }).catch(() => false)) {
        await humanFill(page, sel.chatbotInput, mapped.value);
      }
    }

    const submit = modal.locator(sel.chatbotSubmit).first();
    if (await submit.isVisible({ timeout: 500 }).catch(() => false)) {
      await submit.click();
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
  const jobId = `${jobTitle}-${company}`.replace(/\s+/g, '-').toLowerCase();

  const appliedBadge = card.locator(sel.appliedBadge);
  if (await appliedBadge.isVisible({ timeout: 500 }).catch(() => false)) {
    return { status: 'skipped', reason: 'already applied (badge)', jobId, jobTitle, company };
  }

  const external = card.locator(sel.externalApply);
  if (await external.isVisible({ timeout: 500 }).catch(() => false)) {
    return { status: 'skipped', reason: 'external application, out of scope', jobId, jobTitle, company };
  }

  await card.click();
  await actionDelay();
  await page.bringToFront();

  const blocking = await detectBlockingUI(page);
  if (blocking) {
    return { status: 'failed', reason: `blocking UI detected: ${blocking}`, jobId, jobTitle, company };
  }

  const applyBtn = page.locator(sel.applyButton);
  if (!(await applyBtn.isVisible({ timeout: 3000 }).catch(() => false))) {
    return { status: 'skipped', reason: 'Apply button not found', jobId, jobTitle, company };
  }

  await humanClick(page, sel.applyButton);
  await actionDelay();

  const alreadyApplied = page.locator(sel.alreadyApplied);
  if (await alreadyApplied.isVisible({ timeout: 2000 }).catch(() => false)) {
    return { status: 'skipped', reason: 'already applied to this company recently', jobId, jobTitle, company };
  }

  const fileInput = page.locator(sel.resumeUpload).first();
  if (await fileInput.isVisible({ timeout: 1000 }).catch(() => false)) {
    const resumePath = await writeTempResume(profile);
    await fileInput.setInputFiles(resumePath);
    await actionDelay();
  }

  const chatbotResult = await handleChatbot(page, profile);
  if (!chatbotResult.ok) {
    return { status: 'skipped', reason: chatbotResult.reason, jobId, jobTitle, company };
  }

  const success = page.locator(sel.successBanner);
  const confirmed = await success.isVisible({ timeout: 10000 }).catch(() => false);

  if (!confirmed) {
    const instantApply = page.locator(sel.appliedBadge);
    if (await instantApply.isVisible({ timeout: 2000 }).catch(() => false)) {
      await applicationDelay();
      return { status: 'applied', jobId, jobTitle, company };
    }
    return { status: 'failed', reason: 'success confirmation not detected', jobId, jobTitle, company };
  }

  await applicationDelay();
  return { status: 'applied', jobId, jobTitle, company };
}

export async function getJobCardCount(page: Page): Promise<number> {
  return page.locator(getSelectors().jobCard).count();
}

export async function goToNextPage(page: Page): Promise<boolean> {
  const next = page.locator(getSelectors().paginationNext);
  if (!(await next.isVisible({ timeout: 2000 }).catch(() => false))) return false;
  await humanClick(page, getSelectors().paginationNext);
  await actionDelay();
  return true;
}
