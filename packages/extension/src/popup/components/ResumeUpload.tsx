import { useRef, useState } from 'react';

interface ResumeUploadProps {
  fileName?: string;
  disabled?: boolean;
  onFile: (file: File) => void;
}

/** Chrome closes extension popups when the native file picker opens. */
export function isNarrowPopup(): boolean {
  return window.outerWidth <= 480;
}

export function ResumeUpload({ fileName, disabled = false, onFile }: ResumeUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const narrowPopup = isNarrowPopup();

  const handleFile = (file: File | undefined) => {
    if (disabled) return;
    if (!file) return;
    onFile(file);
  };

  const openSidePanel = async () => {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.windowId) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
      }
    } catch {
      chrome.runtime.openOptionsPage();
    }
  };

  return (
    <div className="space-y-2">
      <div
        role="button"
        tabIndex={0}
        onDragOver={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (disabled) return;
          setDragOver(true);
        }}
        onDragLeave={() => !disabled && setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          e.stopPropagation();
          if (disabled) return;
          setDragOver(false);
          handleFile(e.dataTransfer.files[0]);
        }}
        className={`upload-card ${disabled ? 'upload-card-disabled' : ''} ${
          dragOver ? 'border-brand-500 bg-brand-50' : 'border-gray-300 bg-gray-50'
        }`}
      >
        {fileName ? (
          <p className="text-sm text-green-700 font-medium break-all">{fileName}</p>
        ) : (
          <p className="text-sm text-gray-600">Drag &amp; drop resume here</p>
        )}
        <p className="text-xs text-gray-400 mt-1">PDF or DOCX, max 5 MB</p>
      </div>

      {narrowPopup ? (
        <p className="text-xs text-gray-500">
          The popup closes if you use Browse — drag &amp; drop instead, or{' '}
          <button type="button" className="text-brand-600 underline" onClick={openSidePanel}>
            open the side panel
          </button>{' '}
          /{' '}
          <button type="button" className="text-brand-600 underline" onClick={() => chrome.runtime.openOptionsPage()}>
            Settings
          </button>{' '}
          to browse for a file.
        </p>
      ) : (
        <div>
          <input
            ref={inputRef}
            type="file"
            disabled={disabled}
            accept=".pdf,.docx,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) handleFile(file);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            className="btn-secondary w-full text-sm"
            disabled={disabled}
            onClick={() => inputRef.current?.click()}
          >
            Browse for file
          </button>
        </div>
      )}
    </div>
  );
}
