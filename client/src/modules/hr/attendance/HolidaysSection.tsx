import { useState } from 'react';
import { CalendarDays, Plus, Trash2, Pencil, ClipboardList } from 'lucide-react';
import { Card, CardHeader, Button, Modal, Badge, Field, Input, Textarea, Checkbox, Alert, SkeletonTable, IconButton, EmptyState } from '../../../shared/components';
import { useLocations } from '../../../api/people';
import { useHolidays, useSaveHoliday, useDeleteHoliday, useBulkHolidays, type Holiday } from '../../../api/attendanceAdmin';

/**
 * Parses pasted holiday lines: "YYYY-MM-DD, Name[, optional]" — also accepts
 * tab-separated (pasted from a spreadsheet) and DD/MM/YYYY or DD-MM-YYYY dates.
 * Returns rows plus the line numbers that couldn't be read.
 */
function parseHolidayLines(text: string): { rows: { date: string; name: string; isOptional: boolean }[]; bad: number[] } {
  const rows: { date: string; name: string; isOptional: boolean }[] = [];
  const bad: number[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || /^date\b/i.test(line)) return; // blank or a header row
    const parts = line.split(/\t|,/).map(p => p.trim().replace(/^"|"$/g, ''));
    let [d, name, flag] = parts;
    const dmy = d?.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    if (dmy) d = `${dmy[3]}-${dmy[2].padStart(2, '0')}-${dmy[1].padStart(2, '0')}`;
    if (!d || !/^\d{4}-\d{2}-\d{2}$/.test(d) || Number.isNaN(Date.parse(d)) || !name) { bad.push(i + 1); return; }
    rows.push({ date: d, name: name.slice(0, 80), isOptional: /^(optional|restricted|yes|y|true|1)$/i.test(flag ?? '') });
  });
  return { rows, bad };
}
import { useFormat } from '../../../hooks/useFormat';

