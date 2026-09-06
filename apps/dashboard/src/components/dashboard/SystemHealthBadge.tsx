'use client';

import { useQuery } from '@tanstack/react-query';
import type { MetricsResponse } from '@/lib/types';

export function SystemHealthBadge() {
  const { data, isLoading } = useQuery<MetricsResponse>({
    queryKey: ['metrics'],
    queryFn: async () => {
      const res = await fetch('/api/metrics');
      if (!res.ok) {
        throw new Error(`Failed to fetch metrics: ${res.status}`);
      }
      return res.json();
    },
    refetchInterval: 10000,
  });

  if (isLoading) {
    return (
      <div
        data-testid="system-health-badge"
        className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-neutral-100 text-neutral-600 animate-pulse border border-neutral-200"
      >
        <span className="w-2 h-2 rounded-full bg-neutral-400" />
        <span>Checking...</span>
      </div>
    );
  }

  const isHealthy = data?.systemStatus === 'healthy';

  return (
    <div
      data-testid="system-health-badge"
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium transition-colors ${
        isHealthy
          ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
          : 'bg-amber-50 text-amber-700 border border-amber-200'
      }`}
    >
      <span
        className={`w-2 h-2 rounded-full ${
          isHealthy ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'
        }`}
      />
      <span>{isHealthy ? 'Healthy' : 'Degraded'}</span>
    </div>
  );
}
