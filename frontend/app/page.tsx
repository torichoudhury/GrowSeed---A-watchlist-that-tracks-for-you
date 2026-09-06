"use client";

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/lib/use-auth';

export default function Home() {
  const router = useRouter();
  const { ready, isAuthenticated } = useAuth();

  useEffect(() => {
    if (!ready) return;
    router.replace(isAuthenticated ? '/watchlists' : '/login');
  }, [ready, isAuthenticated, router]);

  return <div className="min-h-screen flex items-center justify-center text-neutral-400 text-sm">Loading…</div>;
}
