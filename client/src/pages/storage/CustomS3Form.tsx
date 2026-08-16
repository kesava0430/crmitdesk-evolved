import { useEffect, useMemo, useState } from 'react';
import { CheckCircle, AlertCircle, Loader2, Database } from 'lucide-react';
import { Button, Input, Select, Field, FormError } from '../../shared/components';
import {
  useS3Presets, useTestCustomS3, useConnectCustomS3,
  type CustomS3Input, type S3Preset,
} from '../../api/storage';

/**
 * Connect a bucket the customer owns.
 *
 * "S3-compatible" is one protocol with many vendors behind it — AWS S3,
 * Cloudflare R2, Wasabi, Backblaze B2, DigitalOcean Spaces, MinIO — so this
 * one form covers all of them. What differs between them is only the endpoint
 * URL and whether the region matters, which is what the preset list encodes.
 * Picking "Cloudflare R2" and typing an account ID should not require knowing
 * that the endpoint is `https://<id>.r2.cloudflarestorage.com`.
 *
 * The connection is round-tripped (write, read, delete) before anything is
 * saved. A bucket that accepts writes but refuses deletes looks perfect at
 * connect time and fails weeks later, by which point nobody links the two.
 */

interface Props {
  /** True when this org already stores files somewhere — changes the copy. */
  switching: boolean;
  onConnected: (message: string) => void;
}

const EMPTY: CustomS3Input = {
  label: '', bucket: '', region: '', endpoint: '',
  accessKeyId: '', secretAccessKey: '', prefix: '',
};

