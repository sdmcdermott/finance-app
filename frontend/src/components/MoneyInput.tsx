import React, { useState, useEffect, useRef, forwardRef } from 'react';
import { ItemizeIcon } from './ItemizeModal';
import { DeductionItem } from '../api/client';

/**
 * Formats a number as $d,ddd.cc.
 * Returns empty string for 0 / undefined so the placeholder shows instead.
 */
function fmtMoney(value: number): string {
  if (!value) return '';
  return value.toLocaleString('en-US', {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

interface MoneyInputProps {
  value: number;
  onChange: (v: number) => void;
  placeholder?: string;
  disabled?: boolean;
  /** When provided, renders the itemize icon inside the input */
  onItemize?: () => void;
  /** Whether the field is currently controlled by itemized items */
  itemized?: boolean;
  style?: React.CSSProperties;
}

/**
 * A text input that:
 *  - Displays formatted money ("$6,633.59") when not focused
 *  - Shows the raw number ("6633.59") while focused for easy editing
 *  - Optionally renders an itemize icon button at the right edge
 *  - Disables direct editing when `itemized` is true (icon still clickable)
 */
export const MoneyInput = forwardRef<HTMLInputElement, MoneyInputProps>(
  ({ value, onChange, placeholder, disabled, onItemize, itemized, style }, ref) => {
    const [focused, setFocused] = useState(false);
    // Raw string while typing; formatted string when blurred
    const [raw, setRaw] = useState('');
    const inputRef = useRef<HTMLInputElement>(null);

    // When the external value changes while not focused, stay in sync
    useEffect(() => {
      if (!focused) setRaw('');
    }, [value, focused]);

    const displayValue = focused
      ? raw
      : fmtMoney(value);

    const handleFocus = () => {
      setFocused(true);
      // Seed raw with the plain number string (no $ or commas)
      setRaw(value ? String(value) : '');
    };

    const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
      setRaw(e.target.value);
    };

    const handleBlur = () => {
      setFocused(false);
      const parsed = parseFloat(raw.replace(/[^0-9.]/g, '')) || 0;
      onChange(parsed);
      setRaw('');
    };

    const isDisabled = disabled || itemized;

    const wrapStyle: React.CSSProperties = onItemize
      ? { position: 'relative', display: 'flex', alignItems: 'center' }
      : {};

    const inputStyle: React.CSSProperties = {
      padding: '0.4rem 0.6rem',
      borderRadius: 6,
      border: '1px solid #cbd5e0',
      fontSize: '0.875rem',
      width: '100%',
      boxSizing: 'border-box',
      ...(onItemize ? { paddingRight: '2rem' } : {}),
      ...(itemized ? { background: '#f7fafc', color: '#6b7280' } : {}),
      ...style,
    };

    return (
      <div style={wrapStyle}>
        <input
          ref={ref ?? inputRef}
          type="text"
          inputMode="decimal"
          value={displayValue}
          placeholder={placeholder}
          disabled={isDisabled}
          style={inputStyle}
          onFocus={handleFocus}
          onChange={handleChange}
          onBlur={handleBlur}
        />
        {onItemize && (
          <button
            type="button"
            style={{
              position: 'absolute', right: 6, top: '50%', transform: 'translateY(-50%)',
              background: 'none', border: 'none', padding: '2px 2px 0', cursor: 'pointer',
              display: 'flex', alignItems: 'center', lineHeight: 1,
            }}
            title="Click to itemize individual amounts"
            onClick={onItemize}
          >
            <ItemizeIcon size={15} color={itemized ? '#0d7a6b' : '#6b7280'} />
          </button>
        )}
      </div>
    );
  }
);

MoneyInput.displayName = 'MoneyInput';
