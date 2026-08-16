import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Sparkles, Users, Target, TrendingUp, CheckSquare, ArrowRight } from 'lucide-react';
import { useMeetingNotes } from '../../api/ai';
import { Modal, Button } from './index';
import { useFormat } from '../../hooks/useFormat';

interface MeetingNotesModalProps {
  open: boolean;
  onClose: () => void;
}

export function MeetingNotesModal({ open, onClose }: MeetingNotesModalProps) {
  const navigate = useNavigate();
  const { money } = useFormat();
  const [notes, setNotes] = useState('');
  const [toastMsg, setToastMsg] = useState('');
  const parseMutation = useMeetingNotes();

  function showToast(msg: string) {
    setToastMsg(msg);
    setTimeout(() => setToastMsg(''), 3500);
  }

  async function handleParse() {
    if (notes.trim().length < 10) return;
    await parseMutation.mutateAsync(notes);
  }

  function handleCreateAll() {
    if (!parseMutation.data) return;
    const d = parseMutation.data;
    const contactCount = d.contacts?.length ?? 0;
    const leadCount = d.leads?.length ?? 0;
    const dealCount = d.deals?.length ?? 0;
    const stepCount = d.nextSteps?.length ?? 0;
    const total = contactCount + leadCount + dealCount + stepCount;
    showToast(`Parsed ${total} records — go to the relevant pages to review`);
  }

  const data = parseMutation.data;

  return (
    <Modal open={open} onClose={() => { onClose(); parseMutation.reset(); setNotes(''); }} title="Parse Meeting Notes" size="lg">
      <div className="space-y-4">
        {/* Notes textarea */}
        <div>
          <label className="form-label">Paste your meeting notes</label>
          <textarea
            rows={6}
            value={notes}
            onChange={e => setNotes(e.target.value)}
            placeholder="Paste raw meeting notes here... Include names, companies, action items, deals discussed, etc."
            className="w-full border border-gray-200 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-100 dark:placeholder-gray-500 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500 resize-none"
          />
          <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{notes.length} characters{notes.length < 10 ? ' (minimum 10)' : ''}</p>
        </div>

        <div className="flex justify-center">
          <Button
            icon={<Sparkles size={15} />}
            onClick={handleParse}
            loading={parseMutation.isPending}
            disabled={notes.trim().length < 10}
          >
            Parse with AI
          </Button>
        </div>

        {/* Results */}
        {data && (
          <div className="space-y-3 border-t dark:border-gray-800 pt-4">
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-300">Parsed Results</p>

            {/* Contacts */}
            {data.contacts?.length > 0 && (
              <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                <div className="bg-violet-50 dark:bg-violet-500/10 px-4 py-2 flex items-center gap-2">
                  <Users size={14} className="text-violet-500 dark:text-violet-400" />
                  <span className="text-xs font-semibold text-violet-700 dark:text-violet-300 uppercase tracking-wider">Contacts</span>
                  <span className="ml-auto text-xs bg-violet-100 dark:bg-violet-500/20 text-violet-700 dark:text-violet-300 px-2 py-0.5 rounded-full">{data.contacts.length}</span>
                </div>
                <div className="divide-y divide-gray-50 dark:divide-gray-800">
                  {data.contacts.map((c: any, i: number) => (
                    <div key={i} className="px-4 py-2 text-sm">
                      <span className="font-medium text-gray-800 dark:text-gray-200">{c.name || c}</span>
                      {c.email && <span className="text-gray-400 dark:text-gray-500 ml-2 text-xs">{c.email}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Leads */}
            {data.leads?.length > 0 && (
              <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                <div className="bg-indigo-50 dark:bg-indigo-500/10 px-4 py-2 flex items-center gap-2">
                  <Target size={14} className="text-indigo-500 dark:text-indigo-400" />
                  <span className="text-xs font-semibold text-indigo-700 dark:text-indigo-300 uppercase tracking-wider">Leads</span>
                  <span className="ml-auto text-xs bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-300 px-2 py-0.5 rounded-full">{data.leads.length}</span>
                </div>
                <div className="divide-y divide-gray-50 dark:divide-gray-800">
                  {data.leads.map((l: any, i: number) => (
                    <div key={i} className="px-4 py-2 text-sm">
                      <span className="font-medium text-gray-800 dark:text-gray-200">{l.name || l}</span>
                      {l.source && <span className="text-gray-400 dark:text-gray-500 ml-2 text-xs">via {l.source}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Deals */}
            {data.deals?.length > 0 && (
              <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                <div className="bg-green-50 dark:bg-green-500/10 px-4 py-2 flex items-center gap-2">
                  <TrendingUp size={14} className="text-green-500 dark:text-green-400" />
                  <span className="text-xs font-semibold text-green-700 dark:text-green-300 uppercase tracking-wider">Deals</span>
                  <span className="ml-auto text-xs bg-green-100 dark:bg-green-500/20 text-green-700 dark:text-green-300 px-2 py-0.5 rounded-full">{data.deals.length}</span>
                </div>
                <div className="divide-y divide-gray-50 dark:divide-gray-800">
                  {data.deals.map((d: any, i: number) => (
                    <div key={i} className="px-4 py-2 text-sm">
                      <span className="font-medium text-gray-800 dark:text-gray-200">{d.title || d}</span>
                      {d.value && <span className="text-green-600 dark:text-green-400 ml-2 text-xs font-semibold">{money(Number(d.value))}</span>}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Next Steps */}
            {data.nextSteps?.length > 0 && (
              <div className="border border-gray-200 dark:border-gray-700 rounded-xl overflow-hidden">
                <div className="bg-amber-50 dark:bg-amber-500/10 px-4 py-2 flex items-center gap-2">
                  <CheckSquare size={14} className="text-amber-500 dark:text-amber-400" />
                  <span className="text-xs font-semibold text-amber-700 dark:text-amber-300 uppercase tracking-wider">Next Steps</span>
                  <span className="ml-auto text-xs bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-300 px-2 py-0.5 rounded-full">{data.nextSteps.length}</span>
                </div>
                <div className="divide-y divide-gray-50 dark:divide-gray-800">
                  {data.nextSteps.map((s: any, i: number) => (
                    <div key={i} className="px-4 py-2 text-sm text-gray-700 dark:text-gray-300">{typeof s === 'string' ? s : s.text || JSON.stringify(s)}</div>
                  ))}
                </div>
              </div>
            )}

            <div className="flex items-center justify-between pt-2">
              <button
                onClick={() => navigate('/crm/contacts')}
                className="flex items-center gap-1 text-xs text-brand-600 hover:underline"
              >
                Go to Contacts <ArrowRight size={12} />
              </button>
              <Button icon={<CheckSquare size={14} />} onClick={handleCreateAll}>
                Create All
              </Button>
            </div>
          </div>
        )}

        {/* Toast */}
        {toastMsg && (
          <div className="fixed bottom-6 right-6 bg-gray-900 text-white text-sm px-4 py-3 rounded-xl shadow-lg z-50 animate-fade-in">
            {toastMsg}
          </div>
        )}
      </div>
    </Modal>
  );
}
