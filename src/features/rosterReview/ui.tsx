import { useState } from 'react';
import { cn } from '../../lib/utils';
import { btnGhost, inputClass } from './styles';

/** Small controls for the roster review (classes in ./styles). */

const NEW_ROLE = '__new_role__';

/**
 * Role choice: the venue's roles plus the common ones, or a new role typed in. `value` null
 * means "keep what the roster said" (the first option).
 */
export function RolePicker({
  value,
  options,
  keepLabel,
  onChange,
  label,
}: {
  value: string | null;
  options: string[];
  keepLabel: string;
  onChange: (role: string | null) => void;
  label: string;
}) {
  const [typing, setTyping] = useState(false);
  const [draft, setDraft] = useState('');
  const all = value && !options.includes(value) ? [...options, value] : options;

  if (typing) {
    const commit = () => {
      const role = draft.trim();
      setTyping(false);
      setDraft('');
      if (role) onChange(role);
    };
    return (
      <div className="flex gap-2">
        <input
          aria-label={`${label}: new role name`}
          className={inputClass}
          value={draft}
          autoFocus
          maxLength={80}
          placeholder="e.g. Sommelier"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
            if (e.key === 'Escape') setTyping(false);
          }}
        />
        <button type="button" className={btnGhost} onClick={commit}>
          Use
        </button>
      </div>
    );
  }

  return (
    <select
      aria-label={label}
      className={cn(inputClass, 'appearance-auto')}
      value={value ?? ''}
      onChange={(e) => {
        if (e.target.value === NEW_ROLE) setTyping(true);
        else onChange(e.target.value || null);
      }}
    >
      <option value="">{keepLabel}</option>
      {all.map((role) => (
        <option key={role} value={role}>
          {role}
        </option>
      ))}
      <option value={NEW_ROLE}>New role…</option>
    </select>
  );
}

/** A 44px tap target holding a checkbox-looking square, for multi-select. */
export function SelectBox({ checked, onToggle, label }: { checked: boolean; onToggle: () => void; label: string }) {
  return (
    <button type="button" role="checkbox" aria-checked={checked} aria-label={label} onClick={onToggle} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-lg">
      <span
        aria-hidden
        className={cn(
          'flex h-5 w-5 items-center justify-center rounded-md border transition-colors duration-150',
          checked ? 'border-accent bg-accent text-primary-foreground' : 'border-foreground/30 bg-transparent',
        )}
      >
        {checked && (
          <svg width={12} height={12} viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
            <path d="M2.5 6.2l2.3 2.3 4.7-5" />
          </svg>
        )}
      </span>
    </button>
  );
}
