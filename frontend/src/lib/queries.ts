import { healthSchema } from '@ops-console/shared';
import { useQuery } from '@tanstack/react-query';
import { z } from 'zod';
import { apiGet } from './api';
import { sessionToken } from './session';

export const queryKeys = {
  health: ['health'] as const,
};

export function useHealth() {
  return useQuery({
    queryKey: queryKeys.health,
    queryFn: () => apiGet('/health', z.object({ data: healthSchema })),
    enabled: sessionToken() !== null,
    retry: false,
  });
}
