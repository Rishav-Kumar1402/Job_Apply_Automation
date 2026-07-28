import { describe, it, expect } from 'vitest';
import { profileSchema, validateProfileForPlatform } from '../src/profileSchema';

describe('profileSchema', () => {
  const baseProfile = {
    fullName: 'Jane Doe',
    email: 'jane@example.com',
    phone: '+911234567890',
    currentLocation: 'Bangalore, India',
    resumeFile: {
      fileName: 'resume.pdf',
      mimeType: 'application/pdf',
      base64: 'dGVzdA==',
      sizeBytes: 4,
    },
    totalExperienceYears: 5,
    ctcCurrency: 'INR',
  };

  it('validates a complete profile', () => {
    const result = profileSchema.safeParse(baseProfile);
    expect(result.success).toBe(true);
  });

  it('requires work authorization for LinkedIn', () => {
    const errors = validateProfileForPlatform(baseProfile as never, 'linkedin');
    expect(errors).toContain('workAuthorization: Required for LinkedIn applications');
  });

  it('requires CTC and notice period for Naukri', () => {
    const errors = validateProfileForPlatform(baseProfile as never, 'naukri');
    expect(errors.some((e) => e.includes('expectedCTC'))).toBe(true);
    expect(errors.some((e) => e.includes('noticePeriod'))).toBe(true);
  });
});
