import { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../api/client';
import { Building2, CheckCircle, XCircle, AlertCircle, Loader2 } from 'lucide-react';

type Status = 'validating' | 'ready' | 'invalid' | 'approved' | 'rejected' | 'already-decided';

interface RequestInfo {
  organizationName: string;
  name: string;
  email: string;
  status: string;
  createdAt: string;
}

/**
 * Public, token-secured page opened from the "New Organization Signup
 * Request" email — lets the reviewer see who's asking before deciding.
 * Nothing here requires being logged into the app; the random token in the
 * URL is what gates it, same as /accept-invite.
 */
export function OrgApprovalPage() {
  const [params] = useSearchParams();
  const token = params.get('token') || '';
  const navigate = useNavigate();

  const [status, setStatus] = useState<Status>('validating');
  const [info, setInfo] = useState<RequestInfo | null>(null);
  const [error, setError] = useState('');
  const [deciding, setDeciding] = useState(false);

  useEffect(() => {
    if (!token) { setStatus('invalid'); return; }
    api.get(`/auth/org-signup-info?token=${token}`)
      .then(r => {
        setInfo(r.data);
        if (r.data.status !== 'PENDING') setStatus('already-decided');
        else setStatus('ready');
      })
      .catch(() => setStatus('invalid'));
  }, [token]);

  async function decide(action: 'approve' | 'reject') {
    setDeciding(true);
    setError('');
    try {
      await api.post('/auth/approve-org-signup', { token, action });
      setStatus(action === 'approve' ? 'approved' : 'rejected');
    } catch (err: any) {
      setError(err?.response?.data?.message || err?.response?.data?.error || 'Something went wrong.');
    } finally {
      setDeciding(false);
    }
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-brand-50 to-blue-100 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-8">
        <div className="flex items-center justify-center gap-2 mb-6">
          <Building2 className="text-brand-600" size={28} />
          <h1 className="text-2xl font-bold text-gray-900">CRM & IT Desk</h1>
        </div>

        {status === 'validating' && (
          <div className="flex flex-col items-center gap-3 py-8 text-gray-500">
            <Loader2 size={28} className="animate-spin text-brand-500" />
            <p className="text-sm">Loading request...</p>
          </div>
        )}

        {status === 'invalid' && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <AlertCircle size={36} className="text-red-400" />
            <h2 className="font-semibold text-gray-900">Request not found</h2>
            <p className="text-sm text-gray-500">This link is invalid.</p>
          </div>
        )}

        {status === 'already-decided' && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <AlertCircle size={36} className="text-amber-400" />
            <h2 className="font-semibold text-gray-900">Already {info?.status.toLowerCase()}</h2>
            <p className="text-sm text-gray-500">This request was already decided — no action needed.</p>
          </div>
        )}

        {status === 'approved' && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <CheckCircle size={36} className="text-green-500" />
            <h2 className="font-semibold text-gray-900">Approved</h2>
            <p className="text-sm text-gray-500">
              <span className="font-medium text-gray-700">{info?.organizationName}</span> has been created.
              {info?.email && ` ${info.email} has been notified and can now log in.`}
            </p>
            <button
              onClick={() => navigate('/login')}
              className="mt-2 text-sm text-brand-600 hover:underline font-medium"
            >
              Go to sign in
            </button>
          </div>
        )}

        {status === 'rejected' && (
          <div className="flex flex-col items-center gap-3 py-8 text-center">
            <XCircle size={36} className="text-gray-400" />
            <h2 className="font-semibold text-gray-900">Request rejected</h2>
            <p className="text-sm text-gray-500">No org or user was created.</p>
          </div>
        )}

        {status === 'ready' && info && (
          <>
            <div className="mb-6 text-center">
              <h2 className="text-lg font-semibold text-gray-900">New signup request</h2>
              <p className="text-sm text-gray-500 mt-1">Review before anything is created</p>
            </div>

            <div className="space-y-2 bg-gray-50 rounded-xl p-4 mb-6 text-sm">
              <div className="flex justify-between">
                <span className="text-gray-500">Organization</span>
                <span className="font-medium text-gray-900">{info.organizationName}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Requested by</span>
                <span className="font-medium text-gray-900">{info.name}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Email</span>
                <span className="font-medium text-gray-900">{info.email}</span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-500">Submitted</span>
                <span className="font-medium text-gray-900">{new Date(info.createdAt).toLocaleString()}</span>
              </div>
            </div>

            {error && (
              <div className="bg-red-50 border border-red-200 text-red-700 text-sm px-4 py-3 rounded-lg mb-4">{error}</div>
            )}

            <div className="flex gap-3">
              <button
                onClick={() => decide('reject')}
                disabled={deciding}
                className="flex-1 border border-gray-200 hover:bg-gray-50 disabled:opacity-60 text-gray-700 font-medium py-2.5 rounded-lg text-sm transition-colors"
              >
                Reject
              </button>
              <button
                onClick={() => decide('approve')}
                disabled={deciding}
                className="flex-1 bg-brand-600 hover:bg-brand-700 disabled:opacity-60 text-white font-medium py-2.5 rounded-lg text-sm transition-colors"
              >
                {deciding ? 'Approving...' : 'Approve'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
