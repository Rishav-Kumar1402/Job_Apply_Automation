import { useState } from 'react';

interface SecretNumberInputProps {
  value: number | undefined;
  onChange: (value: number | undefined) => void;
  placeholder?: string;
}

/** Number field masked like a password, with show/hide toggle. */
export function SecretNumberInput({
  value,
  onChange,
  placeholder,
}: SecretNumberInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        type={visible ? 'text' : 'password'}
        inputMode="decimal"
        autoComplete="off"
        value={value ?? ''}
        onChange={(e) => {
          const raw = e.target.value.trim();
          if (raw === '') {
            onChange(undefined);
            return;
          }
          if (!/^\d*\.?\d*$/.test(raw)) return;
          const n = Number(raw);
          onChange(Number.isFinite(n) ? n : undefined);
        }}
        placeholder={placeholder}
        className="pr-9"
      />
      <button
        type="button"
        className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted hover:text-gray-700 dark:hover:text-gray-200"
        aria-label={visible ? 'Hide value' : 'Show value'}
        onClick={() => setVisible((v) => !v)}
        tabIndex={-1}
      >
        {visible ? 'Hide' : 'Show'}
      </button>
    </div>
  );
}
