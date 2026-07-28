import type { Profile } from '@job-autoapply/shared';

export interface QuestionMapping {
  patterns: string[];
  field: keyof Profile | 'yes' | 'no';
  confidence: number;
}

const DEFAULT_MAPPINGS: QuestionMapping[] = [
  { patterns: ['authorized to work', 'legally authorized', 'work authorization'], field: 'workAuthorization', confidence: 0.9 },
  { patterns: ['sponsorship', 'visa sponsor'], field: 'requiresSponsorship', confidence: 0.9 },
  { patterns: ['relocate', 'relocation', 'willing to move'], field: 'willingToRelocate', confidence: 0.85 },
  { patterns: ['years of experience', 'total experience', 'how many years'], field: 'totalExperienceYears', confidence: 0.8 },
  { patterns: ['expected ctc', 'expected salary', 'desired salary'], field: 'expectedCTC', confidence: 0.9 },
  { patterns: ['current ctc', 'current salary'], field: 'currentCTC', confidence: 0.9 },
  { patterns: ['notice period', 'joining period'], field: 'noticePeriod', confidence: 0.9 },
  { patterns: ['10th', 'tenth percentage', 'ssc'], field: 'percentage10th', confidence: 0.9 },
  { patterns: ['12th', 'twelfth percentage', 'hsc', 'intermediate'], field: 'percentage12th', confidence: 0.9 },
  { patterns: ['graduation percentage', 'degree percentage', 'aggregate'], field: 'graduationPercentage', confidence: 0.85 },
  { patterns: ['cgpa', 'sgpa', 'gpa'], field: 'cgpa', confidence: 0.9 },
  { patterns: ['phone', 'mobile number', 'contact number'], field: 'phone', confidence: 0.95 },
  { patterns: ['email'], field: 'email', confidence: 0.95 },
];

export interface MappedAnswer {
  value: string;
  confidence: number;
  field: string;
}

export function mapQuestion(questionText: string, profile: Profile): MappedAnswer | null {
  const normalized = questionText.toLowerCase().trim();

  for (const mapping of DEFAULT_MAPPINGS) {
    const matched = mapping.patterns.some((p) => normalized.includes(p));
    if (!matched) continue;

    const raw = profile[mapping.field as keyof Profile];
    if (raw === undefined || raw === null || raw === '') continue;

    let value: string;
    if (typeof raw === 'boolean') {
      value = raw ? 'Yes' : 'No';
    } else {
      value = String(raw);
    }

    return { value, confidence: mapping.confidence, field: mapping.field };
  }

  return null;
}

export function isFreeTextQuestion(questionText: string): boolean {
  const normalized = questionText.toLowerCase();
  const freeTextIndicators = [
    'why are you',
    'tell us about',
    'describe your',
    'cover letter',
    'additional information',
    'anything else',
  ];
  return freeTextIndicators.some((i) => normalized.includes(i));
}

const CONFIDENCE_THRESHOLD = 0.75;

export function meetsConfidenceThreshold(confidence: number): boolean {
  return confidence >= CONFIDENCE_THRESHOLD;
}

export function closestNoticePeriod(
  options: string[],
  profileValue: string | undefined,
): { value: string; confidence: number } | null {
  if (!profileValue) return null;
  const normalized = profileValue.toLowerCase();
  for (const opt of options) {
    const optNorm = opt.toLowerCase();
    if (optNorm.includes(normalized) || normalized.includes(optNorm)) {
      return { value: opt, confidence: 0.85 };
    }
    if (normalized.includes('immediate') && optNorm.includes('immediate')) {
      return { value: opt, confidence: 0.9 };
    }
    const days = normalized.match(/(\d+)/);
    const optDays = optNorm.match(/(\d+)/);
    if (days && optDays && days[1] === optDays[1]) {
      return { value: opt, confidence: 0.8 };
    }
  }
  return null;
}
