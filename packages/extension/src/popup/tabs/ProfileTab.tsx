import { useState, useEffect } from 'react';
import {
  profileSchema,
  validateProfileForPlatform,
  type Profile,
} from '@job-autoapply/shared';
import {
  saveProfile,
  readResumeFile,
  loadProfile,
} from '../../lib/storage';
import { useAppStore } from '../store';
import { ResumeUpload } from '../components/ResumeUpload';
import { NaukriProfileUpdatePanel } from '../components/NaukriProfileUpdatePanel';
import { SecretNumberInput } from '../components/SecretNumberInput';
import { SecretTextInput } from '../components/SecretTextInput';

const emptyProfile = (): Profile => ({
  fullName: '',
  email: '',
  phone: '',
  currentLocation: '',
  resumeFile: { fileName: '', mimeType: '', base64: '', sizeBytes: 0 },
  linkedinResumeAlreadyUploaded: false,
  totalExperienceYears: 0,
  ctcCurrency: 'INR',
});

export function ProfileTab({ onLocked }: { onLocked?: () => void }) {
  const { profile, setProfile } = useAppStore();
  const [form, setForm] = useState<Profile>(profile ?? emptyProfile());
  const [errors, setErrors] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [showSavedToast, setShowSavedToast] = useState(false);
  const [isEditing, setIsEditing] = useState(true);

  useEffect(() => {
    loadProfile().then((p) => {
      if (p) {
        setForm(p);
        setProfile(p);
        setSaved(true);
        setShowSavedToast(false);
        setIsEditing(false);
      }
    });
  }, [setProfile]);

  useEffect(() => {
    if (!showSavedToast) return;
    const timer = window.setTimeout(() => setShowSavedToast(false), 2500);
    return () => window.clearTimeout(timer);
  }, [showSavedToast]);

  const update = <K extends keyof Profile>(key: K, value: Profile[K]) => {
    if (!isEditing || saving) return;
    setForm((f) => ({ ...f, [key]: value }));
    setSaved(false);
  };

  const handleResumeFile = async (file: File) => {
    try {
      const resumeFile = await readResumeFile(file);
      update('resumeFile', resumeFile);
      setErrors([]);
    } catch (err) {
      setErrors([(err as Error).message]);
    }
  };

  const handleSave = async () => {
    setErrors([]);
    setSaved(false);
    setShowSavedToast(false);

    const cleaned = {
      ...form,
      remotePreference: form.remotePreference || undefined,
      workAuthorization: form.workAuthorization || undefined,
      noticePeriod: form.noticePeriod || undefined,
      expectedCTC: form.expectedCTC || undefined,
      currentCTC: form.currentCTC || undefined,
      dateOfBirth: form.dateOfBirth?.trim() || undefined,
      linkedinProfileUrl: form.linkedinProfileUrl?.trim() || undefined,
      portfolioUrl: form.portfolioUrl?.trim() || undefined,
      percentage10th: form.percentage10th || undefined,
      percentage12th: form.percentage12th || undefined,
      graduationPercentage: form.graduationPercentage || undefined,
      cgpa: form.cgpa || undefined,
      coverLetterTemplate: form.coverLetterTemplate?.trim() || undefined,
      naukriResumeHeadline: form.naukriResumeHeadline?.trim() || undefined,
    };

    const result = profileSchema.safeParse(cleaned);
    if (!result.success) {
      setErrors(result.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`));
      return;
    }
    if (!form.resumeFile.fileName) {
      setErrors(['Resume file is required']);
      return;
    }

    setSaving(true);
    try {
      await saveProfile(result.data);
      setProfile(result.data);
      setSaved(true);
      setShowSavedToast(true);
      setIsEditing(false);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Save failed';
      setErrors([message]);
      if (message.toLowerCase().includes('locked') && onLocked) {
        onLocked();
      }
    } finally {
      setSaving(false);
    }
  };

  const fieldsDisabled = saving || !isEditing;

  return (
    <div className="screen space-y-4">
      <NaukriProfileUpdatePanel
        profile={form.resumeFile.fileName ? form : (profile ?? form)}
        onProfileUpdated={(p) => {
          setForm(p);
          setProfile(p);
        }}
      />

      {(saving || showSavedToast) && (
        <div className={`toast ${saving ? 'toast-info' : 'toast-success'}`}>
          {saving && <span className="spinner" />}
          <span>{saving ? 'Saving profile securely...' : 'Profile saved. Click Edit to change details.'}</span>
        </div>
      )}

      <div className="section-card">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-semibold">Your Profile</h2>
            <p className="text-xs text-muted">Fill once, reuse for every application.</p>
          </div>
          {!isEditing && (
            <button
              type="button"
              className="btn-secondary py-1.5 px-3"
              onClick={() => {
                setIsEditing(true);
                setSaved(false);
                setShowSavedToast(false);
              }}
            >
              Edit
            </button>
          )}
        </div>
      </div>

      {errors.length > 0 && (
        <div className="alert alert-error">
          {errors.map((e) => (
            <div key={e}>{e}</div>
          ))}
        </div>
      )}

      <fieldset disabled={fieldsDisabled} className="space-y-4 disabled:opacity-75">
      <div className="section-card grid grid-cols-2 gap-3">
        <div className="col-span-2">
          <label>Full Name *</label>
          <input value={form.fullName} onChange={(e) => update('fullName', e.target.value)} />
        </div>
        <div>
          <label>Email *</label>
          <input type="email" value={form.email} onChange={(e) => update('email', e.target.value)} />
        </div>
        <div>
          <label>Phone *</label>
          <input value={form.phone} onChange={(e) => update('phone', e.target.value)} placeholder="+91..." />
        </div>
        <div className="col-span-2">
          <label>Current Location *</label>
          <input value={form.currentLocation} onChange={(e) => update('currentLocation', e.target.value)} />
        </div>
        <div>
          <label>Experience (years) *</label>
          <input
            type="number"
            min={0}
            value={form.totalExperienceYears}
            onChange={(e) => update('totalExperienceYears', Number(e.target.value))}
          />
        </div>
        <div>
          <label>Remote Preference</label>
          <select
            value={form.remotePreference ?? ''}
            onChange={(e) => update('remotePreference', e.target.value as Profile['remotePreference'])}
          >
            <option value="">—</option>
            <option value="Remote">Remote</option>
            <option value="Hybrid">Hybrid</option>
            <option value="Onsite">Onsite</option>
            <option value="No preference">No preference</option>
          </select>
        </div>
      </div>

      <div className="section-card space-y-3">
        <h3 className="text-sm font-medium">LinkedIn</h3>
        <div>
          <label>LinkedIn Profile URL</label>
          <input
            value={form.linkedinProfileUrl ?? ''}
            onChange={(e) => update('linkedinProfileUrl', e.target.value as Profile['linkedinProfileUrl'])}
            placeholder="https://www.linkedin.com/in/your-handle"
          />
          <p className="mt-1 text-xs text-muted">
            Easy Apply forms often make “LinkedIn*” a required field.
          </p>
        </div>
        <div>
          <label>Portfolio / GitHub URL</label>
          <input
            value={form.portfolioUrl ?? ''}
            onChange={(e) => update('portfolioUrl', e.target.value as Profile['portfolioUrl'])}
            placeholder="https://github.com/your-handle"
          />
        </div>
        <div>
          <label>Work Authorization *</label>
          <select
            value={form.workAuthorization ?? ''}
            onChange={(e) => update('workAuthorization', e.target.value as Profile['workAuthorization'])}
          >
            <option value="">—</option>
            <option value="Yes">Yes</option>
            <option value="No">No</option>
            <option value="Not applicable">Not applicable</option>
          </select>
        </div>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.linkedinResumeAlreadyUploaded}
            onChange={(e) => update('linkedinResumeAlreadyUploaded', e.target.checked)}
          />
          <span className="text-sm">Use resume already on LinkedIn</span>
        </label>
        <label className="flex items-center gap-2 cursor-pointer">
          <input
            type="checkbox"
            checked={form.requiresSponsorship ?? false}
            onChange={(e) => update('requiresSponsorship', e.target.checked)}
          />
          <span className="text-sm">Requires visa sponsorship</span>
        </label>
      </div>

      <div className="section-card space-y-3">
        <h3 className="text-sm font-medium">Naukri</h3>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label>Expected CTC (Lacs PA)</label>
            <SecretNumberInput
              value={form.expectedCTC}
              onChange={(v) => update('expectedCTC', v as Profile['expectedCTC'])}
              placeholder="e.g. 10"
            />
          </div>
          <div>
            <label>Current CTC (Lacs PA)</label>
            <SecretNumberInput
              value={form.currentCTC}
              onChange={(v) => update('currentCTC', v as Profile['currentCTC'])}
              placeholder="e.g. 8"
            />
          </div>
          <div className="col-span-2">
            <label>Date of Birth</label>
            <SecretTextInput
              type="date"
              value={form.dateOfBirth}
              onChange={(v) => update('dateOfBirth', v as Profile['dateOfBirth'])}
              placeholder="YYYY-MM-DD"
            />
            <p className="mt-1 text-xs text-muted">Used when a recruiter chat asks for your DOB.</p>
          </div>
          <div className="col-span-2">
            <label>Notice Period</label>
            <select
              value={form.noticePeriod ?? ''}
              onChange={(e) => update('noticePeriod', e.target.value as Profile['noticePeriod'])}
            >
              <option value="">—</option>
              <option value="Immediate">Immediate</option>
              <option value="15 days">15 days</option>
              <option value="30 days">30 days</option>
              <option value="60 days">60 days</option>
              <option value="90+ days">90+ days</option>
            </select>
          </div>
        </div>
      </div>

      <div className="section-card space-y-3">
        <h3 className="text-sm font-medium">Education (for chatbot)</h3>
        <p className="text-xs text-muted">Used when recruiters ask for marks / percentage / CGPA.</p>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label>10th %</label>
            <input
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={form.percentage10th ?? ''}
              onChange={(e) => update('percentage10th', e.target.value === '' ? undefined : Number(e.target.value))}
              placeholder="e.g. 95"
            />
          </div>
          <div>
            <label>12th %</label>
            <input
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={form.percentage12th ?? ''}
              onChange={(e) => update('percentage12th', e.target.value === '' ? undefined : Number(e.target.value))}
              placeholder="e.g. 92"
            />
          </div>
          <div>
            <label>Graduation %</label>
            <input
              type="number"
              min={0}
              max={100}
              step={0.01}
              value={form.graduationPercentage ?? ''}
              onChange={(e) => update('graduationPercentage', e.target.value === '' ? undefined : Number(e.target.value))}
              placeholder="e.g. 80"
            />
          </div>
          <div>
            <label>CGPA (out of 10)</label>
            <input
              type="number"
              min={0}
              max={10}
              step={0.01}
              value={form.cgpa ?? ''}
              onChange={(e) => update('cgpa', e.target.value === '' ? undefined : Number(e.target.value))}
              placeholder="e.g. 8.5"
            />
          </div>
        </div>
      </div>

      <div className="section-card">
        <label>Resume (PDF/DOCX) *</label>
        <ResumeUpload
          fileName={form.resumeFile.fileName || undefined}
          disabled={fieldsDisabled}
          onFile={handleResumeFile}
        />
      </div>

      <div className="section-card">
        <label>Cover Letter Template (optional)</label>
        <textarea
          rows={3}
          value={form.coverLetterTemplate ?? ''}
          onChange={(e) => update('coverLetterTemplate', e.target.value)}
          placeholder="Static cover letter for plain-text fields only"
        />
      </div>

      <label className="flex items-center gap-2 cursor-pointer">
        <input
          type="checkbox"
          checked={form.willingToRelocate ?? false}
          onChange={(e) => update('willingToRelocate', e.target.checked)}
        />
        <span className="text-sm">Willing to relocate</span>
      </label>
      </fieldset>

      {isEditing && (
        <button className="btn-primary w-full" onClick={handleSave} disabled={saving}>
          {saving ? 'Saving...' : 'Save Profile'}
        </button>
      )}
    </div>
  );
}

export { validateProfileForPlatform };