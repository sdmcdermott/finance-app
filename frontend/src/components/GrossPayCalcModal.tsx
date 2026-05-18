import React, { useState } from 'react';

const FREQUENCY_LABELS: Record<string, string> = {
  weekly:      'Weekly',
  biweekly:    'Bi-weekly',
  semimonthly: 'Semi-monthly',
  monthly:     'Monthly',
};

const PERIODS_PER_YEAR: Record<string, number> = {
  weekly:      52,
  biweekly:    26,
  semimonthly: 24,
  monthly:     12,
};

type Frequency = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

interface Props {
  frequency: Frequency;
  onConfirm: (grossPerPeriod: number, frequency: Frequency) => void;
  onClose: () => void;
}

export const GrossPayCalcModal: React.FC<Props> = ({ frequency: initialFrequency, onConfirm, onClose }) => {
  const [mode, setMode] = useState<'hourly' | 'salary'>('hourly');
  const [hourlyWage, setHourlyWage] = useState('');
  const [hoursPerWeek, setHoursPerWeek] = useState('40');
  const [yearlySalary, setYearlySalary] = useState('');
  const [frequency, setFrequency] = useState<Frequency>(initialFrequency);

  const periods = PERIODS_PER_YEAR[frequency];

  const grossPerPeriod: number | null = (() => {
    if (mode === 'hourly') {
      const wage = parseFloat(hourlyWage);
      const hrs  = parseFloat(hoursPerWeek);
      if (!wage || !hrs) return null;
      return Math.round((wage * hrs * 52 / periods) * 100) / 100;
    } else {
      const sal = parseFloat(yearlySalary.replace(/[^0-9.]/g, ''));
      if (!sal) return null;
      return Math.round((sal / periods) * 100) / 100;
    }
  })();

  const fmtMoney = (v: number) =>
    v.toLocaleString('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2 });

  const handleBackdrop = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleConfirm = () => {
    if (grossPerPeriod !== null) onConfirm(grossPerPeriod, frequency);
  };

  return (
    <div style={s.backdrop} onClick={handleBackdrop}>
      <div style={s.modal} role="dialog" aria-modal="true" aria-label="Calculate Gross Pay">
        <div style={s.header}>
          <span style={s.headerTitle}>Calculate Gross Pay per Period</span>
          <button style={s.closeBtn} onClick={onClose} aria-label="Close">✕</button>
        </div>

        <div style={s.body}>
          {/* Mode selection */}
          <div style={s.radioGroup}>
            {(['hourly', 'salary'] as const).map(m => (
              <label key={m} style={s.radioLabel}>
                <input
                  type="radio"
                  name="grossMode"
                  value={m}
                  checked={mode === m}
                  onChange={() => setMode(m)}
                  style={{ marginRight: 6 }}
                />
                {m === 'hourly' ? "I'm paid hourly" : 'I know my yearly salary'}
              </label>
            ))}
          </div>

          <div style={s.fields}>
            {mode === 'hourly' ? (
              <>
                <label style={s.label}>
                  Hourly wage ($)
                  <input
                    style={s.input}
                    type="number"
                    min="0"
                    step="0.01"
                    value={hourlyWage}
                    onChange={e => setHourlyWage(e.target.value)}
                    placeholder="e.g. 25.00"
                    autoFocus
                  />
                </label>
                <label style={s.label}>
                  Hours per week
                  <input
                    style={s.input}
                    type="number"
                    min="0"
                    step="0.5"
                    value={hoursPerWeek}
                    onChange={e => setHoursPerWeek(e.target.value)}
                    placeholder="e.g. 40"
                  />
                </label>
              </>
            ) : (
              <label style={s.label}>
                Annual salary ($)
                <input
                  style={s.input}
                  type="number"
                  min="0"
                  step="1"
                  value={yearlySalary}
                  onChange={e => setYearlySalary(e.target.value)}
                  placeholder="e.g. 75000"
                  autoFocus
                />
              </label>
            )}

            <label style={s.label}>
              Pay frequency
              <select
                style={s.select}
                value={frequency}
                onChange={e => setFrequency(e.target.value as Frequency)}
              >
                {Object.entries(FREQUENCY_LABELS).map(([v, l]) => (
                  <option key={v} value={v}>{l}</option>
                ))}
              </select>
            </label>
          </div>

          {/* Live result preview */}
          <div style={s.result}>
            <span style={s.resultLabel}>Gross pay per period</span>
            <span style={grossPerPeriod !== null ? s.resultValue : s.resultPlaceholder}>
              {grossPerPeriod !== null ? fmtMoney(grossPerPeriod) : '—'}
            </span>
          </div>
        </div>

        <div style={s.footer}>
          <button style={s.cancelBtn} onClick={onClose}>Cancel</button>
          <button
            style={grossPerPeriod !== null ? s.okBtn : s.okBtnDisabled}
            disabled={grossPerPeriod === null}
            onClick={handleConfirm}
          >
            Use this amount
          </button>
        </div>
      </div>
    </div>
  );
};

const s: Record<string, React.CSSProperties> = {
  backdrop:        { position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.4)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 },
  modal:           { background: '#fff', borderRadius: 10, boxShadow: '0 8px 32px rgba(0,0,0,0.18)', width: '90%', maxWidth: 420, display: 'flex', flexDirection: 'column' },
  header:          { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.85rem 1.1rem', borderBottom: '1px solid #e2e8f0' },
  headerTitle:     { fontWeight: 600, fontSize: '0.95rem', color: '#1a202c' },
  closeBtn:        { background: 'none', border: 'none', cursor: 'pointer', fontSize: '0.9rem', color: '#6b7280', padding: '0 0.2rem', lineHeight: 1 },
  body:            { padding: '1rem 1.1rem', display: 'flex', flexDirection: 'column', gap: '1rem' },
  radioGroup:      { display: 'flex', flexDirection: 'column', gap: '0.5rem' },
  radioLabel:      { display: 'flex', alignItems: 'center', fontSize: '0.875rem', color: '#374151', cursor: 'pointer' },
  fields:          { display: 'flex', flexDirection: 'column', gap: '0.75rem' },
  label:           { display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.875rem', color: '#374151' },
  input:           { padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid #cbd5e0', fontSize: '0.875rem' },
  select:          { padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid #cbd5e0', fontSize: '0.875rem' },
  result:          { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '0.6rem 0.75rem', background: '#f0fdf4', border: '1px solid #bbf7d0', borderRadius: 7 },
  resultLabel:     { fontSize: '0.875rem', color: '#374151' },
  resultValue:     { fontWeight: 700, fontSize: '1rem', color: '#0d7a6b' },
  resultPlaceholder: { fontSize: '1rem', color: '#9ca3af' },
  footer:          { display: 'flex', justifyContent: 'flex-end', gap: '0.5rem', padding: '0.75rem 1.1rem', borderTop: '1px solid #e2e8f0' },
  cancelBtn:       { background: 'none', color: '#0d7a6b', border: '1px solid #0d7a6b', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  okBtn:           { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  okBtnDisabled:   { background: '#a0aec0', color: '#fff', border: 'none', borderRadius: 6, padding: '0.4rem 1rem', cursor: 'default', fontSize: '0.875rem' },
};