export function HolidaysSection() {
  const { date } = useFormat();
  const [year, setYear] = useState(new Date().getFullYear());
  const { data, isLoading } = useHolidays(year);
  const save = useSaveHoliday();
  const remove = useDeleteHoliday();
  const { data: locations } = useLocations();
  const [open, setOpen] = useState(false);
  const [editing, setEditing] = useState<Holiday | null>(null);
  const [form, setForm] = useState({ date: '', name: '', locationIds: [] as string[], isOptional: false });
  const [error, setError] = useState('');
  const bulk = useBulkHolidays();
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkText, setBulkText] = useState('');
  const [bulkMsg, setBulkMsg] = useState<{ tone: 'danger' | 'success'; text: string } | null>(null);
  const parsed = parseHolidayLines(bulkText);
  const submitBulk = () => {
    setBulkMsg(null);
    if (parsed.bad.length) return setBulkMsg({ tone: 'danger', text: `Couldn't read line${parsed.bad.length === 1 ? '' : 's'} ${parsed.bad.join(', ')} — use "YYYY-MM-DD, Name[, optional]".` });
    if (!parsed.rows.length) return setBulkMsg({ tone: 'danger', text: 'Paste at least one holiday.' });
    if (parsed.rows.length > 100) return setBulkMsg({ tone: 'danger', text: 'At most 100 holidays per import.' });
    bulk.mutate(parsed.rows, {
      onSuccess: r => { setBulkMsg({ tone: 'success', text: `Added ${r.count} holiday${r.count === 1 ? '' : 's'}${r.skipped ? ` (${r.skipped} already existed)` : ''}.` }); setBulkText(''); },
      onError: (e: any) => setBulkMsg({ tone: 'danger', text: e?.response?.data?.error || 'Could not import' }),
    });
  };
  const openCreate = () => { setEditing(null); setForm({ date: `${year}-01-01`, name: '', locationIds: [], isOptional: false }); setError(''); setOpen(true); };
  const openEdit = (h: Holiday) => { setEditing(h); setForm({ date: h.date.slice(0, 10), name: h.name, locationIds: h.locationIds, isOptional: h.isOptional }); setError(''); setOpen(true); };
  const submit = () => save.mutate({ id: editing?.id, ...form } as any, { onSuccess: () => setOpen(false), onError: (e: any) => setError(e?.response?.data?.error || 'Could not save') });
  const locName = (id: string) => locations?.data?.find(l => l.id === id)?.name ?? id;

  return (
    <Card>
      <CardHeader title="Holidays" subtitle="Paid holidays for the year; scope a holiday to specific branches or leave it for everyone." icon={<CalendarDays size={14} />} className="mb-3"
        actions={<div className="flex flex-wrap items-center gap-2"><Input type="number" className="w-24" value={year} onChange={e => setYear(Number(e.target.value) || year)} /><Button size="sm" variant="secondary" icon={<ClipboardList size={13} />} onClick={() => { setBulkMsg(null); setBulkOpen(true); }}>Import list</Button><Button size="sm" icon={<Plus size={13} />} onClick={openCreate}>Add holiday</Button></div>} />
      {isLoading ? <SkeletonTable rows={3} /> : !data?.length ? <EmptyState compact icon={<CalendarDays />} title={`No holidays for ${year}`} action={{ label: 'Add holiday', onClick: openCreate }} /> : (
        <ul className="divide-y divide-line-subtle">
          {data.map(h => (
            <li key={h.id} className="flex items-center justify-between gap-3 py-2">
              <div className="min-w-0"><p className="text-sm text-fg">{h.name} {h.isOptional && <Badge variant="gray">optional</Badge>}</p><p className="text-xs text-fg-subtle tabular-nums">{date(h.date)}{h.locationIds.length ? ` · ${h.locationIds.map(locName).join(', ')}` : ' · all locations'}</p></div>
              <span className="inline-flex gap-1"><IconButton label="Edit" icon={<Pencil size={13} />} onClick={() => openEdit(h)} /><IconButton label="Delete" tone="danger" icon={<Trash2 size={13} />} onClick={() => remove.mutate(h.id)} /></span>
            </li>
          ))}
        </ul>
      )}
      <Modal open={open} onClose={() => setOpen(false)} title={editing ? 'Edit holiday' : 'Add holiday'} icon={<CalendarDays size={16} />} size="sm"
        footer={<><Button variant="secondary" onClick={() => setOpen(false)}>Cancel</Button><Button loading={save.isPending} onClick={submit}>Save</Button></>}>
        <div className="space-y-3">
          {error && <Alert tone="danger">{error}</Alert>}
          <Field label="Date"><Input type="date" value={form.date} onChange={e => setForm(f => ({ ...f, date: e.target.value }))} /></Field>
          <Field label="Name"><Input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Diwali" /></Field>
          {!!locations?.data?.length && <Field label="Only these locations (none = all)"><div className="flex flex-wrap gap-1.5">{locations.data.map(l => <Button key={l.id} size="xs" variant={form.locationIds.includes(l.id) ? 'primary' : 'secondary'} onClick={() => setForm(f => ({ ...f, locationIds: f.locationIds.includes(l.id) ? f.locationIds.filter(x => x !== l.id) : [...f.locationIds, l.id] }))}>{l.name}</Button>)}</div></Field>}
          <Checkbox label="Optional / restricted holiday (a working day unless the employee opts in from their Attendance page)" checked={form.isOptional} onChange={e => setForm(f => ({ ...f, isOptional: e.target.checked }))} />
        </div>
      </Modal>
      <Modal open={bulkOpen} onClose={() => setBulkOpen(false)} title="Import holidays" icon={<ClipboardList size={16} />} size="md"
        footer={<><Button variant="secondary" onClick={() => setBulkOpen(false)}>Close</Button><Button loading={bulk.isPending} onClick={submitBulk}>Import {parsed.rows.length || ''}</Button></>}>
        <div className="space-y-3">
          {bulkMsg && <Alert tone={bulkMsg.tone}>{bulkMsg.text}</Alert>}
          <p className="text-[12px] text-fg-muted">One holiday per line: <code>YYYY-MM-DD, Name</code>, optionally followed by <code>, optional</code> for a restricted holiday. You can paste two or three columns straight from a spreadsheet. Holidays apply to all locations; edit one afterwards to scope it. Existing holidays with the same date and name are skipped.</p>
          <Field label="Holidays"><Textarea rows={10} value={bulkText} onChange={e => setBulkText(e.target.value)} placeholder={`${year}-01-26, Republic Day\n${year}-08-15, Independence Day\n${year}-10-02, Gandhi Jayanti\n${year}-11-08, Diwali\n${year}-03-14, Holi, optional`} /></Field>
          {bulkText.trim() && <p className="text-[11.5px] text-fg-subtle">{parsed.rows.length} ready{parsed.bad.length ? ` · ${parsed.bad.length} line(s) not understood: ${parsed.bad.join(', ')}` : ''}</p>}
        </div>
      </Modal>
    </Card>
  );
}
