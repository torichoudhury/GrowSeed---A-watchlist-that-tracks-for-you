export const qk = {
  watchlists:   ['watchlists'] as const,
  // The horizon is part of the key: it changes what the server measures, not
  // just what the client shows, so two horizons are two different results.
  summary:      (id: string, horizon: string = 'AUTO') => ['watchlist', id, 'summary', horizon] as const,
  quote:        (iid: string) => ['market', 'quote', iid] as const,
  alerts:       (id: string) => ['watchlist', id, 'alerts'] as const,
  search:       (q: string) => ['instruments', 'search', q] as const,
  // Stock intelligence + chart
  intelligence: (iid: string, horizon: string = 'AUTO') => ['stock', iid, 'intelligence', horizon] as const,
  chart:        (iid: string, range: string) => ['stock', iid, 'chart', range] as const,
  // Explore
  explore:      (category: string) => ['explore', category] as const,
};
