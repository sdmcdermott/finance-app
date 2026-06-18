import React, { useState, useEffect } from 'react';
import { useData } from '../auth/DataContext';
import { IncomeSource, NetPayResult, DeductionItem, putIncomeSource, deleteIncomeSource, getNetPay } from '../api/client';
import { fmtCurrency } from '../utils/dates';
import { ItemizeModal } from '../components/ItemizeModal';
import { MoneyInput } from '../components/MoneyInput';
import { GrossPayCalcModal } from '../components/GrossPayCalcModal';

const US_STATES = [
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA',
  'HI','ID','IL','IN','IA','KS','KY','LA','ME','MD',
  'MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC',
  'SD','TN','TX','UT','VT','VA','WA','WV','WI','WY',
];

const FREQUENCY_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  biweekly: 'Bi-weekly',
  semimonthly: 'Semi-monthly',
  monthly: 'Monthly',
};

const FILING_LABELS: Record<string, string> = {
  single: 'Single',
  married_jointly: 'Married Filing Jointly',
  married_separately: 'Married Filing Separately',
  head_of_household: 'Head of Household',
};

const TAX_LABELS: Record<string, string> = {
  FED_INCOME_EE:   'Federal Income Tax',
  FED_FICA_SS_EE:  'Social Security',
  FED_FICA_MED_EE: 'Medicare',
};

function taxLabel(code: string): string {
  if (TAX_LABELS[code]) return TAX_LABELS[code];
  return code
    .replace(/_EE$/, '')
    .replace(/_/g, ' ')
    .replace(/\b\w/g, c => c.toUpperCase());
}

type FrequencyType = IncomeSource['frequency'];
type FilingStatusType = IncomeSource['filingStatus'];
type FormData = Omit<IncomeSource, 'userId'>;

const emptyForm = (): FormData => ({
  incomeSourceId: '',
  name: '',
  frequency: 'biweekly',
  grossAmount: 0,
  filingStatus: 'single',
  workState: 'CA',
  section125Deductions: 0,
  section125Items: [],
  retirementDeductions: 0,
  retirementItems: [],
  preTaxDeductions: 0,
  additionalWithholding: 0,
  deductionType: 'standard',
  itemizedDeductions: 0,
  itemizedDeductionItems: [],
  step3Credits: 0,
  step4aOtherIncome: 0,
  step4aItems: [],
  step4bDeductions: 0,
  step4bItems: [],
  isActive: true,
});

