"use client";

import { useEffect, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/navigation';
import { qk } from '@/lib/query-keys';
import { api } from '@/lib/api-client';
import { useRequireAuth } from '@/lib/use-auth';
import type { Watchlist } from '@/types/api';

/** Groww shows watchlists as tabs on one screen, so this index only exists to
 * land on the first list — or to create one when the account has none. */
export default function WatchlistsIndex() {
  const { ready, isAuthenticated } = useRequireAuth();
  const router = useRouter();
  const queryClient = useQueryClient();
  const [name, setName] = useState('My Watchlist');
  const [creating, setCreating] = useState(false);

  const { data, isLoading } = useQuery<Watchlist[]>({
    queryKey: qk.watchlists,
    queryFn: () => api.get('/api/watchlists'),
    enabled: isAuthenticated,
  });

  useEffect(() => {
    if (data && data.length > 0) router.replace(`/watchlists/${data[0].id}`);
  }, [data, router]);

  async function create(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return;
    setCreating(true);
    try {
      const created = await api.post('/api/watchlists', { name: name.trim() });
      queryClient.invalidateQueries({ queryKey: qk.watchlists });
      router.replace(`/watchlists/${created.id}`);
    } finally {
      setCreating(false);
    }
  }

  if (!ready || !isAuthenticated || isLoading || (data && data.length > 0)) {
    return <div className="min-h-screen flex items-center justify-center text-ink-3 text-sm">Loading…</div>;
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4">
      <form onSubmit={create} className="w-full max-w-sm space-y-4 text-center">
        <h1 className="text-[18px] font-semibold text-ink">Create your first watchlist</h1>
        <input
          value={name}
          onChange={e => setName(e.target.value)}
          className="w-full rounded-lg bg-surface-2 px-3 py-2.5 text-[14px] text-ink focus:outline-none focus:ring-2 focus:ring-primary/40"
        />
        <button type="submit" disabled={creating || !name.trim()} className="w-full rounded-lg bg-primary text-[#04241d] text-[14px] font-semibold py-2.5 disabled:opacity-50">
          {creating ? 'Creating…' : 'Create'}
        </button>
      </form>
    </div>
  );
}
