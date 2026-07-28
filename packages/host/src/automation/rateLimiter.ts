import { ACTION_DELAY_MS, APPLICATION_DELAY_MS } from '@job-autoapply/shared';

export function randomDelay(min: number, max: number): Promise<void> {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function actionDelay(): Promise<void> {
  await randomDelay(ACTION_DELAY_MS.min, ACTION_DELAY_MS.max);
}

export async function applicationDelay(): Promise<void> {
  await randomDelay(APPLICATION_DELAY_MS.min, APPLICATION_DELAY_MS.max);
}

export class RateLimiter {
  private appliedToday = 0;

  constructor(
    private dailyCap: number,
    private existingToday: number,
  ) {
    this.appliedToday = existingToday;
  }

  canApply(): boolean {
    return this.appliedToday < this.dailyCap;
  }

  recordApplied(): void {
    this.appliedToday++;
  }

  remaining(): number {
    return Math.max(0, this.dailyCap - this.appliedToday);
  }
}
