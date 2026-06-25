import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import * as api from '../api'

export function useSessionsQuery() {
  return useQuery({
    queryKey: ['sessions'],
    queryFn: () => api.listSessions().then((d) => d.sessions),
  })
}

export function useCreateSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: () => api.createSession(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  })
}

export function useDeleteSession() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (id: string) => api.deleteSession(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  })
}

export function useBatchDeleteSessions() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: (ids: string[]) => api.batchDeleteSessions(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['sessions'] }),
  })
}
