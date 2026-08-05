import { useState, useRef } from 'react';
import { useMutation } from '@tanstack/react-query';
import { api } from '../api/client';
import { Upload, FileText, CheckCircle, AlertCircle } from 'lucide-react';

interface ImportResult { message: string; created: number; updated?: number; errors: number; total: number; }
interface PreviewResult { rows: Record<string, string>[]; total: number; }

const ENTITY_TYPES = [
  { value: 'contacts', label: 'Contacts', columns: 'name, email, phone, company' },
  { value: 'leads', label: 'Leads', columns: 'name, email, source, phone, company' },
];

export default function BulkImportPage() {
  const [entityType, setEntityType] = useState('contacts');
  const [csvText, setCsvText] = useState('');
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const previewMutation = useMutation({
    mutationFn: () => api.post(`/import/${entityType}`, { csv: csvText, preview: true }).then(r => r.data),
    onSuccess: (data) => setPreview(data),
  });

  const importMutation = useMutation({
    mutationFn: () => api.post(`/import/${entityType}`, { csv: csvText, preview: false }).then(r => r.data),
    onSuccess: (data) => { setResult(data); setPreview(null); },
  });

  function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = ev => { setCsvText(ev.target?.result as string); setPreview(null); setResult(null); };
    reader.readAsText(file);
  }

  const entity = ENTITY_TYPES.find(e => e.value === entityType)!;

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <Upload size={24} className="text-brand-600" />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Bulk CSV Import</h1>
          <p className="text-sm text-gray-500">Import contacts or leads from a CSV file</p>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Controls */}
        <div className="lg:col-span-1 space-y-4">
          {/* Entity selector */}
          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <label className="block text-sm font-medium text-gray-700 mb-2">Import as</label>
            <div className="space-y-2">
              {ENTITY_TYPES.map(e => (
                <label key={e.value} className="flex items-center gap-2 text-sm cursor-pointer">
                  <input type="radio" name="entityType" value={e.value} checked={entityType === e.value}
                    onChange={() => { setEntityType(e.value); setPreview(null); setResult(null); }} className="accent-brand-600" />
                  <span className="font-medium">{e.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Column reference */}
          <div className="bg-blue-50 border border-blue-100 rounded-xl p-4">
            <p className="text-sm font-semibold text-blue-800 mb-1">Expected columns</p>
            <p className="text-xs text-blue-600 font-mono">{entity.columns}</p>
            <p className="text-xs text-blue-500 mt-2">First row must be headers. Email is used for deduplication.</p>
          </div>

          {/* File upload */}
          <button
            onClick={() => fileRef.current?.click()}
            className="w-full flex items-center gap-2 justify-center px-4 py-3 border-2 border-dashed border-gray-300 rounded-xl text-sm text-gray-500 hover:border-brand-400 hover:text-brand-600 transition-colors"
          >
            <FileText size={16} /> Choose CSV file
          </button>
          <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={handleFile} />
        </div>

        {/* Main area */}
        <div className="lg:col-span-2 space-y-4">
          {/* CSV text area */}
          <div className="bg-white rounded-xl border border-gray-200">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <span className="text-sm font-medium text-gray-700">CSV Content</span>
              {csvText && <span className="text-xs text-gray-400">{csvText.split('\n').length - 1} rows</span>}
            </div>
            <textarea
              className="w-full h-48 px-4 py-3 text-xs font-mono text-gray-700 resize-none focus:outline-none rounded-b-xl"
              placeholder={`name,email,phone,company\nJohn Doe,john@example.com,555-1234,Acme Corp`}
              value={csvText}
              onChange={e => { setCsvText(e.target.value); setPreview(null); setResult(null); }}
            />
          </div>

          {/* Action buttons */}
          <div className="flex gap-3">
            <button
              disabled={!csvText || previewMutation.isPending}
              onClick={() => previewMutation.mutate()}
              className="flex-1 border border-brand-600 text-brand-600 rounded-lg py-2 text-sm font-medium hover:bg-brand-50 disabled:opacity-50"
            >
              {previewMutation.isPending ? 'Parsing…' : 'Preview (5 rows)'}
            </button>
            <button
              disabled={!csvText || importMutation.isPending}
              onClick={() => importMutation.mutate()}
              className="flex-1 bg-brand-600 text-white rounded-lg py-2 text-sm font-medium hover:bg-brand-700 disabled:opacity-50"
            >
              {importMutation.isPending ? 'Importing…' : 'Import All'}
            </button>
          </div>

          {/* Preview table */}
          {preview && (
            <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
              <div className="px-4 py-2 border-b border-gray-100 text-sm text-gray-600 font-medium">
                Preview — showing 5 of {preview.total} rows
              </div>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-gray-50">
                    <tr>
                      {Object.keys(preview.rows[0] ?? {}).map(col => (
                        <th key={col} className="px-3 py-2 text-left font-semibold text-gray-500 uppercase">{col}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {preview.rows.map((row, i) => (
                      <tr key={i}>
                        {Object.values(row).map((v, j) => (
                          <td key={j} className="px-3 py-2 text-gray-700 max-w-xs truncate">{v}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Result */}
          {result && (
            <div className={`p-4 rounded-xl border ${result.errors === 0 ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'}`}>
              <div className="flex items-center gap-2 mb-2">
                {result.errors === 0 ? <CheckCircle size={18} className="text-green-600" /> : <AlertCircle size={18} className="text-yellow-600" />}
                <span className="font-semibold text-gray-800">Import complete</span>
              </div>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-center">
                {[
                  { label: 'Total', value: result.total, color: 'text-gray-700' },
                  { label: 'Created', value: result.created, color: 'text-green-600' },
                  { label: 'Updated', value: result.updated ?? 0, color: 'text-blue-600' },
                  { label: 'Errors', value: result.errors, color: 'text-red-600' },
                ].map(s => (
                  <div key={s.label} className="bg-white rounded-lg p-2">
                    <div className={`text-xl font-bold ${s.color}`}>{s.value}</div>
                    <div className="text-xs text-gray-500">{s.label}</div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
