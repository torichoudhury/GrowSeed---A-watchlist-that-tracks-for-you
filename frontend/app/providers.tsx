"use client";

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useState } from 'react';

export default function Providers({ children }: { children: React.ReactNode }) {
  const [queryClient] = useState(() => new QueryClient());

  // No React Query devtools mount: its floating button sat over the UI in the
  // corner and read as part of the product.
  return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
}
