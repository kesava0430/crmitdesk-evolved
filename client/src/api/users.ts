import { useQuery } from '@tanstack/react-query';
import { api } from './client';
export const useUsers = () =>
  useQuery({ queryKey: ['users'], queryFn: () => api.get('/users').then(r => r.data) });
