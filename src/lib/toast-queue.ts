export type ToastQueueItem = { id: number };

export function enqueueToast<T extends ToastQueueItem>(queue: T[], item: T) {
  return [...queue, item];
}

export function dismissToast<T extends ToastQueueItem>(queue: T[], id: number) {
  return queue.filter((item) => item.id !== id);
}