export function CustomS3Form({ switching, onConnected }: Props) {
  const { data: presetData } = useS3Presets();
  const presets = presetData?.presets ?? [];

  const [presetId, setPresetId] = useState('AWS_S3');
  const [accountId, setAccountId] = useState('');   // R2 only
  const [form, setForm] = useState<CustomS3Input>(EMPTY);
  const [manualEndpoint, setManualEndpoint] = useState(false);
  const [error, setError] = useState('');

  const test = useTestCustomS3();
  const connect = useConnectCustomS3();

  const preset: S3Preset | undefined = useMemo(
    () => presets.find(p => p.id === presetId),
    [presets, presetId],
  );

  // Region defaults follow the preset, but only until the user types their
  // own — overwriting a region someone deliberately entered because they
  // changed vendor in the dropdown would be worse than a stale default.
  const [regionTouched, setRegionTouched] = useState(false);
  useEffect(() => {
    if (preset && !regionTouched) setForm(f => ({ ...f, region: preset.defaultRegion }));
  }, [preset, regionTouched]);

  /** The endpoint we will actually send — derived unless the user overrode it. */
  const endpoint = useMemo(() => {
    if (manualEndpoint || !preset?.endpointTemplate) return form.endpoint ?? '';
    return preset.endpointTemplate
      .replace('{accountId}', accountId.trim())
      .replace('{region}', (form.region || preset.defaultRegion).trim());
  }, [manualEndpoint, preset, accountId, form.endpoint, form.region]);

  const needsAccountId = !manualEndpoint && preset?.endpointTemplate?.includes('{accountId}');
  const needsManualEndpoint = manualEndpoint || (preset && !preset.endpointTemplate && preset.id !== 'AWS_S3');

  const payload: CustomS3Input = {
    ...form,
    label: form.label || preset?.label,
    endpoint: endpoint || undefined,
    region: form.region || preset?.defaultRegion,
    forcePathStyle: preset?.forcePathStyle,
  };

  const complete = !!(payload.bucket && payload.accessKeyId && payload.secretAccessKey
    && (!needsAccountId || accountId.trim())
    && (!needsManualEndpoint || endpoint));

  function set<K extends keyof CustomS3Input>(key: K) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      if (key === 'region') setRegionTouched(true);
      setForm(f => ({ ...f, [key]: e.target.value }));
    };
  }

  // Any edit invalidates a previous green tick — otherwise someone tests, then
  // changes the bucket, and connects on the strength of a stale pass.
  useEffect(() => { test.reset(); }, [form, accountId, presetId, manualEndpoint]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    try {
      const res = await connect.mutateAsync(payload);
      onConnected(res.message ?? 'Storage connected.');
      setForm(EMPTY);
      setAccountId('');
    } catch (err: any) {
      setError(err?.response?.data?.error || 'Could not connect that bucket.');
    }
  }

  const result = test.data;

  return (
    <form onSubmit={submit} className="space-y-3">
      <p className="text-xs text-fg-muted">
        Your bucket, your region, your retention rules — and your bill. We store only the
        access keys, encrypted. {switching && 'Files already uploaded elsewhere stay where they are.'}
      </p>

      <Field label="Service">
        <Select
          value={presetId}
          onChange={e => { setPresetId(e.target.value); setManualEndpoint(false); setRegionTouched(false); }}
          options={presets.map(p => ({ value: p.id, label: p.label }))}
        />
      </Field>
      {preset?.help && <p className="text-[11px] text-fg-subtle -mt-1">{preset.help}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Bucket name">
          <Input value={form.bucket} onChange={set('bucket')} placeholder="acme-crm-attachments" autoComplete="off" />
        </Field>
        <Field label={preset?.regionRequired ? 'Region' : 'Region (optional)'}>
          <Input value={form.region} onChange={set('region')} placeholder={preset?.defaultRegion} autoComplete="off" />
        </Field>
      </div>

      {needsAccountId && (
        <Field label="Cloudflare account ID">
          <Input value={accountId} onChange={e => setAccountId(e.target.value)} placeholder="a1b2c3d4e5f6…" autoComplete="off" />
        </Field>
      )}

      {needsManualEndpoint && (
        <Field label="Endpoint URL">
          <Input
            value={form.endpoint}
            onChange={set('endpoint')}
            placeholder="https://s3.example.com:9000"
            autoComplete="off"
          />
        </Field>
      )}

      {!needsManualEndpoint && endpoint && (
        <p className="text-[11px] text-fg-subtle">
          Endpoint: <code className="text-fg-muted">{endpoint}</code>
          {' · '}
          <button type="button" className="underline hover:text-fg" onClick={() => { setManualEndpoint(true); setForm(f => ({ ...f, endpoint })); }}>
            enter manually
          </button>
        </p>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <Field label="Access key ID">
          <Input value={form.accessKeyId} onChange={set('accessKeyId')} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Secret access key">
          <Input type="password" value={form.secretAccessKey} onChange={set('secretAccessKey')} autoComplete="new-password" />
        </Field>
      </div>

      <Field label="Folder prefix (optional)" hint="Store everything under a folder inside the bucket, e.g. crm/">
        <Input value={form.prefix} onChange={set('prefix')} placeholder="crm/" autoComplete="off" />
      </Field>

      <details className="text-[11px] text-fg-subtle">
        <summary className="cursor-pointer hover:text-fg-muted">Permissions this key needs</summary>
        <p className="mt-1.5 leading-relaxed">
          <code>s3:PutObject</code>, <code>s3:GetObject</code> and <code>s3:DeleteObject</code> on
          this bucket. Nothing else — no listing, no bucket administration. Delete is required so
          removing an attachment in CRMITdesk actually removes the file rather than leaving it to
          accrue storage cost.
        </p>
      </details>

      <FormError>{error}</FormError>

      {result && (
        <div className={`flex items-start gap-2 p-2.5 rounded-lg border text-xs ${
          result.ok
            ? 'bg-green-50 dark:bg-green-500/10 border-green-200 dark:border-green-500/30 text-green-700 dark:text-green-400'
            : 'bg-red-50 dark:bg-red-500/10 border-red-200 dark:border-red-500/30 text-red-700 dark:text-red-400'
        }`}>
          {result.ok
            ? <CheckCircle size={14} className="flex-shrink-0 mt-0.5" />
            : <AlertCircle size={14} className="flex-shrink-0 mt-0.5" />}
          <span>
            {result.ok
              ? 'Wrote, read back and deleted a test file successfully.'
              : <>Failed on <strong>{result.step}</strong>. {result.error}</>}
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 pt-1">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={!complete || test.isPending}
          icon={test.isPending ? <Loader2 size={13} className="animate-spin" /> : <Database size={13} />}
          onClick={() => test.mutate(payload)}
        >
          {test.isPending ? 'Testing…' : 'Test connection'}
        </Button>
        <Button type="submit" size="sm" disabled={!complete} loading={connect.isPending}>
          {switching ? 'Switch to this bucket' : 'Connect bucket'}
        </Button>
        <span className="text-[11px] text-fg-subtle">
          Connecting tests the bucket first — it is never saved untested.
        </span>
      </div>
    </form>
  );
}
