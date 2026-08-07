import { useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../api/client';
import { useAuth } from '../../contexts/AuthContext';
import { Paperclip, Download, Trash2, Upload, FileText, Image, FileArchive, File as FileIcon } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';

export type AttachmentEntityType =
  | 'DEAL' | 'TICKET' | 'CONTACT' | 'LEAD' | 'ACCOUNT'
  | 'CHANGE_REQUEST' | 'QUOTE' | 'ASSET' | 'CAMPAIGN';

interface AttachmentsProps {
  entityType: AttachmentEntityType;
  entityId: string;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function iconFor(mimeType: string) {
  if (mimeType.startsWith('image/')) return Image;
  if (mimeType.includes('zip') || mimeType.includes('compressed')) return FileArchive;
  if (mimeType.includes('pdf') || mimeType.includes('text') || mimeType.includes('document')) return FileText;
  return FileIcon;
}

export function Attachments({ entityType, entityId }: AttachmentsProps) {
  const { user } = useAuth();
  const qc = useQueryClient();
  const key = ['attachments', entityType, entityId];
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [error, setError] = useState('');

  const { data: attachments = [], isLoading } = useQuery({
    queryKey: key,
    queryFn: () => api.get(`/attachments/${entityType}/${entityId}`).then(r => r.data),
    enabled: !!entityId,
  });

  const upload = useMutation({
    mutationFn: (file: File) => {
      const formData = new FormData();
      formData.append('file', file);
      return api.post(`/attachments/${entityType}/${entityId}`, formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      }).then(r => r.data);
    },
    onSuccess: () => { qc.invalidateQueries({ queryKey: key }); setError(''); },
    onError: (err: any) => setError(err?.response?.data?.error || 'Upload failed'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.delete(`/attachments/${id}`).then(r => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
  });

  async function download(a: any) {
    const res = await api.get(`/attachments/${a.id}/download`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    const link = document.createElement('a');
    link.href = url;
    link.download = a.fileName;
    link.click();
    URL.revokeObjectURL(url);
  }

  function handleFiles(files: FileList | null) {
    if (!files || files.length === 0) return;
    Array.from(files).forEach(f => upload.mutate(f));
  }

  return (
    <div className="border-t dark:border-gray-800 pt-4 mt-4">
      <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3 flex items-center gap-1.5">
        <Paperclip size={14} /> Attachments ({attachments.length})
      </h3>

      {error && <div className="mb-2 text-xs text-red-600 dark:text-red-400 bg-red-50 dark:bg-red-500/10 border border-red-200 dark:border-red-500/30 rounded-lg px-2 py-1.5">{error}</div>}

      <div className="space-y-2 mb-3 max-h-64 overflow-y-auto">
        {isLoading ? (
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-3">Loading…</p>
        ) : attachments.length === 0 ? (
          <p className="text-xs text-gray-400 dark:text-gray-500 text-center py-3">No files attached yet.</p>
        ) : (
          attachments.map((a: any) => {
            const Icon = iconFor(a.mimeType);
            const canDelete = a.uploader?.id === user?.id || user?.role === 'SUPER_ADMIN';
            return (
              <div key={a.id} className="flex items-center gap-2 group bg-gray-50 dark:bg-gray-800 rounded-xl px-3 py-2">
                <Icon size={16} className="text-gray-400 dark:text-gray-500 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-700 dark:text-gray-300 truncate">{a.fileName}</p>
                  <p className="text-xs text-gray-400 dark:text-gray-500">
                    {formatSize(a.fileSize)} · {a.uploader?.name} · {formatDistanceToNow(new Date(a.createdAt), { addSuffix: true })}
                  </p>
                </div>
                <button onClick={() => download(a)} className="p-1 text-gray-400 dark:text-gray-500 hover:text-brand-600 dark:hover:text-brand-400 transition-colors flex-shrink-0" title="Download">
                  <Download size={14} />
                </button>
                {canDelete && (
                  <button onClick={() => remove.mutate(a.id)} className="p-1 opacity-0 group-hover:opacity-100 text-gray-300 dark:text-gray-600 hover:text-red-500 dark:hover:text-red-400 transition-all flex-shrink-0" title="Delete">
                    <Trash2 size={14} />
                  </button>
                )}
              </div>
            );
          })
        )}
      </div>

      <div
        onDragOver={e => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={e => { e.preventDefault(); setDragOver(false); handleFiles(e.dataTransfer.files); }}
        onClick={() => fileInputRef.current?.click()}
        className={`flex items-center justify-center gap-2 border-2 border-dashed rounded-xl py-3 cursor-pointer transition-colors ${
          dragOver ? 'border-brand-500 bg-brand-50 dark:bg-brand-500/10' : 'border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600'
        }`}
      >
        <Upload size={14} className="text-gray-400 dark:text-gray-500" />
        <span className="text-xs text-gray-500 dark:text-gray-400">{upload.isPending ? 'Uploading…' : 'Click or drag a file to attach (max 25MB)'}</span>
        <input
          ref={fileInputRef}
          type="file"
          className="hidden"
          onChange={e => { handleFiles(e.target.files); e.target.value = ''; }}
        />
      </div>
    </div>
  );
}
