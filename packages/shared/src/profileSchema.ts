import { z } from 'zod';
import {
  DEFAULT_DAILY_CAP,
  MAX_DAILY_CAP,
  MIN_DAILY_CAP,
  RESUME_MAX_SIZE_BYTES,
} from './constants.js';

export const noticePeriodEnum = z.enum([
  'Immediate',
  '15 days',
  '30 days',
  '60 days',
  '90+ days',
]);

export const workAuthorizationEnum = z.enum([
  'Yes',
  'No',
  'Not applicable',
]);

export const remotePreferenceEnum = z.enum([
  'Remote',
  'Hybrid',
  'Onsite',
  'No preference',
]);

export const datePostedEnum = z.enum([
  'Past 24h',
  'Past week',
  'Any time',
]);

export const platformEnum = z.enum(['linkedin', 'naukri']);

export const resumeFileSchema = z.object({
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  base64: z.string().min(1),
  sizeBytes: z.number().max(RESUME_MAX_SIZE_BYTES),
});

export type ResumeFile = z.infer<typeof resumeFileSchema>;

export const profileSchema = z.object({
  fullName: z.string().min(1, 'Full name is required'),
  email: z.string().email('Valid email is required'),
  phone: z.string().min(5, 'Phone with country code is required'),
  currentLocation: z.string().min(1, 'Location is required'),
  resumeFile: resumeFileSchema,
  linkedinResumeAlreadyUploaded: z.boolean().default(false),
  totalExperienceYears: z.number().min(0).max(50),
  currentCTC: z.number().min(0).optional(),
  expectedCTC: z.number().min(0).optional(),
  ctcCurrency: z.string().default('INR'),
  noticePeriod: noticePeriodEnum.optional(),
  workAuthorization: workAuthorizationEnum.optional(),
  requiresSponsorship: z.boolean().optional(),
  willingToRelocate: z.boolean().optional(),
  remotePreference: remotePreferenceEnum.optional(),
  coverLetterTemplate: z.string().optional(),
  /** Academic percentages (0–100) used for recruiter chatbot answers */
  percentage10th: z.number().min(0).max(100).optional(),
  percentage12th: z.number().min(0).max(100).optional(),
  graduationPercentage: z.number().min(0).max(100).optional(),
  /** CGPA on a 10-point scale (e.g. 8.5) */
  cgpa: z.number().min(0).max(10).optional(),
  /** Date of birth as YYYY-MM-DD — recruiter chatbots ask for it directly */
  dateOfBirth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD').optional(),
  /** Public LinkedIn profile URL — Easy Apply forms often make "LinkedIn*" a required field */
  linkedinProfileUrl: z.string().max(300).optional(),
  /** Portfolio / GitHub / personal site asked alongside the LinkedIn field */
  portfolioUrl: z.string().max(300).optional(),
  /** Last resume headline pushed to / saved for Naukri profile */
  naukriResumeHeadline: z.string().max(250).optional(),
});

export type Profile = z.infer<typeof profileSchema>;

export const naukriProfileUpdateSchema = z.object({
  updateResume: z.boolean(),
  updateHeadline: z.boolean(),
  /** When updateResume is true: use profile resume unless resumeFile is provided */
  useExistingResume: z.boolean().default(true),
  resumeFile: resumeFileSchema.optional(),
  headline: z.string().max(250).optional(),
}).refine(
  (v) => v.updateResume || v.updateHeadline,
  { message: 'Select at least resume or headline to update' },
).refine(
  (v) => !v.updateHeadline || Boolean(v.headline?.trim()),
  { message: 'Headline text is required when updating headline' },
);

export type NaukriProfileUpdateRequest = z.infer<typeof naukriProfileUpdateSchema>;

export const searchCriteriaSchema = z.object({
  platform: platformEnum,
  jobTitles: z.string().min(1, 'At least one job title is required'),
  location: z.string().optional(),
  experienceLevel: z.string().optional(),
  notificationEmail: z.string().email().optional().or(z.literal('')),
  datePosted: datePostedEnum.default('Past week'),
  easyApplyOnly: z.boolean().default(true),
  dailyApplicationCap: z
    .number()
    .min(MIN_DAILY_CAP)
    .max(MAX_DAILY_CAP)
    .default(DEFAULT_DAILY_CAP),
});

export type SearchCriteria = z.infer<typeof searchCriteriaSchema>;

export const uiPreferencesSchema = z.object({
  lastPlatform: platformEnum.optional(),
  lastJobTitles: z.string().optional(),
  lastLocation: z.string().optional(),
  lastExperienceLevel: z.string().optional(),
  lastDatePosted: datePostedEnum.optional(),
  lastNotificationEmail: z.string().optional(),
  lastDailyCap: z.number().optional(),
});

export type UiPreferences = z.infer<typeof uiPreferencesSchema>;

export function validateProfileForPlatform(
  profile: Profile,
  platform: 'linkedin' | 'naukri',
): string[] {
  const errors: string[] = [];
  const base = profileSchema.safeParse(profile);
  if (!base.success) {
    return base.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`);
  }

  if (platform === 'linkedin' && !profile.workAuthorization) {
    errors.push('workAuthorization: Required for LinkedIn applications');
  }

  if (platform === 'naukri') {
    if (profile.expectedCTC === undefined) {
      errors.push('expectedCTC: Required for Naukri applications');
    }
    if (!profile.noticePeriod) {
      errors.push('noticePeriod: Required for Naukri applications');
    }
  }

  return errors;
}