// editingId: 'new' = new-source form above table; a UUID = inline edit row below that source row
export const IncomePage: React.FC = () => {
  const { incomeSources, setIncomeSources } = useData();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [formData, setFormData] = useState<FormData>(emptyForm());
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');

  // netPayMap: keyed by incomeSourceId (or 'new' while creating)
  const [netPayMap, setNetPayMap] = useState<Record<string, NetPayResult | null>>({});
  // calcBase: snapshot of formData at the time net pay was last calculated.
  // Dirty is derived by comparing current formData to this snapshot.
  const [calcBase, setCalcBase] = useState<FormData | null>(null);
  const [netPayLoading, setNetPayLoading] = useState(false);
  const [netPayError, setNetPayError] = useState('');
  // Which itemize modal is open
  const [itemizeOpen, setItemizeOpen] = useState<'section125' | 'retirement' | 'itemizedDeductions' | 'step4a' | 'step4b' | null>(null);
  const [grossCalcOpen, setGrossCalcOpen] = useState(false);

  // Seed netPayMap from lastNetPay stored on each income source.
  useEffect(() => {
    const initial: Record<string, NetPayResult | null> = {};
    incomeSources.forEach(src => {
      if (src.lastNetPay) initial[src.incomeSourceId] = src.lastNetPay;
    });
    setNetPayMap(prev => ({ ...initial, ...prev }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [incomeSources]);

  const openNew = () => {
    setFormError('');
    setFormData(emptyForm());
    setEditingId('new');
    setCalcBase(null);
    setNetPayError('');
  };

  const openEdit = (src: IncomeSource) => {
    setFormError('');
    const { userId: _u, lastNetPay: _n, ...rest } = src;
    setFormData(rest);
    setEditingId(src.incomeSourceId);
    // Seed calcBase from the saved source fields so dirty detection works on open
    // and the persisted net pay panel shows at full opacity immediately.
    setCalcBase(src.lastNetPay ? rest : null);
    setNetPayError('');
  };

  const cancelEdit = () => {
    setEditingId(null);
    setFormError('');
    setCalcBase(null);
    setNetPayError('');
  };

  // Update a field — no dirty flag needed, derived from calcBase comparison
  const setField = (patch: Partial<FormData>) => {
    setFormData(prev => ({ ...prev, ...patch }));
    setNetPayError('');
  };

  const save = async () => {
    if (!formData.name.trim()) { setFormError('Name is required.'); return; }
    if (formData.grossAmount <= 0) { setFormError('Gross amount must be greater than 0.'); return; }
    setSaving(true);
    setFormError('');
    try {
      const saved = await putIncomeSource(formData);
      setIncomeSources(prev => {
        const idx = prev.findIndex(s => s.incomeSourceId === saved.incomeSourceId);
        if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
        return [...prev, saved];
      });
      // If net pay was calculated for 'new', move it to the real id
      if (editingId === 'new' && netPayMap['new']) {
        setNetPayMap(m => {
          const next = { ...m, [saved.incomeSourceId]: m['new'] };
          delete next['new'];
          return next;
        });
      }
      setEditingId(null);
    } catch (e: any) {
      setFormError(e?.response?.data?.error ?? 'Save failed.');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (src: IncomeSource) => {
    if (!window.confirm(`Delete "${src.name}"?`)) return;
    try {
      await deleteIncomeSource(src.incomeSourceId);
      setIncomeSources(prev => prev.filter(s => s.incomeSourceId !== src.incomeSourceId));
      setNetPayMap(m => { const next = { ...m }; delete next[src.incomeSourceId]; return next; });
    } catch {
      alert('Delete failed.');
    }
  };

  const calculateNetPay = async () => {
    if (!formData.grossAmount) return;
    // For an existing source we need to save first so the backend has the latest
    // values, OR we call getNetPay with the saved id. Since the form might have
    // unsaved changes, we save silently first if editing an existing source,
    // or just call getNetPay on 'new' by temporarily saving.
    // Simplest correct approach: save first (silently), then fetch net pay.
    if (!formData.name.trim()) { setFormError('Name is required before calculating.'); return; }
    setSaving(true);
    setNetPayLoading(true);
    setNetPayError('');
    setFormError('');
    try {
      const saved = await putIncomeSource(formData);
      setIncomeSources(prev => {
        const idx = prev.findIndex(s => s.incomeSourceId === saved.incomeSourceId);
        if (idx >= 0) { const next = [...prev]; next[idx] = saved; return next; }
        return [...prev, saved];
      });
      // Update editingId from 'new' to the real id
      if (editingId === 'new') {
        setFormData(prev => ({ ...prev, incomeSourceId: saved.incomeSourceId }));
        setEditingId(saved.incomeSourceId);
      }
      let result = await getNetPay(saved.incomeSourceId);
      // If the API fell back to the standard deduction, update the form and re-save
      let finalFormData = { ...formData, incomeSourceId: saved.incomeSourceId };
      if (result.deductionWarning && formData.deductionType !== 'standard') {
        const corrected = { ...saved, deductionType: 'standard' as const };
        const reSaved = await putIncomeSource(corrected);
        setIncomeSources(prev => {
          const idx = prev.findIndex(s => s.incomeSourceId === reSaved.incomeSourceId);
          if (idx >= 0) { const next = [...prev]; next[idx] = reSaved; return next; }
          return [...prev, reSaved];
        });
        finalFormData = { ...finalFormData, deductionType: 'standard' };
        setFormData(prev => ({ ...prev, deductionType: 'standard' }));
      }
      setNetPayMap(m => {
        const next = { ...m, [saved.incomeSourceId]: result };
        if (editingId === 'new') delete next['new'];
        return next;
      });
      // Sync lastNetPay back into DataContext so navigating away and returning
      // still shows the calculated result (useEffect seeds netPayMap from this).
      setIncomeSources(prev => {
        const idx = prev.findIndex(s => s.incomeSourceId === saved.incomeSourceId);
        if (idx < 0) return prev;
        const next = [...prev];
        next[idx] = { ...next[idx], lastNetPay: result };
        return next;
      });
      // Snapshot current form values as the base for dirty detection
      setCalcBase(finalFormData);
    } catch (e: any) {
      setNetPayError(e?.response?.data?.error ?? 'Calculation failed.');
    } finally {
      setSaving(false);
      setNetPayLoading(false);
    }
  };

  // The net pay to show inside the form (keyed by current editingId)
  const formNetPay = editingId ? netPayMap[editingId] : null;

  // Dirty: calcBase exists and any relevant field differs from it
  const netPayDirty = calcBase !== null && (() => {
    const keys: (keyof FormData)[] = [
      'grossAmount','frequency','filingStatus','workState',
      'section125Deductions','retirementDeductions',
      'additionalWithholding','deductionType','itemizedDeductions',
      'step3Credits','step4aOtherIncome','step4bDeductions',
    ];
    if (keys.some(k => formData[k] !== calcBase[k])) return true;
    // Also dirty if any items arrays changed (compare JSON for simplicity)
    const itemArrayKeys: (keyof FormData)[] = [
      'section125Items','retirementItems','itemizedDeductionItems','step4aItems','step4bItems',
    ];
    return itemArrayKeys.some(k =>
      JSON.stringify(formData[k] ?? []) !== JSON.stringify(calcBase[k] ?? [])
    );
  })();

  const calcDisabled = !formData.grossAmount || netPayLoading || saving || (calcBase !== null && !netPayDirty);

  const form = (
    <div className="form-card">
      <div style={{ display: 'flex', justifyContent: 'flex-start', marginBottom: '0.5rem' }}>
        <label style={{ ...styles.label, flexDirection: 'row', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
          <span style={toggleStyles.track(formData.isActive)} onClick={() => setField({ isActive: !formData.isActive })}>
            <span style={toggleStyles.thumb(formData.isActive)} />
          </span>
          Active
        </label>
      </div>
      <div style={styles.grid}>
        <label style={styles.label}>
          Name
          <input style={styles.input} value={formData.name}
            onChange={e => setField({ name: e.target.value })}
            placeholder="e.g. Salary - Acme Corp" />
        </label>

        <label style={styles.label}>
          Frequency
          <select style={styles.select} value={formData.frequency}
            onChange={e => setField({ frequency: e.target.value as FrequencyType })}>
            {Object.entries(FREQUENCY_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>

        <label style={styles.label}>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: '0.4rem' }}>
            Gross Pay per Period
            <button type="button" style={styles.calcLink} onClick={() => setGrossCalcOpen(true)}>
              (calculate)
            </button>
          </span>
          <MoneyInput
            value={formData.grossAmount}
            onChange={v => setField({ grossAmount: v })}
          />
        </label>

        <label style={styles.label}>
          Filing Status
          <select style={styles.select} value={formData.filingStatus}
            onChange={e => setField({ filingStatus: e.target.value as FilingStatusType })}>
            {Object.entries(FILING_LABELS).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </label>

        <label style={styles.label}>
          Work State
          <select style={styles.select} value={formData.workState}
            onChange={e => setField({ workState: e.target.value })}>
            {US_STATES.map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>

        <label style={styles.label}>
          Section 125 Deductions / Period
          <MoneyInput
            value={formData.section125Deductions}
            onChange={v => setField({ section125Deductions: v })}
            placeholder="Health/dental/vision, HSA, FSA…"
            itemized={(formData.section125Items?.length ?? 0) > 0}
            onItemize={() => setItemizeOpen('section125')}
          />
          <span style={styles.hint}>Reduces both FICA and income tax</span>
        </label>

        <label style={styles.label}>
          Retirement Deductions / Period
          <MoneyInput
            value={formData.retirementDeductions}
            onChange={v => setField({ retirementDeductions: v })}
            placeholder="401k, 403b, 457…"
            itemized={(formData.retirementItems?.length ?? 0) > 0}
            onItemize={() => setItemizeOpen('retirement')}
          />
          <span style={styles.hint}>Reduces income tax only, not FICA</span>
        </label>

        <label style={styles.label}>
          Extra Federal Withholding / Period
          <MoneyInput
            value={formData.additionalWithholding}
            onChange={v => setField({ additionalWithholding: v })}
            placeholder="W-4 line 4c"
          />
        </label>

        <label style={styles.label}>
          Deduction Type
          <select style={styles.select} value={formData.deductionType}
            onChange={e => setField({ deductionType: e.target.value as 'standard' | 'itemized' })}>
            <option value="standard">Standard Deduction</option>
            <option value="itemized">Itemized Deductions</option>
          </select>
        </label>

        {formData.deductionType === 'itemized' && (
          <label style={styles.label}>
            Annual Itemized Deductions
            <MoneyInput
              value={formData.itemizedDeductions}
              onChange={v => setField({ itemizedDeductions: v })}
              placeholder="Mortgage interest, charity, etc."
              itemized={(formData.itemizedDeductionItems?.length ?? 0) > 0}
              onItemize={() => setItemizeOpen('itemizedDeductions')}
            />
          </label>
        )}

        <label style={styles.label}>
          W-4 Step 3 — Dependent Credits
          <MoneyInput
            value={formData.step3Credits}
            onChange={v => setField({ step3Credits: v })}
            placeholder="e.g. $2,000 per child under 17"
          />
        </label>

        <label style={styles.label}>
          W-4 Step 4a — Other Annual Income
          <MoneyInput
            value={formData.step4aOtherIncome}
            onChange={v => setField({ step4aOtherIncome: v })}
            placeholder="Interest, dividends, side income"
            itemized={(formData.step4aItems?.length ?? 0) > 0}
            onItemize={() => setItemizeOpen('step4a')}
          />
        </label>

        <label style={styles.label}>
          W-4 Step 4b — Additional Annual Deductions
          <MoneyInput
            value={formData.step4bDeductions}
            onChange={v => setField({ step4bDeductions: v })}
            placeholder="Student loan interest, IRA, etc."
            itemized={(formData.step4bItems?.length ?? 0) > 0}
            onItemize={() => setItemizeOpen('step4b')}
          />
        </label>

      </div>

      {formNetPay && (
        <div style={{ ...styles.netPayInForm, opacity: netPayDirty ? 0.45 : 1, transition: 'opacity 0.2s' }}>
          <NetPayPanel result={formNetPay} />
        </div>
      )}

      {netPayError && <p style={styles.error}>{netPayError}</p>}
      {formError && <p style={styles.error}>{formError}</p>}

      <div style={styles.formActions}>
        <button
          style={calcDisabled ? styles.calcBtnDisabled : styles.calcBtn}
          onClick={calculateNetPay}
          disabled={calcDisabled}
        >
          {netPayLoading ? 'Calculating…' : 'Calculate Net Pay'}
        </button>
        <div style={styles.formActionRight}>
          <button style={styles.cancelBtn} onClick={cancelEdit} disabled={saving}>Cancel</button>
          <button style={styles.primaryBtn} onClick={save} disabled={saving}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>

      {/* Itemize modals */}
      {grossCalcOpen && (
        <GrossPayCalcModal
          frequency={formData.frequency}
          onConfirm={(gross, freq) => {
            setField({ grossAmount: gross, frequency: freq });
            setGrossCalcOpen(false);
          }}
          onClose={() => setGrossCalcOpen(false)}
        />
      )}
      {itemizeOpen === 'section125' && (
        <ItemizeModal
          title="Section 125 Deductions (per period)"
          namePlaceholder="e.g. Medical insurance"
          items={formData.section125Items ?? []}
          onConfirm={items => {
            setField({ section125Items: items, section125Deductions: items.reduce((s, r) => s + r.amount, 0) });
            setItemizeOpen(null);
          }}
          onClose={() => setItemizeOpen(null)}
        />
      )}
      {itemizeOpen === 'retirement' && (
        <ItemizeModal
          title="Retirement Deductions (per period)"
          namePlaceholder="e.g. 401k"
          items={formData.retirementItems ?? []}
          onConfirm={items => {
            setField({ retirementItems: items, retirementDeductions: items.reduce((s, r) => s + r.amount, 0) });
            setItemizeOpen(null);
          }}
          onClose={() => setItemizeOpen(null)}
        />
      )}
      {itemizeOpen === 'itemizedDeductions' && (
        <ItemizeModal
          title="Annual Itemized Deductions"
          namePlaceholder="e.g. Mortgage interest"
          items={formData.itemizedDeductionItems ?? []}
          onConfirm={items => {
            setField({ itemizedDeductionItems: items, itemizedDeductions: items.reduce((s, r) => s + r.amount, 0) });
            setItemizeOpen(null);
          }}
          onClose={() => setItemizeOpen(null)}
        />
      )}
      {itemizeOpen === 'step4a' && (
        <ItemizeModal
          title="W-4 Step 4a — Other Annual Income"
          namePlaceholder="e.g. Interest income"
          items={formData.step4aItems ?? []}
          onConfirm={items => {
            setField({ step4aItems: items, step4aOtherIncome: items.reduce((s, r) => s + r.amount, 0) });
            setItemizeOpen(null);
          }}
          onClose={() => setItemizeOpen(null)}
        />
      )}
      {itemizeOpen === 'step4b' && (
        <ItemizeModal
          title="W-4 Step 4b — Additional Annual Deductions"
          namePlaceholder="e.g. Student loan interest"
          items={formData.step4bItems ?? []}
          onConfirm={items => {
            setField({ step4bItems: items, step4bDeductions: items.reduce((s, r) => s + r.amount, 0) });
            setItemizeOpen(null);
          }}
          onClose={() => setItemizeOpen(null)}
        />
      )}
    </div>
  );

  return (
    <div style={styles.page}>
      <div className="page-header">
        <h2 style={styles.heading}>Income Sources</h2>
        {editingId !== 'new' && (
          <button style={styles.primaryBtn} onClick={openNew}>+ New Source</button>
        )}
      </div>

      {/* New source form — above the table */}
      {editingId === 'new' && form}

      {incomeSources.length === 0 && editingId !== 'new' ? (
        <p style={styles.empty}>No income sources yet. Click <strong>+ New Source</strong> to add one.</p>
      ) : (
        <div className="table-wrap">
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Name</th>
                <th style={styles.th}>Frequency</th>
                <th style={styles.th}>Gross Pay</th>
                <th style={styles.th}>Net Pay</th>
                <th style={styles.th}>Status</th>
                <th style={styles.th}></th>
              </tr>
            </thead>
            <tbody>
              {incomeSources.map(src => {
                const id = src.incomeSourceId;
                const isEditing = editingId === id;
                const np = netPayMap[id];
                return (
                  <React.Fragment key={id}>
                    <tr style={styles.tr}>
                      <td style={styles.td}>{src.name}</td>
                      <td style={styles.td}>{FREQUENCY_LABELS[src.frequency] ?? src.frequency}</td>
                      <td style={styles.td}>{fmtCurrency(src.grossAmount)}</td>
                      <td style={styles.td}>
                        {np ? fmtCurrency(np.netPay) : '--'}
                      </td>
                      <td style={styles.td}>
                        <span style={{ ...styles.badge, background: src.isActive ? '#d1fae5' : '#fee2e2', color: src.isActive ? '#065f46' : '#991b1b' }}>
                          {src.isActive ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td style={{ ...styles.td, whiteSpace: 'nowrap' }}>
                        {isEditing ? (
                          <button style={styles.linkBtn} onClick={cancelEdit}>Cancel</button>
                        ) : (
                          <>
                            <button style={styles.linkBtn} onClick={() => openEdit(src)}>Edit</button>
                            <button style={{ ...styles.linkBtn, color: '#dc2626' }} onClick={() => remove(src)}>Delete</button>
                          </>
                        )}
                      </td>
                    </tr>

                    {/* Inline edit form row */}
                    {isEditing && (
                      <tr>
                        <td colSpan={6} style={styles.expandCell}>
                          {form}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

const NetPayPanel: React.FC<{ result: NetPayResult }> = ({ result }) => (
  <div style={panelStyles.wrap}>
    {result.deductionWarning && (
      <div style={panelStyles.warning}>{result.deductionWarning}</div>
    )}
    <div style={panelStyles.row}>
      <span style={panelStyles.label}>Gross Pay</span>
      <span>{fmtCurrency(result.grossAmount)}</span>
    </div>
    {result.section125Deductions > 0 && (
      <div style={panelStyles.row}>
        <span style={panelStyles.label}>Section 125 Deductions</span>
        <span style={panelStyles.deduct}>− {fmtCurrency(result.section125Deductions)}</span>
      </div>
    )}
    {result.retirementDeductions > 0 && (
      <div style={panelStyles.row}>
        <span style={panelStyles.label}>Retirement Deductions</span>
        <span style={panelStyles.deduct}>− {fmtCurrency(result.retirementDeductions)}</span>
      </div>
    )}
    {(result.section125Deductions > 0 || result.retirementDeductions > 0) && (
      <>
        {result.section125Deductions > 0 && result.retirementDeductions > 0 && (
          <div style={panelStyles.row}>
            <span style={panelStyles.label}>FICA Taxable Wages</span>
            <span style={panelStyles.sub}>{fmtCurrency(result.ficaTaxableWages)}</span>
          </div>
        )}
        <div style={{ ...panelStyles.row, borderBottom: '1px solid #e2e8f0', paddingBottom: 4, marginBottom: 4 }}>
          <span style={panelStyles.label}>Income Taxable Wages</span>
          <span style={panelStyles.sub}>{fmtCurrency(result.incomeTaxableWages)}</span>
        </div>
      </>
    )}
    {Object.entries(result.withholdings).map(([code, amt]) => (
      <div key={code} style={panelStyles.row}>
        <span style={panelStyles.label}>{taxLabel(code)}</span>
        <span style={panelStyles.deduct}>− {fmtCurrency(amt)}</span>
      </div>
    ))}
    {result.additionalWithholding > 0 && (
      <div style={panelStyles.row}>
        <span style={panelStyles.label}>Extra Withholding (W-4 Step 4c)</span>
        <span style={panelStyles.deduct}>− {fmtCurrency(result.additionalWithholding)}</span>
      </div>
    )}
    <div style={{ ...panelStyles.row, ...panelStyles.total }}>
      <span>Estimated Net Pay</span>
      <span>{fmtCurrency(result.netPay)}</span>
    </div>
  </div>
);

const styles: Record<string, React.CSSProperties> = {
  page:            { padding: '1.5rem 1rem', maxWidth: 900, margin: '0 auto' },
  heading:         { margin: 0, fontSize: '1.25rem', fontWeight: 600 },
  grid:            { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: '0.75rem 1.25rem' },
  label:           { display: 'flex', flexDirection: 'column', gap: 4, fontSize: '0.875rem', color: '#374151' },
  hint:            { fontSize: '0.75rem', color: '#6b7280', marginTop: 1 },
  input:           { padding: '0.4rem 0.6rem', borderRadius: 6, border: '1px solid #cbd5e0', fontSize: '0.875rem', width: '100%', boxSizing: 'border-box' as const },
  calcLink:        { background: 'none', border: 'none', color: '#0d7a6b', cursor: 'pointer', fontSize: '0.75rem', padding: 0, textDecoration: 'underline' },
  select:          { width: '100%' },
  formActions:     { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '0.5rem', marginTop: '1rem' },
  formActionRight: { display: 'flex', gap: '0.5rem' },
  primaryBtn:      { background: '#0d7a6b', color: '#fff', border: 'none', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  cancelBtn:       { background: 'none', color: '#0d7a6b', border: '1px solid #0d7a6b', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  calcBtn:         { background: 'none', color: '#0d7a6b', border: '1px solid #0d7a6b', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'pointer', fontSize: '0.875rem' },
  calcBtnDisabled: { background: 'none', color: '#a0aec0', border: '1px solid #e2e8f0', borderRadius: 6, padding: '0.45rem 1rem', cursor: 'default', fontSize: '0.875rem' },
  error:           { color: '#dc2626', fontSize: '0.875rem', margin: '0.25rem 0' },
  muted:           { color: '#6b7280', fontSize: '0.875rem' },
  empty:           { color: '#6b7280', fontSize: '0.9rem' },
  table:           { width: '100%', borderCollapse: 'collapse', fontSize: '0.9rem' },
  th:              { textAlign: 'left', padding: '0.6rem 0.75rem', background: '#f7fafc', borderBottom: '2px solid #e2e8f0', fontWeight: 600, color: '#4a5568', whiteSpace: 'nowrap' },
  td:              { padding: '0.65rem 0.75rem', color: '#2d3748', borderBottom: '1px solid #e2e8f0', verticalAlign: 'middle' },
  tr:              { borderBottom: '1px solid #e2e8f0' },
  badge:           { display: 'inline-block', padding: '0.2rem 0.5rem', borderRadius: 12, fontSize: '0.75rem', fontWeight: 600 },
  linkBtn:         { background: 'none', border: 'none', color: '#0d7a6b', cursor: 'pointer', fontSize: '0.875rem', padding: '0 0.4rem' },
  expandCell:      { padding: 0, background: '#f7fafc', borderBottom: '2px solid #cbd5e0' },
  netPayInForm:    { marginTop: '1rem', padding: '0.75rem 1rem', background: '#fff', border: '1px solid #e2e8f0', borderRadius: 8 },
};

const toggleStyles = {
  track: (on: boolean): React.CSSProperties => ({
    display: 'inline-block', width: 36, height: 20, borderRadius: 10, cursor: 'pointer',
    background: on ? '#0d7a6b' : '#cbd5e0',
    position: 'relative', flexShrink: 0,
    transition: 'background 0.2s',
  }),
  thumb: (on: boolean): React.CSSProperties => ({
    position: 'absolute', top: 3, left: on ? 19 : 3,
    width: 14, height: 14, borderRadius: '50%',
    background: '#fff',
    boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
    transition: 'left 0.2s',
  }),
};

const panelStyles: Record<string, React.CSSProperties> = {
  wrap:    { maxWidth: 420, fontSize: '0.875rem' },
  row:     { display: 'flex', justifyContent: 'space-between', padding: '0.2rem 0', gap: '1rem' },
  label:   { color: '#6b7280' },
  deduct:  { color: '#dc2626' },
  add:     { color: '#059669' },
  sub:     { color: '#4a5568' },
  total:   { fontWeight: 700, fontSize: '0.95rem', borderTop: '2px solid #cbd5e0', marginTop: 4, paddingTop: 6 },
  warning: { background: '#fef9c3', border: '1px solid #fde68a', borderRadius: 6, padding: '0.4rem 0.6rem', marginBottom: '0.6rem', fontSize: '0.8rem', color: '#854d0e' },
};
