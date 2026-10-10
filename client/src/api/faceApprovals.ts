import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from './client';

/**
 * Face ID re-enrolment approvals (Super Admin).
 *
 * Replacing an enrolled face is reviewed rather than self-service — see
 * FaceReenrollmentRequest in the Prisma schema for why the proposed face is
 * parked instead of applied. These hooks drive the review queue; the
 * employee's own side of the flow rides along on the attendance policy
 * payload, which the Face ID card already fetches.
 */

export type FaceRequestStatus = 'PENDING' | 'APPROVED' | 'REJECTED';

export interface FaceRequestUser {
  id: string;
  name: string;
  email: string;
  role: string;
  avatarUrl?: string | null;
}

export interface FaceRequest {
  id: string;
  userId: string;
  status: FaceRequestStatus;
  samples: number;
  rejectionReason: string | null;
  createdAt: string;
  decidedAt: string | null;
  user: FaceRequestUser;
  decider: { id: string; name: string } | null;
}

/** The detail view additionally carries the images the decision rests on. */
export interface FaceRequestDetail extends FaceRequest {
  sampleImages: string[];
  previousSelfie: string | null;
  user: FaceRequestUser & {
    faceEnrollment: { referenceSelfie: string | null; samples: number; enrolledAt: string } | null;
    employee: { employeeCode: string; designation: string | null; department: { name: string } | null } | null;
  };
}

const KEY = ['face-requests'];

export const useFaceRequests = (status: FaceRequestStatus | 'ALL' = 'PENDING', enabled = true) =>
  useQuery<{ data: FaceRequest[]; pendingCount: number }>({
    queryKey: [...KEY, status],
    queryFn: () => api.get('/hr/attendance/face/requests', { params: { status } }).then(r => r.data),
    enabled,
  });

export const useFaceRequest = (id: string | null) =>
  useQuery<FaceRequestDetail>({
    queryKey: [...KEY, 'detail', id],
    queryFn: () => api.get(`/hr/attendance/face/requests/${id}`).then(r => r.data),
    enabled: !!id,
  });

export function useDecideFaceRequest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, decision, reason }: { id: string; decision: 'approve' | 'reject'; reason?: string }) =>
      api.post(`/hr/attendance/face/requests/${id}/${decision}`, { reason }).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: KEY });
      /* An approval swaps the live enrolment, which the reviewer may also be
         looking at on their own Attendance page. */
      qc.invalidateQueries({ queryKey: ['attendance-policy'] });
    },
  });
}
