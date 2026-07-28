import { describe, it, expect } from 'vitest';
import { mapQuestion, meetsConfidenceThreshold } from './questionMapper.js';
import type { Profile } from '@job-autoapply/shared';

describe('questionMapper', () => {
  const profile: Profile = {
    fullName: 'Jane',
    email: 'jane@example.com',
    phone: '+911234567890',
    currentLocation: 'Bangalore',
    resumeFile: { fileName: 'r.pdf', mimeType: 'application/pdf', base64: 'x', sizeBytes: 1 },
    totalExperienceYears: 5,
    workAuthorization: 'Yes',
    requiresSponsorship: false,
    willingToRelocate: true,
    expectedCTC: 2000000,
    noticePeriod: '30 days',
    linkedinResumeAlreadyUploaded: false,
    ctcCurrency: 'INR',
  };

  it('maps work authorization questions', () => {
    const result = mapQuestion('Are you legally authorized to work in India?', profile);
    expect(result?.value).toBe('Yes');
    expect(meetsConfidenceThreshold(result!.confidence)).toBe(true);
  });

  it('returns null for unknown questions', () => {
    expect(mapQuestion('What is your favorite color?', profile)).toBeNull();
  });
});
