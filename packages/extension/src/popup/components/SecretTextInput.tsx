import { useState } from 'react';

interface SecretTextInputProps {
  value: string | undefined;
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  type?: 'text' | 'date';
}

/** Text/date field masked like a password, with show/hide toggle. */
export function SecretTextInput({
  value,
  onChange,
  placeholder,
  type = 'text',
}: SecretTextInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input
        type={visible ? type : 'password'}
        autoComplete="off"
        value={value ?? ''}
        onChange={(e) => {
          const raw = e.target.value.trim();
          onChange(raw === '' ? undefined : raw);
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
