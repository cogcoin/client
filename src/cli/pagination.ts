export interface ListPage {
  limit: number | null;
  returned: number;
  truncated: boolean;
  moreAvailable: boolean | null;
  totalKnown: number | null;
}

export function normalizeListPage<T>(items: readonly T[], options: {
  limit: number | null;
  all: boolean;
  defaultLimit: number;
}): { items: T[]; page: ListPage } {
  const totalKnown = items.length;
  const appliedLimit = options.all ? null : (options.limit ?? options.defaultLimit);
  const pagedItems = appliedLimit === null ? [...items] : items.slice(0, appliedLimit);
  const truncated = appliedLimit !== null && totalKnown > appliedLimit;

  return {
    items: pagedItems,
    page: {
      limit: appliedLimit,
      returned: pagedItems.length,
      truncated,
      moreAvailable: truncated,
      totalKnown,
    },
  };
}
